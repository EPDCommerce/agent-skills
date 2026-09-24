---
skill: epd-webhook-ops
surface: workflow
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-webhook-ops — guide

**Skill:** [`workflows/epd-webhook-ops/SKILL.md`](../workflows/epd-webhook-ops/SKILL.md) ·
**Policy:** [`SAFETY.md`](../SAFETY.md) ·
**Safety layer:** [`epd-mcp-operator`](./epd-mcp-operator.md)

Sixteen tools covering the delivery side of webhooks: which endpoints exist,
what they are subscribed to, whether deliveries are arriving, and how to rotate
or migrate without breaking a live consumer.

**This is the delivery side, not the receiving side.** The split is simple: if
the fix is in the merchant's code, it is [`epd-webhooks`](./epd-webhooks.md); if
the fix is on the account, it is here.

## What it does

### The signing secret is shown exactly twice

Once at creation, once per rotation. It is write-only afterwards — measured:

| Call | `signing_secret` |
|---|---|
| `create_webhook_endpoint` | returned (`whsec_…`) |
| `get_webhook_endpoint` | **absent** |
| `rotate_webhook_secret` | returned as `new_signing_secret` |

There is no recovery path. If it is lost, the only option is another rotation,
which restarts the migration clock.

So when a secret comes back, the skill surfaces it to the human immediately and
says it will not be shown again. **This is the one place the usual rule about
not echoing sensitive values is inverted** — discarding it is the greater
harm — and the skill still says not to write it into a summary that gets logged.
`setup_webhook_monitoring` has the same property.

### Rotation has a 24-hour overlap, and rotating twice destroys it

`rotate_webhook_secret` does not cut over immediately:

```json
{
  "id": "…",
  "new_signing_secret": "whsec_…",
  "previous_secret_valid_until": "2026-09-02T20:52:59.262Z",
  "message": "New signing secret generated. Previous secret valid until …"
}
```

The endpoint then shows `has_pending_rotation: true` and
`rotation_expires_at`. Both secrets verify during the window — that is the whole
point, so the new secret can be deployed without dropping deliveries.

A second rotation inside the window **is accepted**, and it resets the window
from that moment while dropping the secret that was "previous":

```
rotate 1:  original -> previous (24h),  new = A
rotate 2:  A        -> previous (24h),  original is dead immediately
```

A consumer still running the original — which is the normal state during a
migration — breaks the instant the second rotation lands. So "rotate again to be
safe" is the opposite of safe, and the skill checks `has_pending_rotation`
before rotating.

**Read that rule for what it actually says, though.** It bites when the consumer
is still on the original. Once the new secret is deployed, a second rotation
does something different: it makes the *deployed* secret "previous" — still
valid for 24 hours, so nothing breaks — and drops the original immediately.
That is a legitimate way to close a leak window early, at the cost of starting
another migration. Refusing it as "no security gain" would be wrong; the gain is
real and so is the cost. It is a risk decision for the human, and the agent's
job is to state both sides rather than to hide behind the rule.

### Event names are not validated

`enabled_events: ["totally.made.up"]` is **accepted** and stored verbatim. The
endpoint is created, shows `status: "enabled"`, and receives nothing. There is
no server-side check and no tool that lists valid event types, so `order.suceeded`
will not error — it will produce an endpoint that looks healthy in
`list_webhook_endpoints` and is silently dead.

The mitigation is procedural: confirm event names back character by character,
then check `list_webhook_delivery_logs` once real traffic should have arrived.
An empty delivery log on a new endpoint is the symptom.

### Diagnosis starts with the delivery log

`list_webhook_events` and `list_webhook_delivery_logs` are both per-endpoint and
both T0. An empty log distinguishes two very different problems:

- **empty** — nothing was ever sent. Wrong event names, or no matching activity.
- **entries with failures** — sending is happening and the receiver is rejecting
  or unreachable. That is usually [`epd-webhooks`](./epd-webhooks.md) territory.

### Versions are a separate line from the API version

This account runs API `2026-02-11` and webhook schema `2026-02-10`. One does not
imply the other. `preview_webhook_payload` and `compare_webhook_versions` are
both T0 and cost nothing, so the sequence is preview, compare, then upgrade —
not upgrade and find out.

The server enforces two guard rails: a version that does not exist returns
`invalid_webhook_version` naming the value, and a downgrade to the current or a
newer version returns `invalid_version_downgrade`.

