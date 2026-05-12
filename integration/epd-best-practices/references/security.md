# Security — keys, environments, PCI scope

## API key types

| Prefix                       | Environment | Capability                                  |
|------------------------------|-------------|---------------------------------------------|
| `epd_live_sk_<32 hex>`       | Production  | Full read/write on the merchant's account   |
| `epd_test_sk_<32 hex>`       | Sandbox     | Full read/write on a sandbox account        |
| `epd_restricted_sk_live_...` | Production  | Subset of permissions defined per key       |
| `epd_restricted_sk_test_...` | Sandbox     | Subset of permissions defined per key       |

There is **no publishable / browser-safe key** in the EPD Commerce model. All
API authentication uses a server-side secret key. Browser-side card
collection goes through the EPD Commerce Gateway vault (see "Card
tokenization" below), which has its own credential model.

## Key handling — non-negotiables

1. **Server-side only.** Secret keys never reach a browser, never end up in a
   mobile app binary, never go to a CDN.
2. **Never commit to source control.** Check `.gitignore` excludes `.env`
   files. Run a secret scanner (gitleaks, trufflehog) in CI.
3. **Never log.** No request-tracing middleware that captures
   `Authorization` headers, no error-tracking that sends raw HTTP request
   metadata. Redact `Authorization` before any logger sees it.
4. **Inject from a secret store**, not a static config file. AWS Secrets
   Manager, GCP Secret Manager, Vault, Doppler, 1Password CLI — pick one.
5. **Use restricted keys for narrow workloads.** A read-only analytics job
   shouldn't carry a full `_sk_` key. Issue an `_restricted_sk_` with only
   the read scopes it needs.

## Rotation

Issue → deploy → revoke. **In that order.**

```
1. Issue a new key in the EPD Commerce dashboard.
2. Deploy the new key to all environments that consume it.
3. Verify traffic is flowing on the new key (dashboard usage view).
4. Revoke the old key.
```

Revoking before deploying causes downtime. Revoking too long after deploying
means the leaked key (if it was leaked) is still valid in the wild — keep the
window short.

For incident response (suspected key compromise), revoke first and accept the
downtime — paying for downtime is cheaper than paying for stolen funds.

## Sandbox vs live — environment guards

Mixing test and live keys is the most expensive class of bug. Two safeguards:

### 1. Env-var-driven environment selection

```ts
const env = process.env.EPD_ENV;  // "test" or "live"
const apiKey = env === "live" ? process.env.EPD_LIVE_KEY : process.env.EPD_TEST_KEY;

if (env === "live" && process.env.NODE_ENV !== "production") {
  throw new Error("Refusing to use live EPD Commerce key outside production");
}
```

### 2. Key-prefix runtime check

In your HTTP wrapper, refuse to start if the key prefix doesn't match the
expected environment:

```ts
const expectsLive = process.env.NODE_ENV === "production";
const isLive = apiKey.startsWith("epd_live_sk_") || apiKey.startsWith("epd_restricted_sk_live_");
if (expectsLive !== isLive) {
  throw new Error(`Key environment mismatch: NODE_ENV=${process.env.NODE_ENV}, key prefix=${apiKey.slice(0, 16)}...`);
}
```

This catches the "I exported the prod key into my dev shell" mistake at
process startup, not at first charge.

## Card tokenization & PCI scope

The EPD Commerce API never accepts a raw card number. Card data flows through
the **EPD Commerce Gateway vault**, which is the PCI-scoped layer. The flow:

```
Customer's browser
   │
   │  collects card → tokenizes via EPD Commerce Elements / hosted vault page
   ▼
EPD Commerce Gateway vault (PCI-DSS scope) ── returns numeric billing_id ──┐
                                                                           │
                                                                           ▼
Your backend ─── POST /v1/customers/{id}/payment_methods ───► EPD Commerce API
                  body: { "billing_id": "12345678" }
```

Your backend **only handles the `billing_id`** (a numeric string from the
vault). Your servers never see the PAN, CVV, or expiry. This keeps you in
**SAQ-A** PCI scope (the lightest tier) instead of full PCI-DSS.

Critical: the `billing_id` is **not** a card number. It's an opaque vault
reference. If a dev tries to pass a 16-digit string to `billing_id` thinking
"oh it's a card", the API rejects it (the vault hasn't seen it) — but more
importantly, your backend has just touched a PAN, which kicks you into full
PCI scope. Educate your team that anything looking like card data on your
servers is an incident, not a feature.

## Webhook secret handling

Webhook signing secrets use the prefix `whsec_<64 hex>`. Treat them with the
same care as API keys:

- Server-side only.
- Stored in a secret manager.
- One per webhook endpoint — don't share across endpoints.
- Rotate via the rotate flow (issue new → deploy → drain old grace period →
  revoke). The EPD Commerce webhook endpoint config supports a brief overlap window
  where both old and new secrets verify; use it during rotation.

See the `epd-webhooks` skill for verification implementation.

## Restricting key scope

When issuing a restricted key in the dashboard, narrow the scope to just what
the consumer needs:

| Workload                                  | Scopes                                       |
|-------------------------------------------|----------------------------------------------|
| Analytics dashboard                       | Read: customers, orders, transactions, subs  |
| Internal admin "view customer" tool       | Read: customers + payment_methods            |
| Refund desk                               | Read + write: orders (refund), transactions  |
| Public-facing checkout                    | Use a full sk + lock down by IP / network    |

A leaked restricted key has bounded blast radius. A leaked full secret key
can drain customer cards.

## Where to go next

- Sandbox card numbers and test scenarios → `testing.md`
- Errors when a key lacks scope → `errors.md` (`insufficient_permissions`)
- Webhook signing → `epd-webhooks` skill
