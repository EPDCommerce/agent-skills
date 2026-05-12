---
name: epd-webhooks
description: Use when configuring, verifying, or debugging EPD Commerce webhook endpoints in a backend integration. Triggers when the user mentions EPD Commerce webhooks, asks how to verify a webhook signature, sees an EPD-Signature header in a request, references the env var EPD_WEBHOOK_SECRET, or imports an HMAC library to handle EPD Commerce events. Routes to language-specific verifier scripts (Node, Python, PHP) and a debugging reference for delivery logs and replay. Skip when the user is configuring webhooks via an MCP-connected agent (use workflow skills) or working with a non-EPD Commerce webhook source.
compatibility: Server-side, any backend with HMAC-SHA256 + access to the raw HTTP body before JSON parsing.
metadata:
  version: 1.0.0
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

Each script exports a single `verify_webhook` function that accepts:

- `payload` — raw request body as a string or bytes object
- `signature_header` — value of the `EPD-Signature` header
- `secret` — the endpoint's `whsec_...` secret
- `tolerance_seconds` — optional, default 300

Returns `True` / `false` (or throws on tampering, depending on language idiom).

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
  "events": ["order.succeeded", "subscription.canceled", "transaction.refunded"],
  "description": "Production webhook for accounting reconciliation"
}
```

Response includes `secret: "whsec_<64 hex>"` — **save this immediately**, it
is shown only once on creation. If the dev loses it, they must rotate the
secret to get a new one.

## Critical: read the raw body BEFORE parsing JSON

Most web frameworks parse JSON before your handler sees the request. After
parsing, the byte sequence is gone — re-serialized JSON has different
whitespace and key ordering, and the signature won't match.

Pattern by framework:

### Express (Node)

```js
import express from 'express';

const app = express();

// Mount the raw parser ONLY on the webhook route, before any json parser.
app.post(
  '/webhooks/epd',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const valid = verifyWebhook(
      req.body.toString('utf8'),
      req.get('EPD-Signature'),
      process.env.EPD_WEBHOOK_SECRET,
    );
    if (!valid) return res.sendStatus(401);
    const event = JSON.parse(req.body.toString('utf8'));
    // ... handle event
    res.sendStatus(200);
  },
);
```

### FastAPI (Python)

```python
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()

@app.post("/webhooks/epd")
async def epd_webhook(request: Request):
    raw = await request.body()  # bytes — DO NOT use request.json()
    signature = request.headers.get("epd-signature", "")
    if not verify_webhook(raw, signature, os.environ["EPD_WEBHOOK_SECRET"]):
        raise HTTPException(401)
    event = json.loads(raw)
    # ... handle event
    return {"received": True}
```

### Laravel (PHP)

```php
// In routes/web.php — add the middleware that preserves raw body:
Route::post('/webhooks/epd', function (Request $request) {
    $raw = $request->getContent();   // raw body, not $request->all()
    $signature = $request->header('EPD-Signature', '');

    if (!verify_webhook($raw, $signature, env('EPD_WEBHOOK_SECRET'))) {
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

EPD Commerce retries webhook delivery on non-2xx responses. Your handler **will**
receive the same event more than once eventually:

- Network blips during initial delivery
- Your endpoint returning 5xx briefly
- Manual replay from the dashboard or `replay_webhook_event` MCP tool

Every event has an `id` (e.g. `evt_<uuid>`). Make your handler idempotent on
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

## When to load the debugging reference

Switch to [`references/debugging.md`](./references/debugging.md) when:

- Signatures are mismatching despite the code looking right
- You need to inspect the EPD Commerce dashboard's delivery log for failed events
- You're upgrading a webhook endpoint to a newer event schema version
- You need to manually replay an event for testing