> At the time of writing the account exposes **one** version, `2026-02-10`,
> marked current, so migration could not be rehearsed. The procedure in the
> skill is written from the tool contracts and is flagged for re-verification
> once a second version exists.

## When it fires

- Webhooks stopped arriving.
- Add or remove an endpoint; rotate or roll a signing secret.
- Replay or resend an event; check delivery logs.
- *"What changed between webhook versions?"*

### What it must not answer

| Near miss | Goes to |
|---|---|
| Signature verification, raw body, HMAC, receiver code | [`epd-webhooks`](./epd-webhooks.md) |
| Why a payment failed | [`epd-transaction-triage`](./epd-transaction-triage.md) |
| Anything about money | its owning skill |

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Write or debug receiver code.** | Different surface, different skill. An agent that starts editing the consumer while operating the account is doing two jobs badly. |
| **Rotate while a rotation is pending**, or rotate "again to be safe". | The second rotation kills the original secret immediately, which is the one the consumer is most likely still running. |
| **Discard a returned secret.** | It is shown twice in the object's whole life. Losing it costs another rotation and another 24-hour migration. |
| **Retry a version change, a test, or a replay on timeout.** | None of them carries an `idempotency_key`. Eleven of the sixteen tools in this group have no such parameter — the seven reads, plus `test_webhook_endpoint`, `replay_webhook_event`, `upgrade_webhook_version` and `downgrade_webhook_version`. Read the endpoint or the delivery log instead. |
| **Fire `test_webhook_endpoint` or `replay_webhook_event` at an unconfirmed URL.** | Both are `openWorldHint` and send real HTTP from EPD's infrastructure to a third party. A repeat is a genuine second delivery, and the receiver's own idempotency is the merchant's code, which is not visible from here — replaying an event a consumer already processed can double-apply whatever it does. |
| **Trust an event name.** | Nothing validates them. Confirm, then verify with the delivery log. |
| **Delete an endpoint to fix delivery failures.** | `delete_webhook_endpoint` is T3 and loses the delivery history that would have explained the problem. `update_webhook_endpoint` with `disabled` stops deliveries reversibly. |

## What to check afterwards

After creating an endpoint:

- [ ] **The event names were read back character by character.** A typo here is
      invisible for as long as nobody looks at the log.
- [ ] **The delivery log has entries** once traffic should have arrived. Empty
      means nothing was ever sent.
- [ ] **The signing secret was handed over once**, with a statement that it will
      not be shown again — and is not sitting in a summary that gets logged.

After a rotation:

- [ ] **Both the new secret and `previous_secret_valid_until` were given to the
      human**, with the deadline stated as a time, not a duration.
- [ ] **Deliveries are still landing** — `list_webhook_delivery_logs` during the
      window, not after it.
- [ ] Nothing rotated a second time. After the window the old secret stops
      verifying on its own; there is nothing to do.

After a version change:

- [ ] **Preview and compare ran before the upgrade**, not after.
- [ ] The endpoint's `api_version_deprecated` and `api_version_sunset` were
      checked. A deprecated version with a sunset date is a scheduled outage —
      surface the date, not just the flag.

## A worked transcript

Illustrative. Response shapes, the 24-hour window and the measured behaviours
are as the skill documents them; URLs and IDs are placeholders.

---

**Platform engineer:** We think our signing secret leaked in a log. Rotate it.

**Agent:** Two things before I can plan that. Secrets are per-endpoint, so
"our signing secret" is only unambiguous if there is one endpoint — and rotating
the wrong one breaks a working consumer while leaving the leak open. And I need
to know whether a rotation is already in flight.

```
tool: list_webhook_endpoints
input:
  limit: 20
```

```json
{
  "data": [
    { "id": "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f",
      "url": "https://api.acme.com/webhooks/epd", "status": "enabled" },
    { "id": "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
      "url": "https://staging.acme.com/webhooks/epd", "status": "enabled" }
  ]
}
```

Two endpoints, production and staging, each with its own secret. Which one
leaked?

**Platform engineer:** Production.

**Agent:**

```
tool: get_webhook_endpoint
input:
  id: c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f
```

```json
{
  "id": "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f",
  "url": "https://api.acme.com/webhooks/epd",
  "status": "enabled",
  "enabled_events": ["order.succeeded", "order.failed", "subscription.canceled"],
  "has_pending_rotation": false,
  "api_version": "2026-02-10"
}
```

No pending rotation, so this is clean. Note there is no `signing_secret` in that
response — it is write-only after creation, which is also why a leak means
rotation rather than "check what it was".

