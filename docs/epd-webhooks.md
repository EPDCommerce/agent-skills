---
skill: epd-webhooks
surface: integration
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-webhooks — guide

**Skill:** [`integration/epd-webhooks/SKILL.md`](../integration/epd-webhooks/SKILL.md) ·
**Verifiers:** [`scripts/`](../integration/epd-webhooks/scripts/) ·
**Debugging:** [`references/debugging.md`](../integration/epd-webhooks/references/debugging.md)

Writing and debugging the receiver that accepts EPD's webhooks: signature
verification, raw-body handling, replay protection, delivery debugging. The
account-side counterpart — registering endpoints, rotating secrets, replaying
events — is [`epd-webhook-ops`](./epd-webhook-ops.md).

## What it does

### The signature contract

```
EPD-Signature: t=1715184000,v1=4d3c9b2a8f7e6d5c…
```

What is signed is the literal string `<timestamp>.<raw_request_body>` — no JSON
canonicalization, no whitespace normalization:

```
signature = HEX( HMAC-SHA256( secret, f"{timestamp}.{raw_body}" ) )
```

Replay protection is a 5-minute tolerance between the signed timestamp and
verification time.

### Three tested verifier scripts

[`verify_node.js`](../integration/epd-webhooks/scripts/verify_node.js),
[`verify_python.py`](../integration/epd-webhooks/scripts/verify_python.py),
[`verify_php.php`](../integration/epd-webhooks/scripts/verify_php.php) — zero
dependencies each, and each runs its own self-test when executed directly. CI
runs all three on every push.

**They return a result object, never a boolean.**

| Language | Accepted | Rejected |
|---|---|---|
| Node | `{ valid: true }` | `{ valid: false, reason }` |
| Python | `VerifyResult(valid=True)` | `VerifyResult(valid=False, reason=…)` |
| PHP | `['valid' => true]` | `['valid' => false, 'reason' => …]` |

`reason` is one of `missing_signature_header`, `missing_secret`,
`malformed_signature_header`, `timestamp_outside_tolerance`,
`malformed_signature_hex`, `signature_mismatch`. Log it; do not return it to the
caller.

**Test `valid`, never the result itself.** An object, a dataclass instance and a
non-empty array are all truthy, so `if (!verifyWebhook(...))` is never true and
a forged request sails through. This was a real defect in this skill's own
framework examples — all three of them — found on 1 September 2026 and fixed in
Phase D. The examples now read `valid`, the skill states the return contract,
and `scripts/__tests__/webhook-verifier.test.js` fails the build if an example
regresses. That test exists because the prose alone did not prevent it the first
time.

### Raw body before JSON parsing

Most frameworks parse JSON before the handler sees the request, and after
parsing the byte sequence is gone — re-serialized JSON has different whitespace
and key ordering, and the signature will not match. The skill gives the mount
pattern for Express, FastAPI and Laravel, with the framework-specific trap in
each:

- **Express** — mount `express.raw({ type: 'application/json' })` on the webhook
  route only, before any JSON parser.
- **FastAPI** — `await request.body()`, never `request.json()`.
- **Laravel** — `$request->getContent()`, and put the route in `routes/api.php`;
  in `routes/web.php`, `VerifyCsrfToken` rejects EPD's POST before the handler
  runs unless the path is excluded.

This is the single most common cause of "signatures don't match", and developers
lose hours to it before suspecting their own framework.

### Delivery-side facts the receiver has to be built around

**Retries are seven attempts**, backing off from immediate to 24 hours, before
the event is dead-lettered. Your handler will receive duplicates — from network
blips, brief 5xx, or a manual replay. Deduplicate on the event `id`, and write
the dedup row **in the same transaction** as the business logic, so a crash
mid-handler does not leave the row written and the work undone.

**The delivery timeout is 30 seconds.** Verify, persist to a durable queue,
return 200, process asynchronously. Persist-then-200 is safe; 200-then-process
silently drops events on failure.

**The field is `enabled_events`, not `events`** — the API rejects `events` with
"Property events should not exist". Patterns work (`order.*`, or `*`). There are
**no `transaction.*` events**: a payment arrives as `order.succeeded` or
`order.failed`.

**`signing_secret` is returned only on creation.** Not by a later read, list or
update. If it is lost, rotation is the only path — and rotation gives both
secrets a grace window (24 hours by default, `grace_period_hours` 1–72 on the
REST call), during which the receiver should accept either.

## When it fires

- EPD Commerce webhooks mentioned; *"how do I verify a webhook signature"*.
- An `EPD-Signature` header appears in a request.
- The env var `EPD_WEBHOOK_SECRET` is referenced.
- An HMAC library is imported to handle EPD events.

### What it must not answer

| Near miss | Goes to |
|---|---|
| Configuring webhooks via an MCP-connected agent | [`epd-webhook-ops`](./epd-webhook-ops.md) |
| A non-EPD webhook source | neither — see the caveat below |

> **A caveat worth knowing before you reuse the verifier.** EPD and Stripe
> signature headers have the same `t=…,v1=…` shape, but `verify_node.js` strips
> the `whsec_` prefix from the secret before signing and Stripe does not. Point
> EPD's verifier at a Stripe payload and it returns a confident
> `signature_mismatch` — a wrong answer that looks like a correct one. Only the
> skill's `description` excludes non-EPD sources; the scripts themselves say
> nothing. This is recorded as an open item rather than fixed.

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Verify against parsed JSON.** | Re-serialization changes bytes. The signature covers bytes. |
| **Use `==` for signature comparison.** | Leaks timing information. `crypto.timingSafeEqual`, `hmac.compare_digest`, `hash_equals`. |
| **Raise `tolerance_seconds` "to avoid clock issues".** | A one-hour tolerance defeats replay protection. NTP-sync the clocks and keep 300s. |
| **Trust the event ID for ordering.** | IDs are unique, not ordered. `evt_001` need not arrive before `evt_002`. If ordering matters, use `created_at` on the underlying object. |
| **Return 200 before the handler succeeds.** | No retry on genuine failures, and events are silently dropped. |
| **Log the full event body.** | It may contain PII. Log `event.id` and `event.type`. |
| **Test the verifier's return value for truthiness.** | The bug this skill shipped once. It is now a test, not just a warning. |
| **Register or rotate endpoints on the account.** | That is the other surface. |

