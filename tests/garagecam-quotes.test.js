const test = require('node:test');
const assert = require('node:assert/strict');

const garageCamQuotes = require('../src/garagecam-quotes');

function createVideoFile(overrides) {
  return Object.assign({
    name: 'garage-door.mp4',
    type: 'video/mp4',
    size: 900000
  }, overrides);
}

test('buildLeadPayload enforces consent and captures immutable ISO timestamps', function () {
  const now = new Date('2026-06-29T08:27:36.587Z');
  const payload = garageCamQuotes.buildLeadPayload({
    contractorId: 'contractor_123',
    name: 'Taylor Customer',
    phone: '(555) 123-4567',
    zip: '90210',
    consentGranted: true,
    file: createVideoFile(),
    now
  });

  assert.equal(payload.contractor_id, 'contractor_123');
  assert.equal(payload.customer_phone_e164, '5551234567');
  assert.equal(payload.consent_granted, true);
  assert.equal(payload.consent_timestamp, '2026-06-29T08:27:36.587Z');
  assert.equal(payload.submission_timestamp, '2026-06-29T08:27:36.587Z');
});

test('buildLeadPayload rejects submissions without TCPA consent', function () {
  assert.throws(function () {
    garageCamQuotes.buildLeadPayload({
      contractorId: 'contractor_123',
      name: 'Taylor Customer',
      phone: '5551234567',
      zip: '90210',
      consentGranted: false,
      file: createVideoFile()
    });
  }, /TCPA consent is required/);
});

test('buildTwilioMmsMessage includes signed link and STOP language', function () {
  const message = garageCamQuotes.buildTwilioMmsMessage({
    customerName: 'Taylor Customer',
    customerPhone: '+15551234567',
    zipCode: '90210',
    signedViewUrl: 'https://signed.example.com/video',
    expiresAt: '2026-06-30T08:27:36.587Z'
  });

  assert.match(message, /https:\/\/signed\.example\.com\/video/);
  assert.match(message, /Reply STOP to opt out\./);
});

test('createInfrastructureConfig declares 24 hour signed URL policy', function () {
  const config = garageCamQuotes.createInfrastructureConfig();

  assert.equal(config.repository_mode, 'standalone');
  assert.equal(config.storage.signed_view_url_ttl_hours, 24);
  assert.deepEqual(config.router, [
    'Receive Payload',
    'Generate 24h Signed Link',
    'Construct Twilio MMS string with proper STOP opting-out instructions',
    'Execute Twilio API request'
  ]);
});

test('uploadWithProgressAndRetry retries interrupted uploads and resolves on success', async function () {
  const attempts = [];
  const progressUpdates = [];
  const scenarios = [
    { type: 'error' },
    { type: 'success', status: 200 }
  ];

  class FakeXMLHttpRequest {
    constructor() {
      this.upload = {};
      attempts.push(this);
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader() {}

    send() {
      const scenario = scenarios.shift();

      if (this.upload.onprogress) {
        this.upload.onprogress({
          lengthComputable: true,
          loaded: 50,
          total: 100
        });
      }

      setTimeout(() => {
        if (scenario.type === 'error') {
          this.onerror(new Error('network'));
          return;
        }

        this.status = scenario.status;
        this.onload();
      }, 0);
    }
  }

  const result = await garageCamQuotes.uploadWithProgressAndRetry({
    uploadUrl: 'https://signed-upload.example.com/object',
    file: createVideoFile(),
    maxRetries: 2,
    onProgress: function (percent, attempt) {
      progressUpdates.push({ percent, attempt });
    },
    XMLHttpRequestCtor: FakeXMLHttpRequest
  });

  assert.equal(result.attempts, 2);
  assert.equal(attempts.length, 2);
  assert.deepEqual(progressUpdates[0], { percent: 50, attempt: 1 });
  assert.deepEqual(progressUpdates.at(-1), { percent: 100, attempt: 2 });
});

test('submitGarageCamLead posts presign and finalize payloads with contractor routing', async function () {
  const requests = [];

  async function fetchImpl(url, options) {
    requests.push({
      url,
      options: {
        method: options.method,
        headers: options.headers,
        body: JSON.parse(options.body)
      }
    });

    if (url.endsWith('/api/widget/leads/presign')) {
      return {
        ok: true,
        json: async function () {
          return {
            upload_url: 'https://signed-upload.example.com/object',
            object_key: 'contractor_123/lead_999/video.mp4',
            storage_provider: 's3',
            signed_view_url: 'https://signed-view.example.com/object',
            expires_at: '2026-06-30T08:27:36.587Z'
          };
        }
      };
    }

    return {
      ok: true,
      json: async function () {
        return {
          lead_id: 'lead_999'
        };
      }
    };
  }

  class FakeXMLHttpRequest {
    constructor() {
      this.upload = {};
    }

    open() {}

    setRequestHeader() {}

    send() {
      if (this.upload.onprogress) {
        this.upload.onprogress({
          lengthComputable: true,
          loaded: 100,
          total: 100
        });
      }

      setTimeout(() => {
        this.status = 200;
        this.onload();
      }, 0);
    }
  }

  const result = await garageCamQuotes.submitGarageCamLead({
    apiBaseUrl: 'https://api.example.com',
    contractorId: 'contractor_123',
    name: 'Taylor Customer',
    phone: '+15551234567',
    zip: '90210',
    consentGranted: true,
    file: createVideoFile(),
    now: new Date('2026-06-29T08:27:36.587Z'),
    fetchImpl,
    XMLHttpRequestCtor: FakeXMLHttpRequest
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.example.com/api/widget/leads/presign');
  assert.equal(requests[0].options.headers['X-Contractor-Id'], 'contractor_123');
  assert.equal(requests[0].options.body.consent_timestamp, '2026-06-29T08:27:36.587Z');
  assert.equal(requests[1].url, 'https://api.example.com/api/widget/leads');
  assert.equal(requests[1].options.body.contractor_id, 'contractor_123');
  assert.equal(requests[1].options.body.expiration_datetime, '2026-06-30T08:27:36.587Z');
  assert.equal(result.leadId, 'lead_999');
  assert.match(result.messageBody, /signed-view\.example\.com/);
});
