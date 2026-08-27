# Security — keys, environments, PCI scope

## API key types

| Prefix                       | Environment | Capability                                  |
|------------------------------|-------------|---------------------------------------------|
| `epd_live_sk_<32 hex>`       | Production  | Full read/write on the merchant's account   |
| `epd_test_sk_<32 hex>`       | Sandbox     | Full read/write on a sandbox account        |
| `epd_restricted_sk_live_...` | Production  | Subset of permissions defined per key       |
| `epd_restricted_sk_test_...` | Sandbox     | Subset of permissions defined per key       |
| `epd_live_pk_...`            | Production  | **Publishable** — browser card capture only |
| `epd_test_pk_...`            | Sandbox     | **Publishable** — browser card capture only |

All REST API authentication — customers, orders, subscriptions, refunds,
webhooks, everything except capturing a card in the browser — uses a
server-side **secret** key (`_sk_`). The only browser-safe key is the
**publishable** key (`_pk_`), created separately in the dashboard under
Settings → Developer & Integrations → **Publishable Keys** (a different tab
from **API Keys**). A publishable key does exactly one thing: it initializes
the EPD Elements SDK to capture and tokenize a card. It cannot read, list,
charge, or move money, so it's safe to ship in client-side code. It is not a
substitute for a secret key — the `card_token` it produces still has to be
attached to a customer server-side, with a secret key. See "Card
tokenization" below for the full flow, including a server-to-server option
that needs no publishable key at all.

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

The EPD Commerce API never accepts a raw card number directly on
`POST /v1/customers/{id}/payment_methods`. There are two supported ways to
get a card into the vault today. The browser flow keeps your servers out of
the cardholder-data path entirely; the server-to-server flow does not need a
browser but does put a raw PAN through your backend for one call, which
carries a heavier PCI obligation (see its note below).

### 1. Browser capture — EPD Elements (`card_token`)

```
Customer's browser
   │
   │  epd.js (https://js.epd.com/element/v1/epd.js), initialized with a
   │  publishable key, captures the card and tokenizes it
   ▼
EPD card capture (PCI-scoped) ── returns single-use card_token (cct_...) ──┐
                                                                           │
                                                                           ▼
Your backend ─── POST /v1/customers/{id}/payment_methods ───► EPD Commerce API
                  body: { "card_token": "cct_..." }        (secret key)
```

The `card_token` (`cct_` followed by 48 hex characters) is single-use and
expires 15 minutes after capture. Your servers never see the PAN, CVV, or
expiry — only the token. This is the only card input the MCP payment tools
accept.

### 2. Server-to-server — `secure.epd.com` (headless, no browser)

For phone/MOTO orders, back-office entry, data migration, or an
agent/headless integration with no browser to run EPD Elements in, POST the
raw card directly to `https://secure.epd.com` using your **secret** key.
That endpoint is a PCI-scoped proxy — the card never reaches the main EPD
Commerce API — and it creates the payment method in the same call:

```json
POST https://secure.epd.com
Authorization: Bearer epd_test_sk_...

{
  "customer_id": "<existing customer id>",
  "card": { "number": "4111111111111111", "exp_month": "12", "exp_year": "2027", "cvc": "123" },
  "billing_details": { "...": "..." },
  "set_as_default": true
}
```

The response is the standard payment method object; its `id` is the
`payment_method_id` you pass to `create_order` / `create_subscription`.
Your server does handle the raw card number for this one call (even though
it's forwarded straight to the proxy and never stored), so this path puts
you in a heavier PCI scope than the browser flow — confirm the applicable
SAQ level with your acquirer or QSA before leaning on it for volume.

### 3. Legacy — `billing_id` and `payment_token`

Older integrations vault cards through Collect.js / the EPD Gateway vault. The
inputs below are still accepted on `POST /v1/customers/{id}/payment_methods`,
but neither exists on the MCP surface — `add_payment_method` and the composite
MCP tools accept `card_token` only. Use the current paths for new work:

| Legacy input    | Status     | Use instead                                            |
|-----------------|------------|--------------------------------------------------------|
| `billing_id`    | Deprecated | `card_token` (browser) or `secure.epd.com` (headless)  |
| `payment_token` | Deprecated | `card_token` (browser) or `secure.epd.com` (headless)  |

Critical: none of `card_token`, `billing_id`, `payment_token`, or a
`payment_method_id` returned from `secure.epd.com` is a card number. If a dev
tries to pass a 16-digit string into one of these fields thinking "oh it's a
card", the API rejects it — but more importantly, your backend has just
touched a PAN, which kicks you into full PCI scope. Educate your team that
anything looking like card data on your servers outside the `secure.epd.com`
call itself is an incident, not a feature.

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
