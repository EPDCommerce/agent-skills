---
name: epd-webhooks
description: Use when configuring, verifying, or debugging EPD Commerce webhook endpoints in a backend integration. Triggers when the user mentions EPD Commerce webhooks, asks how to verify a webhook signature, sees an EPD-Signature header in a request, references the env var EPD_WEBHOOK_SECRET, or imports an HMAC library to handle EPD Commerce events. Routes to language-specific verifier scripts (Node, Python, PHP) and a debugging reference for delivery logs and replay. Skip when the user is configuring webhooks via an MCP-connected agent — load epd-webhook-ops for that. Skip when working with a non-EPD Commerce webhook source.
compatibility: Server-side, any backend with HMAC-SHA256 + access to the raw HTTP body before JSON parsing.
metadata:
  version: 1.1.0
  api_version: "2026-02-11"
---

# EPD Commerce webhooks — setup, verification, debugging

EPD Commerce signs every outbound webhook with HMAC-SHA256 and a per-endpoint
secret. This skill encodes the signature scheme, gives you copy-paste verifier
code in Node/Python/PHP, and walks the delivery debugging flow.

## The signature contract

EPD Commerce sends each webhook with these headers:

```
EPD-Signature: t=1715184000,v1=4d3c9b2a8f7e6d5c4b3a29187f6e5d4c3b2a1908f7e6d5c4b3a29187f6e5d4c3b
Content-Type: application/json
User-Agent: EPD-Webhooks/1.0
```

Header value format: `t=<unix_seconds>,v1=<hex_sha256>`.

**What's signed:** the literal string `<timestamp>.<raw_request_body>` — no
JSON canonicalization, no whitespace tweaks. You must verify against the
**raw bytes** of the request body, before any JSON parsing.

```
signature = HEX( HMAC-SHA256( secret, f"{timestamp}.{raw_body}" ) )
```

**Replay protection:** EPD Commerce tolerates a 5-minute window between the signed
timestamp and your verification time. Older or future-dated requests are
rejected by the verifier.

## Verifier scripts

Three reference implementations live in `scripts/`:

- [`scripts/verify_node.js`](./scripts/verify_node.js) — Node.js, zero deps.
- [`scripts/verify_python.py`](./scripts/verify_python.py) — Python, stdlib only.
- [`scripts/verify_php.php`](./scripts/verify_php.php) — PHP, zero deps.

Each script exports one function — `verifyWebhook` in Node, `verify_webhook`
in Python and PHP (PHP namespace `Epd\Webhooks`) — that accepts:

- `payload` — raw request body as a string or bytes object
- `signature_header` — value of the `EPD-Signature` header
- `secret` — the endpoint's `whsec_...` secret
- `tolerance_seconds` — optional, default 300

It never throws. It returns a **result object**, not a boolean:

| Language | Accepted | Rejected |
|---|---|---|
| Node | `{ valid: true }` | `{ valid: false, reason }` |
| Python | `VerifyResult(valid=True)` | `VerifyResult(valid=False, reason=...)` |
| PHP | `['valid' => true]` | `['valid' => false, 'reason' => ...]` |

**Test `valid`, never the result itself.** An object, a dataclass instance and
a non-empty array are all truthy, so `if (!verifyWebhook(...))` is never true
and a forged request sails through. `reason` is one of
`missing_signature_header`, `missing_secret`, `malformed_signature_header`,
`timestamp_outside_tolerance`, `malformed_signature_hex` or
`signature_mismatch`. Log it; don't return it to the caller.

Run any script directly to execute its self-test; it exits non-zero if a case
fails.

Use the script that matches the dev's stack. If their stack is something
else (Go, Rust, Ruby, Java), generate equivalent code from the spec at the
top of this file — the algorithm is straightforward.

## Setting up an endpoint — REST

```http
POST /v1/webhook_endpoints HTTP/1.1
Authorization: Bearer epd_test_sk_...
EPD-Version: 2026-02-11
X-EPD-Idempotency-Key: <uuid v4>
Content-Type: application/json

{
  "url": "https://api.your-app.com/webhooks/epd",
  "enabled_events": ["order.succeeded", "order.refunded", "subscription.canceled"],
  "description": "Production webhook for accounting reconciliation"
}
```

The field is `enabled_events`, not `events` — the API rejects `events` with
"Property events should not exist". Patterns work too: `order.*`, or `*` for
everything. The URL must be HTTPS. Event types are the ones in the API
reference's "Supported Event Types" table (`order.*`, `subscription.*`,
`customer.*`, `coupon.*`); there are no `transaction.*` events — a payment
arrives as `order.succeeded` or `order.failed`.

The response includes `signing_secret: "whsec_..."` — **save it
immediately.** It is returned only on creation, never by a later read, list or
update. If it is lost, rotate: `POST /v1/webhook_endpoints/{id}/rotate_secret`
returns `new_signing_secret`, and both secrets stay valid for a grace period —
24 hours by default, `grace_period_hours` 1–72 on the REST call. During that
window, give the receiver both secrets and accept a request if either one
verifies; drop the old one once `previous_secret_valid_until` has passed.

## Critical: read the raw body BEFORE parsing JSON

Most web frameworks parse JSON before your handler sees the request. After
parsing, the byte sequence is gone — re-serialized JSON has different
whitespace and key ordering, and the signature won't match.

Pattern by framework:

### Express (Node)

