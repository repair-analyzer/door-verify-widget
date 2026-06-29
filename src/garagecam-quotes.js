(function bootstrapGarageCamQuotes(globalObject, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  globalObject.GarageCamQuotes = api;

  if (typeof document !== 'undefined') {
    api.autoInitialize(document.currentScript);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createGarageCamQuotesApi() {
  const WIDGET_VERSION = '1.0.0';
  const DEFAULT_RETRY_COUNT = 2;
  const DEFAULT_BRAND_NAME = 'GarageCam Quotes';
  const CONSENT_LABEL = 'I agree to receive SMS updates about my garage door quote request. Consent is not a condition of purchase. Message and data rates may apply.';
  const CORS_POLICY = {
    allowMethods: ['POST', 'PUT', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Contractor-Id', 'X-Widget-Version'],
    maxAgeSeconds: 600
  };

  function trimValue(value) {
    return String(value || '').trim();
  }

  function normalizePhone(phone) {
    return trimValue(phone).replace(/[^\d+]/g, '');
  }

  function validateLeadInput(input) {
    const errors = [];
    const name = trimValue(input.name);
    const phone = normalizePhone(input.phone);
    const zip = trimValue(input.zip);
    const contractorId = trimValue(input.contractorId);
    const file = input.file;

    if (!contractorId) {
      errors.push('A contractor_id is required for tenant routing.');
    }

    if (name.length < 2) {
      errors.push('Please enter your full name.');
    }

    if (!/^\+?\d{10,15}$/.test(phone)) {
      errors.push('Please enter a valid mobile phone number.');
    }

    if (!/^\d{5}(?:-\d{4})?$/.test(zip)) {
      errors.push('Please enter a valid ZIP code.');
    }

    if (!input.consentGranted) {
      errors.push('TCPA consent is required before submitting.');
    }

    if (!file) {
      errors.push('Please record or upload a garage door video.');
    } else {
      if (!String(file.type || '').startsWith('video/')) {
        errors.push('Only video uploads are supported.');
      }

      const minimumDurationHintSeconds = 15;
      const minimumSizeBytes = 1024 * 256;

      if (typeof file.size === 'number' && file.size < minimumSizeBytes) {
        errors.push(`Please upload a clearer ${minimumDurationHintSeconds}-30 second video.`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      normalized: {
        contractorId,
        name,
        phone,
        zip
      }
    };
  }

  function buildConsentRecord(consentGranted, now) {
    if (!consentGranted) {
      throw new Error('Cannot build a consent record without an affirmative opt-in.');
    }

    const consentTimestamp = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();

    return {
      consent_granted: true,
      consent_timestamp: consentTimestamp,
      consent_language: CONSENT_LABEL
    };
  }

  function buildLeadPayload(input) {
    const validation = validateLeadInput(input);

    if (!validation.isValid) {
      throw new Error(validation.errors.join(' '));
    }

    const nowDate = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
    const submissionTimestamp = nowDate.toISOString();
    const consentRecord = buildConsentRecord(input.consentGranted, nowDate);

    return {
      contractor_id: validation.normalized.contractorId,
      customer_name: validation.normalized.name,
      customer_phone_e164: validation.normalized.phone,
      zip_code: validation.normalized.zip,
      submission_timestamp: submissionTimestamp,
      consent_granted: consentRecord.consent_granted,
      consent_timestamp: consentRecord.consent_timestamp,
      consent_language: consentRecord.consent_language,
      widget_version: WIDGET_VERSION,
      video: {
        file_name: trimValue(input.file.name || 'garage-door-video.mp4'),
        content_type: trimValue(input.file.type || 'video/mp4'),
        size_bytes: Number(input.file.size || 0)
      }
    };
  }

  function buildTwilioMmsMessage(options) {
    const customerName = trimValue(options.customerName);
    const phone = normalizePhone(options.customerPhone);
    const zipCode = trimValue(options.zipCode);
    const signedViewUrl = trimValue(options.signedViewUrl);
    const expiresAt = trimValue(options.expiresAt);

    return `New GarageCam Quotes lead from ${customerName} (${phone}, ZIP ${zipCode}). Video diagnostic: ${signedViewUrl}. Link expires ${expiresAt}. Reply STOP to opt out.`;
  }

  function createInfrastructureConfig() {
    return {
      widget_version: WIDGET_VERSION,
      repository_mode: 'standalone',
      cors: {
        allow_methods: CORS_POLICY.allowMethods.slice(),
        allow_headers: CORS_POLICY.allowHeaders.slice(),
        max_age_seconds: CORS_POLICY.maxAgeSeconds
      },
      router: [
        'Receive Payload',
        'Generate 24h Signed Link',
        'Construct Twilio MMS string with proper STOP opting-out instructions',
        'Execute Twilio API request'
      ],
      storage: {
        access_pattern: 'private_signed_urls_only',
        signed_view_url_ttl_hours: 24
      }
    };
  }

  async function parseJsonResponse(response) {
    const data = await response.json().catch(function onInvalidJson() {
      return {};
    });

    if (!response.ok) {
      throw new Error(data.error || 'The GarageCam Quotes API request failed.');
    }

    return data;
  }

  async function requestUploadSession(options) {
    const response = await options.fetchImpl(`${options.apiBaseUrl}/api/widget/leads/presign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Contractor-Id': options.payload.contractor_id,
        'X-Widget-Version': WIDGET_VERSION
      },
      body: JSON.stringify(options.payload)
    });

    return parseJsonResponse(response);
  }

  async function finalizeLeadSubmission(options) {
    const response = await options.fetchImpl(`${options.apiBaseUrl}/api/widget/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Contractor-Id': options.payload.contractor_id,
        'X-Widget-Version': WIDGET_VERSION
      },
      body: JSON.stringify(options.payload)
    });

    return parseJsonResponse(response);
  }

  function uploadWithProgressAndRetry(options) {
    const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_RETRY_COUNT;
    const XMLHttpRequestCtor = options.XMLHttpRequestCtor;

    return new Promise(function uploadPromise(resolve, reject) {
      let attempt = 0;

      function tryUpload() {
        attempt += 1;

        const xhr = new XMLHttpRequestCtor();
        xhr.open('PUT', options.uploadUrl, true);
        xhr.setRequestHeader('Content-Type', options.file.type || 'video/mp4');

        xhr.upload.onprogress = function onProgress(event) {
          if (event.lengthComputable && typeof options.onProgress === 'function') {
            const percent = Math.round((event.loaded / event.total) * 100);
            options.onProgress(percent, attempt);
          }
        };

        xhr.onload = function onLoad() {
          if (xhr.status >= 200 && xhr.status < 300) {
            if (typeof options.onProgress === 'function') {
              options.onProgress(100, attempt);
            }
            resolve({ attempts: attempt });
            return;
          }

          retryOrFail(new Error(`Upload failed with status ${xhr.status}.`));
        };

        xhr.onerror = function onError() {
          retryOrFail(new Error('Upload interrupted. Retrying on a stronger connection.'));
        };

        xhr.ontimeout = function onTimeout() {
          retryOrFail(new Error('Upload timed out. Retrying.'));
        };

        xhr.timeout = 60000;
        xhr.send(options.file);
      }

      function retryOrFail(error) {
        if (attempt <= maxRetries) {
          setTimeout(tryUpload, 250 * attempt);
          return;
        }

        reject(error);
      }

      tryUpload();
    });
  }

  async function submitGarageCamLead(options) {
    const payload = buildLeadPayload({
      contractorId: options.contractorId,
      name: options.name,
      phone: options.phone,
      zip: options.zip,
      consentGranted: options.consentGranted,
      file: options.file,
      now: options.now
    });
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const XMLHttpRequestCtor = options.XMLHttpRequestCtor || globalThis.XMLHttpRequest;

    if (typeof fetchImpl !== 'function') {
      throw new Error('window.fetch is required to submit GarageCam Quotes leads.');
    }

    if (typeof XMLHttpRequestCtor !== 'function') {
      throw new Error('XMLHttpRequest is required to upload GarageCam Quotes videos.');
    }

    const uploadSession = await requestUploadSession({
      apiBaseUrl: options.apiBaseUrl,
      payload,
      fetchImpl
    });

    await uploadWithProgressAndRetry({
      uploadUrl: uploadSession.upload_url,
      file: options.file,
      maxRetries: options.maxUploadRetries,
      onProgress: options.onProgress,
      XMLHttpRequestCtor
    });

    const finalizedPayload = {
      contractor_id: payload.contractor_id,
      customer_name: payload.customer_name,
      customer_phone_e164: payload.customer_phone_e164,
      zip_code: payload.zip_code,
      submission_timestamp: payload.submission_timestamp,
      consent_granted: payload.consent_granted,
      consent_timestamp: payload.consent_timestamp,
      consent_language: payload.consent_language,
      widget_version: payload.widget_version,
      expiration_datetime: uploadSession.expires_at,
      secure_video_url: null,
      video: {
        object_key: uploadSession.object_key,
        storage_provider: uploadSession.storage_provider || 's3',
        content_type: payload.video.content_type,
        file_name: payload.video.file_name,
        size_bytes: payload.video.size_bytes
      }
    };

    const finalizedLead = await finalizeLeadSubmission({
      apiBaseUrl: options.apiBaseUrl,
      payload: finalizedPayload,
      fetchImpl
    });

    return {
      leadId: finalizedLead.lead_id || null,
      contractorId: payload.contractor_id,
      expiresAt: uploadSession.expires_at,
      messageBody: buildTwilioMmsMessage({
        customerName: payload.customer_name,
        customerPhone: payload.customer_phone_e164,
        zipCode: payload.zip_code,
        signedViewUrl: uploadSession.signed_view_url || '[generated server-side]',
        expiresAt: uploadSession.expires_at
      })
    };
  }

  function createStyles() {
    return `
      .gcq-hidden { display: none !important; }
      .gcq-button {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483640;
        border: 0;
        border-radius: 999px;
        padding: 14px 18px;
        background: linear-gradient(135deg, #0057ff, #00a3ff);
        color: #ffffff;
        font: 600 15px/1.2 Arial, sans-serif;
        box-shadow: 0 16px 40px rgba(0, 45, 120, 0.28);
        cursor: pointer;
      }
      .gcq-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483641;
        background: rgba(7, 15, 33, 0.72);
        display: flex;
        align-items: flex-end;
        justify-content: center;
        padding: 16px;
      }
      .gcq-modal {
        width: min(100%, 480px);
        max-height: min(92vh, 820px);
        overflow: auto;
        border-radius: 24px 24px 18px 18px;
        background: #ffffff;
        padding: 24px 20px 20px;
        font: 400 15px/1.5 Arial, sans-serif;
        color: #172033;
        box-shadow: 0 24px 80px rgba(4, 18, 47, 0.3);
      }
      .gcq-modal h2 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      .gcq-subtitle {
        margin: 0 0 16px;
        color: #4d5b75;
      }
      .gcq-field {
        display: block;
        margin-bottom: 12px;
      }
      .gcq-label {
        display: block;
        margin-bottom: 6px;
        font-size: 13px;
        font-weight: 700;
      }
      .gcq-input,
      .gcq-file {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid #cdd6e3;
        border-radius: 12px;
        padding: 13px 14px;
        font: inherit;
      }
      .gcq-file {
        padding: 11px 14px;
        background: #f8fbff;
      }
      .gcq-consent {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        margin: 12px 0;
        font-size: 12px;
        color: #4d5b75;
      }
      .gcq-progress-wrap {
        height: 10px;
        border-radius: 999px;
        background: #e8edf5;
        overflow: hidden;
        margin: 12px 0 8px;
      }
      .gcq-progress-bar {
        width: 0;
        height: 100%;
        background: linear-gradient(135deg, #00a3ff, #00d084);
        transition: width 0.2s ease;
      }
      .gcq-status {
        min-height: 20px;
        margin: 8px 0 0;
        font-size: 13px;
      }
      .gcq-status[data-tone="error"] { color: #bb1f1f; }
      .gcq-status[data-tone="success"] { color: #146c2e; }
      .gcq-actions {
        display: flex;
        gap: 10px;
        margin-top: 16px;
      }
      .gcq-submit,
      .gcq-close {
        flex: 1;
        min-height: 48px;
        border-radius: 12px;
        border: 0;
        font: 700 15px/1 Arial, sans-serif;
        cursor: pointer;
      }
      .gcq-submit {
        background: #0057ff;
        color: #ffffff;
      }
      .gcq-submit:disabled {
        background: #adc4ff;
        cursor: not-allowed;
      }
      .gcq-close {
        background: #eef3fb;
        color: #172033;
      }
      @media (min-width: 700px) {
        .gcq-backdrop {
          align-items: center;
        }
        .gcq-modal {
          border-radius: 24px;
        }
      }
    `;
  }

  function setStatus(statusNode, message, tone) {
    statusNode.textContent = message || '';
    if (tone) {
      statusNode.setAttribute('data-tone', tone);
    } else {
      statusNode.removeAttribute('data-tone');
    }
  }

  function createWidgetMarkup(config) {
    const container = document.createElement('div');
    container.innerHTML = `
      <button type="button" class="gcq-button">Get Instant Video Quote</button>
      <div class="gcq-backdrop gcq-hidden" role="dialog" aria-modal="true" aria-label="GarageCam Quotes">
        <div class="gcq-modal">
          <h2></h2>
          <p class="gcq-subtitle">Send a 15-30 second video and get a fast garage door diagnostic quote.</p>
          <form novalidate>
            <label class="gcq-field">
              <span class="gcq-label">Full Name</span>
              <input class="gcq-input" name="name" autocomplete="name" required />
            </label>
            <label class="gcq-field">
              <span class="gcq-label">Cell Phone</span>
              <input class="gcq-input" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" required />
            </label>
            <label class="gcq-field">
              <span class="gcq-label">ZIP Code</span>
              <input class="gcq-input" name="zip" inputmode="numeric" pattern="\\d{5}(?:-\\d{4})?" autocomplete="postal-code" required />
            </label>
            <label class="gcq-field">
              <span class="gcq-label">Garage Door Video</span>
              <input class="gcq-file" name="video" type="file" accept="video/*" capture="environment" required />
            </label>
            <label class="gcq-consent">
              <input name="consent" type="checkbox" />
              <span>${CONSENT_LABEL}</span>
            </label>
            <div class="gcq-progress-wrap" aria-hidden="true">
              <div class="gcq-progress-bar"></div>
            </div>
            <div class="gcq-status" aria-live="polite"></div>
            <div class="gcq-actions">
              <button type="submit" class="gcq-submit" disabled>Send Video Quote</button>
              <button type="button" class="gcq-close">Close</button>
            </div>
          </form>
        </div>
      </div>
    `;

    const backdrop = container.querySelector('.gcq-backdrop');
    const title = container.querySelector('h2');

    backdrop.setAttribute('aria-label', config.brandName);
    title.textContent = config.brandName;

    return container;
  }

  function initializeWidget(config) {
    if (typeof document === 'undefined') {
      throw new Error('The GarageCam Quotes widget requires a browser environment.');
    }

    if (!trimValue(config.contractorId) || !trimValue(config.apiBaseUrl)) {
      throw new Error('Both contractorId and apiBaseUrl are required to initialize the widget.');
    }

    if (!document.getElementById('gcq-widget-styles')) {
      const style = document.createElement('style');
      style.id = 'gcq-widget-styles';
      style.textContent = createStyles();
      document.head.appendChild(style);
    }

    const widget = createWidgetMarkup({
      brandName: trimValue(config.brandName) || DEFAULT_BRAND_NAME
    });

    const button = widget.querySelector('.gcq-button');
    const backdrop = widget.querySelector('.gcq-backdrop');
    const closeButton = widget.querySelector('.gcq-close');
    const form = widget.querySelector('form');
    const submitButton = widget.querySelector('.gcq-submit');
    const consentCheckbox = form.elements.namedItem('consent');
    const videoField = form.elements.namedItem('video');
    const progressBar = widget.querySelector('.gcq-progress-bar');
    const statusNode = widget.querySelector('.gcq-status');

    function openModal() {
      backdrop.classList.remove('gcq-hidden');
      setStatus(statusNode, navigator.onLine ? '' : 'Weak or offline connection detected. Upload retry will start automatically when service returns.');
    }

    function closeModal() {
      backdrop.classList.add('gcq-hidden');
    }

    function updateSubmitState() {
      submitButton.disabled = !consentCheckbox.checked;
    }

    button.addEventListener('click', openModal);
    closeButton.addEventListener('click', closeModal);
    backdrop.addEventListener('click', function onBackdropClick(event) {
      if (event.target === backdrop) {
        closeModal();
      }
    });
    consentCheckbox.addEventListener('change', updateSubmitState);
    window.addEventListener('offline', function onOffline() {
      setStatus(statusNode, 'Weak or offline connection detected. We will retry the upload automatically.', 'error');
    });
    window.addEventListener('online', function onOnline() {
      setStatus(statusNode, 'Connection restored. You can continue your upload.', 'success');
    });

    form.addEventListener('submit', async function onSubmit(event) {
      event.preventDefault();

      const file = videoField.files && videoField.files[0];
      submitButton.disabled = true;
      progressBar.style.width = '0%';
      setStatus(statusNode, 'Preparing secure upload session...');

      try {
        const result = await submitGarageCamLead({
          apiBaseUrl: trimValue(config.apiBaseUrl).replace(/\/$/, ''),
          contractorId: config.contractorId,
          name: form.elements.namedItem('name').value,
          phone: form.elements.namedItem('phone').value,
          zip: form.elements.namedItem('zip').value,
          consentGranted: consentCheckbox.checked,
          file,
          maxUploadRetries: Number.isInteger(config.maxUploadRetries) ? config.maxUploadRetries : DEFAULT_RETRY_COUNT,
          onProgress: function onProgress(percent, attempt) {
            progressBar.style.width = `${percent}%`;
            const statusMessage = attempt > 1
              ? `Retrying upload on mobile connection (attempt ${attempt})... ${percent}%`
              : `Uploading secure video... ${percent}%`;
            setStatus(statusNode, statusMessage);
          }
        });

        progressBar.style.width = '100%';
        setStatus(statusNode, `Quote sent successfully. Contractor alert created for lead ${result.leadId || 'pending'}.`, 'success');
        form.reset();
        updateSubmitState();
      } catch (error) {
        progressBar.style.width = '0%';
        setStatus(statusNode, error.message || 'Something went wrong while sending your video quote.', 'error');
        updateSubmitState();
        return;
      }

      updateSubmitState();
    });

    document.body.appendChild(widget);
    updateSubmitState();

    return {
      destroy: function destroy() {
        widget.remove();
      }
    };
  }

  function autoInitialize(currentScript) {
    if (!currentScript || !currentScript.dataset) {
      return null;
    }

    if (currentScript.dataset.autoInit === 'false') {
      return null;
    }

    if (!currentScript.dataset.contractorId || !currentScript.dataset.apiBaseUrl) {
      return null;
    }

    return initializeWidget({
      contractorId: currentScript.dataset.contractorId,
      apiBaseUrl: currentScript.dataset.apiBaseUrl,
      brandName: currentScript.dataset.brandName || DEFAULT_BRAND_NAME,
      maxUploadRetries: Number(currentScript.dataset.maxUploadRetries || DEFAULT_RETRY_COUNT)
    });
  }

  return {
    WIDGET_VERSION,
    CONSENT_LABEL,
    CORS_POLICY,
    validateLeadInput,
    buildConsentRecord,
    buildLeadPayload,
    buildTwilioMmsMessage,
    createInfrastructureConfig,
    uploadWithProgressAndRetry,
    submitGarageCamLead,
    initializeWidget,
    autoInitialize
  };
});