## What to check afterwards

Reviewing a receiver:

- [ ] **The raw body reaches the verifier** — no JSON parser mounted before the
      webhook route.
- [ ] **The call site reads `valid`**, not the result object. This is the one to
      grep for by name.
- [ ] **Comparison is constant-time.**
- [ ] **Tolerance is 300 seconds.**
- [ ] **`reason` is logged, not returned** to the caller.
- [ ] **Deduplication is keyed on `event.id`**, and the dedup row is written in
      the same transaction as the business logic.
- [ ] **The handler returns 2xx well inside 30 seconds**, with heavy work queued.
- [ ] **The endpoint was created with `enabled_events`**, and the event names
      were verified against real deliveries — nothing validates them
      server-side.
- [ ] **The signing secret was captured at creation.** It is never returned
      again.
- [ ] During a rotation window, **both secrets are accepted**, and the old one
      is dropped after `previous_secret_valid_until`.

## A worked transcript

Illustrative. Header shapes, rejection reasons and the framework traps are as
the skill documents them; code is a sketch.

---

**Developer:** Our webhook handler rejects everything with signature mismatch.
The secret is definitely right — I pasted it twice.

**Agent:** "Definitely right" is usually true here and it is usually not the
problem. Two causes account for nearly all of these, and they look identical
from the outside. Can I see the route?

```js
const app = express();
app.use(express.json());

app.post('/webhooks/epd', (req, res) => {
  const result = verifyWebhook(
    JSON.stringify(req.body),
    req.get('EPD-Signature'),
    process.env.EPD_WEBHOOK_SECRET,
  );
  if (!result) return res.sendStatus(401);
  // ... handle event
  res.sendStatus(200);
});
```

**Agent:** Two bugs, and one of them is worse than the one you reported.

**The mismatch is the `express.json()` on line 2.** It parses the body before
your handler runs, and by then the original bytes are gone.
`JSON.stringify(req.body)` produces *a* JSON document with the same data and
different whitespace and key ordering. EPD signs the literal string
`<timestamp>.<raw_body>` — no canonicalization — so a re-serialized body cannot
match, no matter how correct the secret is.

Mount the raw parser on this route only, before any JSON parser:

```js
app.post(
  '/webhooks/epd',
  express.raw({ type: 'application/json' }),
  (req, res) => { /* req.body is a Buffer */ },
);
```

**Now the one you did not report.** `if (!result)` never fires. The verifier
returns a **result object**, not a boolean, and an object is always truthy — so
`!result` is always false and the 401 branch is unreachable.

Right now that is masked: everything fails the signature check, and everything
gets through anyway, and you are only seeing the mismatch because something
downstream is logging it. **Fix the raw body alone and you ship an endpoint that
accepts forged webhooks**, because the only thing stopping them today is that
the handler happens to be broken in a second way.

Read `valid`:

```js
const { valid, reason } = verifyWebhook(req.body, req.get('EPD-Signature'), secret);
if (!valid) {
  console.warn('rejected webhook:', reason);   // log the reason, don't return it
  return res.sendStatus(401);
}
const event = JSON.parse(req.body.toString('utf8'));
```

This exact bug shipped in this skill's own Express, FastAPI and Laravel examples
and was fixed in Phase D. There is now a test in the repository that fails the
build if an example regresses to truthiness, which is the only reason to believe
it will not come back — the warning in the prose had already been there.

Two things to add while you are in this handler:

**Deduplicate on `event.id`.** EPD retries seven times, from immediate out to 24
hours, plus any manual replay — you will see the same event more than once.
Write the dedup row in the same transaction as the business logic, or a crash
mid-handler leaves the row and skips the work.

**Return 200 fast.** The delivery timeout is 30 seconds. Verify, persist to a
queue, return, and let a worker do the rest.

**Developer:** Makes sense. How do I test the rejection path actually rejects?

**Agent:** Run the verifier script directly — each one self-tests and exits
non-zero on failure:

```bash
node integration/epd-webhooks/scripts/verify_node.js --self-test
```

Then flip a byte in a real payload and confirm your route returns 401 with
`signature_mismatch` in the log. The reason codes are worth asserting
individually: `timestamp_outside_tolerance` and `signature_mismatch` are very
different problems and both look like "it rejected" from the outside.

---

### What the transcript demonstrates

- **The reported bug was found, and a worse unreported one alongside it.**
- **The interaction between them was stated explicitly** — fixing one in
  isolation is what creates the vulnerability.
- **The repository's own history was cited as evidence**, including why a test
  exists where a warning had not been enough.
- **Two adjacent requirements were added** without being asked, both of which
  are needed before this handler is production-safe.
- **The verification step is runnable**, not a description of one.

## Where it hands off

| If the task is | Load |
|---|---|
| Registering, rotating, replaying or migrating endpoints on an account | [`epd-webhook-ops`](./epd-webhook-ops.md) |
| General REST integration | [`epd-best-practices`](./epd-best-practices.md) |
| Signatures mismatching despite correct-looking code, delivery-log inspection | [`references/debugging.md`](../integration/epd-webhooks/references/debugging.md) |
