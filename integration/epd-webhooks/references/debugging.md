# Webhook debugging

When webhooks aren't working, the failure mode is one of three things:

1. **Signature mismatch** — your handler rejects a real EPD Commerce webhook.
2. **Delivery failure** — EPD Commerce can't reach your endpoint (DNS, TLS, 5xx, timeout).
3. **Event not firing** — you expected a webhook for an event that didn't happen.

Each has a different debugging path.

## Signature mismatch — the 90% case

Symptom: the EPD Commerce dashboard's delivery log shows your endpoint returned **401**
or **403** for every request.

Run through this checklist in order. Stop at the first match.

### 1. Are you reading the raw body?

Frameworks parse JSON before your handler sees the request, and re-serialized
JSON has different whitespace and key ordering. The signature won't match.

```js
// Wrong — Express auto-parsed JSON
app.use(express.json());
app.post('/webhooks/epd', (req, res) => {
  // req.body is now an object — re-serializing changes the bytes
  const raw = JSON.stringify(req.body);  // ❌ different from what EPD Commerce signed
});

// Right — raw body parser, mounted ONLY on the webhook route
app.post(
  '/webhooks/epd',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const raw = req.body.toString('utf8');  // ✅ exact bytes EPD Commerce signed
  },
);
```

In Python, use `await request.body()` (FastAPI) or `request.get_data()` (Flask)
— **not** `request.json()` or `request.form()`.

In PHP, use `file_get_contents('php://input')` or your framework's raw-body
accessor — **not** the parsed `$_POST` / `$request->all()` representation.

### 2. Are you stripping the `whsec_` prefix on the secret?

The EPD Commerce backend strips the prefix before HMAC. The verifier scripts in this
skill do the same automatically. If you wrote your own verifier:

```js
// Wrong
const sig = hmac(secret, payload);

// Right
const key = secret.startsWith('whsec_') ? secret.slice(6) : secret;
const sig = hmac(key, payload);
```

### 3. Is your server's clock correct?

The default 5-minute tolerance window assumes both your server and the EPD
Commerce delivery server agree on UTC. If your container's clock has drifted (common
in old Docker images without `tzdata` updates), valid signatures fail with
`timestamp_outside_tolerance`.

Check:

```bash
# Inside your container
date -u
# Compare to:
curl -sI https://api.epd.com | grep -i ^date:
```

If they differ by more than a minute, fix the clock — don't widen the
tolerance window. Wider tolerance defeats replay protection.

### 4. Are you using the right secret?

Each webhook endpoint has its own secret. If you have multiple endpoints
configured, verify against the one **for this specific endpoint**, not the
first one in your secret store.

The signature header doesn't tell you which endpoint sent the event — you
have to know based on the route.

### 5. Did the secret rotate?

If the dev rotated the secret in the dashboard but didn't deploy the new
secret to production, the verifier still has the old key. EPD Commerce supports a
brief overlap window during rotation, but only if you complete the rotation
flow correctly.

Confirm the secret in your secret store matches the one currently shown in
the dashboard for this endpoint.

## Delivery failure — EPD Commerce can't reach you

Symptom: the dashboard's delivery log shows **timeouts**, **DNS errors**, or
**TLS errors** — you never see the request at all.

### Check the dashboard delivery log

`GET /v1/webhook_endpoints/{id}/delivery_logs` (or `list_webhook_delivery_logs`
via MCP). The log entries include:

- HTTP status returned
- Response body (truncated)
- Latency
- Error reason if delivery failed before reaching the endpoint

Filter by `status: failed` to see only the broken deliveries.

### Replay specific events

Use `POST /v1/webhook_events/{id}/replay` (or `replay_webhook_event` via MCP)
to retrigger a delivery. Useful when:

- You fixed a bug and want to backfill the events you missed.
- You're testing a new endpoint with historical data.

Replays count as new delivery attempts in the log.

### Test endpoint reachability

```http
POST /v1/webhook_endpoints/{id}/test HTTP/1.1
```

(Or `test_webhook_endpoint` via MCP.) EPD Commerce sends a synthetic event to your
endpoint — useful to verify reachability without waiting for a real event.

## Event not firing — you expected a webhook that didn't arrive

Symptom: customer was charged but you never got a `transaction.succeeded`.

### Check your subscription list

```http
GET /v1/webhook_endpoints/{id}
```

The response includes `events: [...]`. If `transaction.succeeded` isn't in the
list, the endpoint won't receive it. Update the endpoint:

```http
PATCH /v1/webhook_endpoints/{id} HTTP/1.1
{
  "events": ["transaction.succeeded", "transaction.failed", ...]
}
```

### Check the underlying object actually changed

A webhook fires when an object reaches a state. If a charge is `pending` and
never settles, you won't get `transaction.succeeded` — because that hasn't
happened. Look at the order/transaction object directly to confirm the
state change you expected.

### Use `list_webhook_events`

`GET /v1/webhook_events?type=transaction.succeeded&created_at[gte]=...` shows
**all events** EPD Commerce generated for your account — separate from delivery
attempts. If the event isn't in this list, no webhook will fire (because
there's nothing to send). If it is, but no delivery log entry exists,
something dropped the event between the source and the delivery worker —
contact EPD Commerce support with the `event.id`.

## Version upgrades

Each webhook endpoint has its own pinned event schema version. To preview a
new version's payload before upgrading:

```http
POST /v1/webhook_endpoints/{id}/preview_payload HTTP/1.1
{
  "event_type": "order.succeeded",
  "version": "2026-08-15"
}
```

(Or `preview_webhook_payload` via MCP.) Returns what the payload **would**
look like at the requested version. Diff against your current version's
payload before upgrading to know what your handler needs to change.

To upgrade:

```http
POST /v1/webhook_endpoints/{id}/upgrade_version HTTP/1.1
{
  "version": "2026-08-15"
}
```

Downgrade is symmetric: `POST .../downgrade_version`.

To compare two versions before deciding:

```http
GET /v1/webhook_endpoints/versions/compare?from=2026-02-11&to=2026-08-15
```

Shows the diff in event schemas between the two versions.

## What to log on receive

For every webhook your handler processes:

- `event.id`
- `event.type`
- HMAC verification result (valid / reason)
- Time-to-respond (ms)
- Final HTTP status you returned

Don't log the full event body — events for `customer.updated` and similar
contain PII. Log structure, not contents.