```js
import express from 'express';
import { verifyWebhook } from './verify_node.js'; // scripts/verify_node.js

const app = express();

// Mount the raw parser ONLY on the webhook route, before any json parser.
app.post(
  '/webhooks/epd',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const { valid, reason } = verifyWebhook(
      req.body,
      req.get('EPD-Signature'),
      process.env.EPD_WEBHOOK_SECRET,
    );
    if (!valid) {
      console.warn('rejected webhook:', reason);
      return res.sendStatus(401);
    }
    const event = JSON.parse(req.body.toString('utf8'));
    // ... handle event
    res.sendStatus(200);
  },
);
```

`verify_node.js` is CommonJS; the named import works from an ES module because
Node exposes `module.exports` properties as named exports. From CommonJS, use
`const { verifyWebhook } = require('./verify_node.js')`.

### FastAPI (Python)

```python
import json
import logging
import os

from fastapi import FastAPI, Request, HTTPException

from verify_python import verify_webhook  # scripts/verify_python.py

app = FastAPI()

@app.post("/webhooks/epd")
async def epd_webhook(request: Request):
    raw = await request.body()  # bytes — DO NOT use request.json()
    signature = request.headers.get("epd-signature", "")
    result = verify_webhook(raw, signature, os.environ["EPD_WEBHOOK_SECRET"])
    if not result.valid:
        logging.warning("rejected webhook: %s", result.reason)
        raise HTTPException(401)
    event = json.loads(raw)
    # ... handle event
    return {"received": True}
```

### Laravel (PHP)

```php
// routes/api.php (served under /api) — the api group has no CSRF middleware.
// In routes/web.php, VerifyCsrfToken rejects EPD's POST before this runs
// unless the path is excluded from it.
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use function Epd\Webhooks\verify_webhook;

require_once base_path('scripts/verify_php.php'); // or autoload it via composer "files"

Route::post('/webhooks/epd', function (Request $request) {
    $raw = $request->getContent();   // raw body, not $request->all()
    $signature = $request->header('EPD-Signature', '');

    $result = verify_webhook($raw, $signature, (string) env('EPD_WEBHOOK_SECRET'));
    if (!$result['valid']) {
        Log::warning('rejected webhook', ['reason' => $result['reason']]);
        abort(401);
    }
    $event = json_decode($raw, true);
    // ... handle event
    return response('', 200);
});
```

Skipping the framework default JSON parser on the webhook route is the
single most important detail. Devs spend hours debugging "signatures don't
match" before realizing their framework re-serialized the body.

## Idempotency on receive — handle duplicates

EPD Commerce retries webhook delivery on non-2xx responses — seven attempts,
backing off from immediate to 24 hours, before the event is dead-lettered.
Your handler **will** receive the same event more than once eventually:

- Network blips during initial delivery
- Your endpoint returning 5xx briefly
- Manual replay from the dashboard, the REST replay route, or the
  `replay_webhook_event` MCP tool

Every event has an `id` (e.g. `evt_...`). Make your handler idempotent on
this ID:

```ts
async function handleEvent(event: { id: string; type: string; data: unknown }) {
  const seen = await db.webhookEvents.findUnique({ where: { id: event.id } });
  if (seen) return;  // already processed

  await db.$transaction(async (tx) => {
    await tx.webhookEvents.create({ data: { id: event.id, type: event.type, processedAt: new Date() } });
    // ... business logic for the event
  });
}
```

The DB row is the deduplication state. Insert it in the same transaction as
your business logic so a crash mid-handler doesn't leave you with the row
written but the work undone.

## Always respond fast

The EPD Commerce delivery timeout is **30 seconds** — return 2xx well before
that. If the work is heavy:

```
1. Verify signature.
2. Persist the raw event to a durable queue (Postgres, SQS, etc.).
3. Return 200.
4. A background worker pulls from the queue and runs business logic.
```

The handler's only job is to acknowledge receipt; downstream work runs
asynchronously. This pattern survives downstream outages — you can replay
your queue without asking EPD Commerce to redeliver.

## Common bugs to avoid

1. **Verifying against parsed JSON** instead of raw body. Always raw bytes.
2. **Using `==` for signature comparison**, leaking timing info. Always use
   constant-time comparison (`crypto.timingSafeEqual`, `hmac.compare_digest`,
   `hash_equals`).
3. **Setting `tolerance_seconds` too high** (e.g. 1 hour) "to avoid clock
   issues." That defeats replay protection. NTP-sync your clocks; keep
   tolerance at 300s.
4. **Trusting the event ID for ordering.** IDs are unique, not ordered.
   Don't rely on `evt_001` arriving before `evt_002`. If event ordering
   matters, look at `created_at` on the underlying object.
5. **Returning 200 before the handler succeeds.** Then there's no retry on
   genuine failures and you've silently dropped events. Persist-then-200 is
   safe; 200-then-process is not.
6. **Logging the full event body**. May contain PII. Log `event.id` and
   `event.type`, not the body.
7. **Testing the verifier's return value for truthiness.** The scripts return
   a result object, which is always truthy — `if (!verifyWebhook(...))` never
   rejects anything. Read `valid` (see "Verifier scripts" above). If you write
   your own verifier that returns a boolean, keep the call sites consistent
   with whichever shape you chose.

## When to load the debugging reference

Switch to [`references/debugging.md`](./references/debugging.md) when:

- Signatures are mismatching despite the code looking right
- You need to inspect the EPD Commerce dashboard's delivery log for failed events
- You're upgrading a webhook endpoint to a newer event schema version
- You need to manually replay an event for testing

For registering, rotating, replaying or migrating endpoints on a live account
through an MCP-connected agent rather than from your own code, load
`epd-webhook-ops`. It takes its confirmation tiers and idempotency rules from
`epd-mcp-operator`, so they are not repeated here.
