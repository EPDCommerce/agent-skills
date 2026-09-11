---
name: epd-webhook-ops
description: Use when an operator-agent connected to the EPD Commerce MCP server needs to run webhook endpoints on a live account - register one, rotate its signing secret, inspect why deliveries are failing, replay an event, or migrate schema versions. Triggers when the user says webhooks stopped arriving, asks to add or remove an endpoint, asks to rotate or roll a signing secret, asks to replay or resend an event, asks what changed between webhook versions, or asks to check delivery logs. Skip when the user is writing or debugging the receiving code - signature verification, raw body handling and HMAC belong to epd-webhooks. Skip when the question is why a payment failed - load epd-transaction-triage.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account with a full-access key.
metadata:
  version: 1.0.0
  api_version: "2026-02-11"
---

# Operating webhook endpoints

Sixteen tools covering the delivery side: which endpoints exist, what they are
subscribed to, whether deliveries are arriving, and how to rotate or migrate
without breaking a live consumer.

**This is the delivery side, not the receiving side.** Signature verification,
raw-body handling and HMAC belong to `epd-webhooks`. The split is: if the fix is
in the merchant's code, that skill; if the fix is on the account, this one.

## Tiers

Tiers come from
[`references/tiers.md`](../epd-mcp-operator/references/tiers.md), generated from
the `tools/list` snapshot by `npm run gen:tiers` so it cannot drift. What each
tier requires is defined once in
[SAFETY.md](https://github.com/EPDCommerce/agent-skills/blob/main/SAFETY.md).
Do not hand-maintain a tier list here.

The per-tool `idempotency_key` column lives in that same generated file. What is
local to this group is the proportion — eleven of the sixteen have **no
`idempotency_key` parameter at all**: the seven T0 reads, plus
`test_webhook_endpoint`, `replay_webhook_event`, `upgrade_webhook_version` and
`downgrade_webhook_version`. The two external ones matter most — see below.

## Routing

| If the task is | Load |
|---|---|
| Verifying a signature, raw body, HMAC, receiver code | `epd-webhooks` |
| Why a payment failed | `epd-transaction-triage` |
| Anything about money | its owning skill |

## The signing secret is shown exactly twice

Once at creation, once per rotation. It is **write-only afterwards** — measured:

| Call | `signing_secret` |
|---|---|
| `create_webhook_endpoint` | returned (`whsec_…`) |
| `get_webhook_endpoint` | **absent** |
| `rotate_webhook_secret` | returned as `new_signing_secret` |

There is no recovery path. If the secret is lost, the only option is another
rotation, which starts the migration clock again.

So when a secret comes back, **surface it to the human immediately and say it
will not be shown again.** This is the exception to the usual rule about not
echoing sensitive values — discarding it is the greater harm. Do not write it
into a summary that gets logged.

`setup_webhook_monitoring` has the same property: it creates a pre-scoped
endpoint and returns the secret once.

## Rotating a secret — there is a 24-hour overlap

`rotate_webhook_secret` does **not** cut over immediately. Measured response:

```json
{
  "id": "…",
  "new_signing_secret": "whsec_…",
  "previous_secret_valid_until": "2026-09-02T20:52:59.262Z",
  "message": "New signing secret generated. Previous secret valid until …"
}
```

The window is **24 hours**, and the endpoint reflects it:

```
has_pending_rotation: true
rotation_expires_at:  "2026-09-02T20:52:59.262Z"
```

Both secrets verify during the window. That is the whole point — deploy the new
secret to the consumer without dropping deliveries in between.

The procedure:

1. `rotate_webhook_secret`, capture `new_signing_secret` **and**
   `previous_secret_valid_until`
2. Give both to the human, with the deadline stated as a time, not a duration
3. They deploy the new secret to the receiver
4. Confirm with `list_webhook_delivery_logs` that deliveries are still landing
5. After the window, the old secret stops verifying on its own — nothing to do

### Do not rotate twice inside the window

A second rotation **is accepted** and it resets the window from that moment. The
secret that was "previous" is dropped, not extended:

```
rotate 1:  original -> previous (24h),  new = A
rotate 2:  A        -> previous (24h),  original is dead immediately
```

So a consumer still running the original — which is the normal state during a
migration — breaks the instant the second rotation lands. If someone asks to
"rotate again to be safe", that is the opposite of safe. Check
`has_pending_rotation` before rotating and say plainly that a rotation is
already in flight.

This is a T3 call. Echo the endpoint id and URL, and state that consumers have
24 hours, before asking for confirmation.

## Registering an endpoint

```
tool: create_webhook_endpoint
input:
  url: https://example.com/webhooks/epd
  enabled_events:
    - order.succeeded
    - order.failed
  description: production receiver
  idempotency_key: <UUID v4>
```

URL rules, both observed:

```
http://example.com/x   ->  validation_error, "URL must be a valid HTTPS endpoint."
"nonsense"             ->  invalid_format, "Invalid URL."
enabled_events: []     ->  value_too_small, "expected array to have >=1 items"
```

### Changing an endpoint

`update_webhook_endpoint` changes the URL, the subscribed events or the
description. Setting `disabled` stops deliveries but keeps the endpoint, so it
is the reversible alternative to `delete_webhook_endpoint`, which is T3 and
final. It also accepts `api_version`; make a version change through the
preview, compare and upgrade sequence below instead.

### Event names are not validated

This is the trap. `enabled_events: ["totally.made.up"]` is **accepted** and
stored verbatim. The endpoint is created, shows `status: "enabled"`, and
receives nothing.

There is no server-side check and no tool that lists valid event types, so a
typo produces an endpoint that looks healthy in `list_webhook_endpoints` and is
silently dead. `order.suceeded` will not error.

So: after `create_webhook_endpoint` or `update_webhook_endpoint`, confirm the
event names back to the human character by character, and check
`list_webhook_delivery_logs` once real traffic should have arrived. An empty
delivery log on a new endpoint is the symptom.

## Schema versions

Webhook versions are **a separate line from the API version**. This account runs
API `2026-02-11` and webhook schema `2026-02-10`. Do not assume one implies the
other.

`list_webhook_versions` returns each version with `status` (`current`,
deprecated, sunset), `is_latest`, `sunset_date`, and a structured `changelog`
naming added fields and the resources they belong to.

At the time of writing this account exposes **one** version, `2026-02-10`,
marked current. So migration cannot be rehearsed here — the procedure below is
written from the tool contracts and should be re-verified once a second version
exists.

### Preview and compare before upgrading, not after

Both are T0 and cost nothing:

```
preview_webhook_payload   event_type + version                     -> the exact payload shape
compare_webhook_versions  event_type + from_version + to_version   -> what changed
```

`preview_webhook_payload` returns `{ api_version, event_type, payload }` with a
fully formed sample event, so a consumer can be tested against the new shape
before anything is switched.

Then upgrade. Neither version tool takes an `idempotency_key`, but both are
annotated `idempotentHint: true`, so a repeat has no additional effect. On a
timeout, confirm with `get_webhook_endpoint` rather than assuming it was lost.

Guard rails the server enforces:

```
version that does not exist  ->  invalid_webhook_version, naming the value
downgrade to current/newer   ->  invalid_version_downgrade,
                                 "Target version must be older than current version."
```

The endpoint also carries `api_version_pinned_at`, `api_version_deprecated` and
`api_version_sunset`. A deprecated version with a sunset date is a scheduled
outage — surface the date rather than only the flag.

## Deliveries, events and replay

`list_webhook_events` and `list_webhook_delivery_logs` are both per-endpoint and
both T0. Start here when someone says webhooks stopped arriving — before
touching the endpoint, and certainly before rotating anything.

An empty delivery log distinguishes two very different problems:

- **empty** — nothing was ever sent. Wrong event names, or no matching activity.
- **entries with failures** — sending is happening and the receiver is rejecting
  or unreachable. That is often `epd-webhooks` territory.

### `test_webhook_endpoint` and `replay_webhook_event` hit a real URL

Both are `openWorldHint`, neither takes an idempotency key, and both send actual
HTTP to the customer's endpoint. A repeat is a genuine second delivery, not a
deduplicated no-op.

So: confirm the URL in this exchange before firing, and never retry either on a
timeout. Replaying an event a consumer already processed can double-apply
whatever it does — and the receiver's own idempotency is the merchant's code,
which you cannot see from here.

## What this skill will not do

- **Write or debug receiver code.** Signatures, raw body, HMAC — `epd-webhooks`.
- **Rotate a secret while a rotation is pending**, or rotate "again to be safe".
- **Discard a secret** returned by create or rotate. Surface it once, plainly.
- **Retry a version change, a test, or a replay on timeout.** None of them carry
  an idempotency key. Read the endpoint or the delivery log instead.
- **Trust an event name.** Nothing validates them; confirm and verify with the
  delivery log.
- **Delete an endpoint to fix delivery failures.** `delete_webhook_endpoint` is
  T3 and loses the delivery history that would have explained the problem.