> I'm about to call **`rotate_webhook_secret`** on endpoint
> `c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f` → **https://api.acme.com/webhooks/epd**
> (production, not staging), in **LIVE** mode. The current secret keeps verifying
> for **24 hours**, then stops. Your receiver must accept both during that
> window. This is irreversible and the new secret is shown once. Proceed?

**Platform engineer:** Yes.

```
tool: rotate_webhook_secret
input:
  id: c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f
  idempotency_key: 7b1c4f3a-9e2d-4c8a-9b7d-9e3f8f9a4d2e
```

```json
{
  "id": "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f",
  "new_signing_secret": "whsec_2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e",
  "previous_secret_valid_until": "2026-09-24T14:12:07.441Z",
  "message": "New signing secret generated. Previous secret valid until 2026-09-24T14:12:07.441Z"
}
```

**Copy this now — it will not be shown again.** There is no read path for a
signing secret; if it is lost, the only recovery is another rotation and another
24-hour migration.

```
whsec_2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e
```

**Your deadline is 14:12:07 UTC on 24 September 2026** — a time, not "24
hours", because the clock started at the call and not when you read this.

Until then both secrets verify. So the deploy order is: accept either secret in
the receiver, ship that, then drop the old one after the deadline. You do not
need to do anything at the deadline itself — the old secret stops verifying on
its own.

**Platform engineer:** Deployed. Can you rotate once more so we're definitely
clear of the leaked one?

**Agent:** That would work, and it is a trade rather than a no. Let me be exact,
because the usual advice here is "never rotate twice" and that is not quite the
rule.

**The leaked secret is still live.** It became "previous" at rotation and keeps
verifying until 14:12 tomorrow. That is the overlap working as designed, and it
is also exactly what is worrying you.

**A second rotation would kill it now.** The secret you just deployed becomes
the new "previous" — still valid 24 hours, so your receiver keeps working — and
the original is dropped immediately. The rule against rotating twice exists for
consumers still running the original, who break the instant it lands. You have
deployed, so that case does not apply to you.

**The cost is another migration.** You would be back to a 24-hour clock and a
third secret to ship.

So it comes down to whether a leaked production secret being live for another 22
hours is a risk you want to carry. If the leak was in a log with broad reach,
close it now. If it was internal and another deploy is expensive, let the window
expire. That is your call, not mine.

Before you decide, let me confirm the secret you deployed is actually verifying —
that is the one thing genuinely unknown right now, and it is free:

```
tool: list_webhook_delivery_logs
input:
  id: c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f
  limit: 20
```

```json
{
  "data": [
    { "event_type": "order.succeeded", "response_status": 200,
      "delivered_at": "2026-09-23T14:16:41.882Z" },
    { "event_type": "order.succeeded", "response_status": 200,
      "delivered_at": "2026-09-23T14:15:09.104Z" }
  ],
  "has_more": true
}
```

Twenty deliveries, all `200`, the most recent four minutes ago — after your
deploy. **The secret you shipped is verifying.** So a second rotation is safe to
do; it is only a question of whether it is worth doing.

Say the word and I will put the plan up.

---

### What the transcript demonstrates

- **"Our signing secret" was disambiguated before anything rotated.** Secrets
  are per-endpoint; there were two endpoints. Rotating the wrong one breaks a
  working consumer and leaves the leak open.
- **`has_pending_rotation` was checked before planning**, not after.
- **The confirmation named the tool, the URL and which environment** — not just
  the ID. `rotate_webhook_secret` on production and on staging are the same call
  with very different consequences.
- **The secret was surfaced immediately and prominently**, with the reason it
  cannot be recovered, and **the deadline was given as a timestamp**, because
  the window started at the call rather than when the engineer reads it.
- **The second rotation was answered accurately instead of refused by reflex.**
  The blanket rule — never rotate twice inside the window — protects consumers
  still on the original. This consumer had deployed, so the rule did not apply,
  and a second rotation genuinely would close the leak early. Refusing it as
  "no security gain" would have been false, and hiding a real option behind a
  rule the agent had not checked applies is worse than saying no.
- **The risk decision went to the human**, with both costs named, rather than
  being made for them.

## Where it hands off

| If the task is | Load |
|---|---|
| Verifying signatures, raw body, HMAC, receiver code | [`epd-webhooks`](./epd-webhooks.md) |
| Why a payment failed | [`epd-transaction-triage`](./epd-transaction-triage.md) |
| Anything that moves money | its owning skill, via [`epd-mcp-operator`](./epd-mcp-operator.md) |
