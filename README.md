# GarageCam Quotes

Standalone repository for the GarageCam Quotes multi-tenant embeddable widget.

## Frontend embed snippet

Paste the built script into a website footer and configure it with tenant-specific data attributes:

```html
<script
  src="https://cdn.example.com/garagecam-quotes.js"
  data-contractor-id="contractor_123"
  data-api-base-url="https://api.example.com"
  data-brand-name="GarageCam Quotes"
></script>
```

The script renders:

- a floating mobile-friendly `Get Instant Video Quote` button
- an iOS/Android optimized modal
- native camera capture via `accept="video/*" capture="environment"`
- a mandatory unchecked TCPA/A2P 10DLC consent checkbox
- a disabled submit button until consent is granted
- upload progress, retry messaging, and offline-aware error handling

## API flow

The browser flow is intentionally split into:

1. `POST /api/widget/leads/presign` to request a private upload target
2. `PUT` the recorded video to the signed upload URL with retry support
3. `POST /api/widget/leads` to finalize the lead with immutable consent audit data

No public file paths are required on the client. The contractor receives a 24-hour signed viewing link generated server-side.

## CORS baseline

Serve the API with an allowlist-based CORS policy:

- `Access-Control-Allow-Origin`: explicit contractor website origins only
- `Access-Control-Allow-Methods`: `POST, PUT, OPTIONS`
- `Access-Control-Allow-Headers`: `Content-Type, X-Contractor-Id, X-Widget-Version`
- `Access-Control-Max-Age`: `600`
- `Vary`: `Origin`

Recommended CSP for the host page:

- `script-src 'self' https://cdn.example.com`
- `connect-src 'self' https://api.example.com https://s3.amazonaws.com`
- `media-src 'self' blob:`
- `frame-ancestors 'self'`

## Repository layout

- `/src/garagecam-quotes.js` — production-ready standalone embed script and API hooks
- `/config/infrastructure.json` — multi-tenant database and API orchestration design
- `/tests/garagecam-quotes.test.js` — focused validation for consent, payloads, retry logic, and Twilio routing content

## Validation

```bash
npm run lint
npm test
npm run build
```

## License

MIT
