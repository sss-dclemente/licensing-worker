# licensing-worker

> **Status: standalone reference project.** This was built to license
> dataverse-ops-mcp, which is now free and MIT-licensed with no paywall — so
> this worker no longer gates that product. It's kept as a self-contained
> example of a minimal license service on Cloudflare Workers + D1 (Paddle
> webhook signature verification, idempotent event handling, D1 schema/migrations,
> and vitest against the Workers pool). MIT-licensed; reuse it freely.

A minimal license validation service on Cloudflare Workers + D1. Issues license
keys on Paddle subscription events and answers "is this key valid?" over a small
HTTP API.

## Architecture

- Cloudflare Worker (raw `fetch` handler, tiny router, no framework) + D1.
- `POST /v1/validate` — key lookup, org binding, 1h cacheable responses.
- `POST /v1/webhooks/paddle` — HMAC-verified Paddle Billing webhook; issues
  keys on `subscription.created`, updates status on `updated`/`canceled`,
  idempotent via an append-only `events` log.
- Keys are emailed to the buyer via Resend (best-effort; never fails the webhook).
- Rate limiting is fixed-window, in-memory per isolate — best-effort by design.

## Endpoints

### `GET /v1/health`

```json
{ "ok": true, "ts": "2026-07-10T12:00:00.000Z" }
```

### `POST /v1/validate`

Request:

```json
{ "licenseKey": "dvops_abc...", "productId": "dvops", "orgId": "sha256-of-org-url" }
```

`orgId` is optional. The first validate that carries an `orgId` locks the
license to that org; a different `orgId` afterwards yields
`{ "valid": false, ..., "reason": "org_mismatch" }`.

Response (`200`, `Cache-Control: public, max-age=3600`):

```json
{ "valid": true, "tier": "pro", "expiresAt": "2027-01-01T00:00:00.000Z" }
```

Unknown keys are `200` with `{ "valid": false, "tier": null, "expiresAt": null }`
(cache-friendly negative). Malformed bodies are `400`. More than 60 requests
per minute per IP get `429` with a `Retry-After` header.

Example:

```sh
curl -s https://licensing-worker.<your-subdomain>.workers.dev/v1/validate \
  -H 'Content-Type: application/json' \
  -d '{"licenseKey":"dvops_yourkeyhere","productId":"dvops"}'
```

### `POST /v1/webhooks/paddle`

Paddle Billing webhook endpoint. Requires a valid
`Paddle-Signature: ts=<unix>;h1=<hex hmac-sha256 of "ts:body">` header signed
with `PADDLE_WEBHOOK_SECRET`; stale timestamps (> 5 min skew) and bad
signatures get `401`. Replayed `event_id`s return `200 { "replay": true }`
without side effects.

Handled events: `subscription.created` (issue + email key),
`subscription.updated` (update status/expiry; upserts if unseen),
`subscription.canceled` (mark canceled).

Tier/product come from the subscription's `custom_data`
(`{ "product_id": "dvops", "tier": "pro", "email": "buyer@example.com" }`),
with those defaults when absent.

## Setup & deploy (run manually)

```sh
npm install

# 1. Create the database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create licensing

# 2. Apply migrations (also available as: npm run migrate)
npx wrangler d1 migrations apply licensing --remote

# 3. Secrets
npx wrangler secret put PADDLE_WEBHOOK_SECRET   # from the Paddle notification settings
npx wrangler secret put RESEND_API_KEY

# 4. Deploy
npx wrangler deploy
```

### Paddle webhook configuration

In Paddle → Developer tools → Notifications, add a destination pointing at
`https://licensing-worker.<your-subdomain>.workers.dev/v1/webhooks/paddle`
and subscribe to `subscription.created`, `subscription.updated`, and
`subscription.canceled`. Copy the destination's secret key into the
`PADDLE_WEBHOOK_SECRET` secret.

## Development

```sh
npm run dev    # wrangler dev
npm test       # vitest (@cloudflare/vitest-pool-workers, runs in workerd)
npx tsc --noEmit
```
