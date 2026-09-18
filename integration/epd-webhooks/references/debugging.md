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

A rotation (`POST /v1/webhook_endpoints/{id}/rotate_secret`) keeps both
secrets valid for a grace period — **24 hours** by default, 1–72 via
`grace_period_hours` on the REST call, always 24 through the MCP tool. The
response's `previous_secret_valid_until` is the deadline. Signatures that
start failing at that moment mean the new secret never reached production.
While the window is open, the receiver should hold both secrets and accept a
request if either verifies.

Two things break it sooner:

- **A second rotation inside the window.** It restarts the 24 hours from the
  new secret and drops the original immediately, so a receiver still on the
  original fails at once. Check `has_pending_rotation` on the endpoint before
  rotating again.
- **The wrong secret in the store.** The secret is returned only once, by the
  create or rotate call. There is nothing to compare against afterwards — if
  the stored value is in doubt, rotate once and deploy the new value within
  the window.

## Delivery failure — EPD Commerce can't reach you

Symptom: the dashboard's delivery log shows **timeouts**, **DNS errors**, or
**TLS errors** — you never see the request at all.

### Check the dashboard delivery log

`GET /v1/webhook_endpoints/{id}/delivery_logs` (or `list_webhook_delivery_logs`
via MCP). Each entry carries:

- `event_id` and `attempt` — which event, and which of its up to seven tries
- `http_status_code` — what your endpoint returned; null if it was never reached
- `response_time_ms`
- `error_message` — why delivery failed before or at your endpoint

The route takes `limit` and `starting_after` only. To see just the broken
deliveries, page through and keep the entries whose `http_status_code` is
null or outside 2xx.

### Replay specific events

```http
POST /v1/webhook_endpoints/{id}/events/{eventId}/replay HTTP/1.1
X-EPD-Idempotency-Key: <uuid v4>
Content-Type: application/json

{ "confirm": true }
```

(Or `replay_webhook_event` via MCP.) Events are addressed through their
endpoint; there is no account-wide event route. `confirm: true` is required,
and so is the idempotency header — the route returns
`missing_idempotency_key` without it. An optional `api_version` replays the
event at a different schema version. Useful when:

- You fixed a bug and want to backfill the events you missed.
- You're testing a new endpoint with historical data.

Replays count as new delivery attempts in the log, and your handler will see
an event it may already have processed — which is why it must dedupe on
`event.id`.

### Test endpoint reachability

```http
POST /v1/webhook_endpoints/{id}/test HTTP/1.1
Content-Type: application/json

{ "event_type": "order.succeeded" }
```

(Or `test_webhook_endpoint` via MCP.) EPD Commerce sends a synthetic event to
your endpoint — useful to verify reachability without waiting for a real
event. The body is optional; `event_type` defaults to `test.webhook`.

## Event not firing — you expected a webhook that didn't arrive

Symptom: customer was charged but you never got an `order.succeeded`.

### Check the endpoint's event list

```http
GET /v1/webhook_endpoints/{id}
```

The response includes `enabled_events: [...]`. If `order.succeeded` isn't
covered — by name, by `order.*`, or by `*` — the endpoint won't receive it.
Update the endpoint:

```http
PATCH /v1/webhook_endpoints/{id} HTTP/1.1
X-EPD-Idempotency-Key: <uuid v4>
Content-Type: application/json

{
  "enabled_events": ["order.succeeded", "order.failed", "order.refunded"]
}
```

There are no `transaction.*` event types. Charges surface as `order.*` events
and recurring charges as `subscription.charged`.

### Check the underlying object actually changed

A webhook fires when an object reaches a state. If an order is `pending` and
never settles, you won't get `order.succeeded` — because that hasn't
happened. Look at the order object directly to confirm the state change you
expected.

### List the events sent to the endpoint

`GET /v1/webhook_endpoints/{id}/events` (or `list_webhook_events` via MCP)
lists the events EPD generated **for this endpoint**, separately from the
delivery attempts. There is no account-wide `/v1/webhook_events` route — it
returns 404. If the event isn't in this list, no webhook will fire, because
there's nothing to send: check `enabled_events` above. If it is listed but has
no delivery log entry, something dropped it between generation and delivery —
contact EPD Commerce support with the `event.id`.

## Version upgrades

Each webhook endpoint has its own pinned event schema version (the
endpoint's `api_version`). Webhook schema versions are dated independently of
the API version — the sandbox currently lists one, `2026-02-10`, while the API
is `2026-02-11`. List what exists before choosing a target:

```http
GET /v1/webhook_versions HTTP/1.1
```

Each entry has `version`, `status` (`current`, `supported`, `deprecated`,
`sunset`), `is_latest` and a `changelog`. Below, `<target>` is a `version`
from that list.

To compare two versions before deciding:

```http
POST /v1/webhook_versions/compare HTTP/1.1
Content-Type: application/json

{
  "event_type": "order.succeeded",
  "from_version": "2026-02-10",
  "to_version": "<target>"
}
```

(Or `compare_webhook_versions` via MCP, same three fields.) Returns the
payload at each version so you can diff them. `from` / `to` are rejected.

To preview one version's payload:

```http
POST /v1/webhook_versions/preview HTTP/1.1
Content-Type: application/json

{
  "event_type": "order.succeeded",
  "api_version": "<target>"
}
```

(Or `preview_webhook_payload` via MCP, where the same field is called
`version`.) Neither call is scoped to an endpoint.

To upgrade:

```http
POST /v1/webhook_endpoints/{id}/upgrade_version HTTP/1.1
X-EPD-Idempotency-Key: <uuid v4>
Content-Type: application/json

{
  "api_version": "<target>",
  "confirm": true
}
```

Both body fields are required, and the route returns
`missing_idempotency_key` without the header. `version` is rejected — that is
the MCP tool's field name, not the REST one. Downgrade is symmetric:
`POST .../downgrade_version` with the same body.

## What to log on receive

For every webhook your handler processes:

- `event.id`
- `event.type`
- HMAC verification result (valid / reason)
- Time-to-respond (ms)
- Final HTTP status you returned

Don't log the full event body — events for `customer.updated` and similar
contain PII. Log structure, not contents.
