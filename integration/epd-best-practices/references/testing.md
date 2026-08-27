# Testing — sandbox tokens & environment guards

The EPD Commerce sandbox is functionally identical to production. Same endpoints, same
schemas, same idempotency rules. The differences:

- Sandbox API keys (`epd_test_sk_...`) talk to a separate database.
- The sandbox EPD Gateway vault has **deterministic test card tokens** that
  trigger specific outcomes.
- No real money moves.

## Sandbox card tokens (legacy path)

In sandbox, pass a **test card token** (string starting with `card_`) as the
`billing_id` on `POST /v1/customers/{id}/payment_methods`. This is the
**legacy** sandbox path — it exercises the same Collect.js / EPD Gateway
vault flow that `billing_id` uses in production, and it is not available on
the MCP surface (MCP's `add_payment_method` and composites take `card_token`
only, which these string tokens are not). The gateway mints a vault entry
backed by the corresponding test card. Subsequent orders against that
payment method produce the deterministic result below.

| `billing_id` token         | Result on `POST /v1/orders`                                                           |
|----------------------------|---------------------------------------------------------------------------------------|
| `card_visa`                | `status: "succeeded"` (Visa).                                                         |
| `card_mastercard`          | `status: "succeeded"` (Mastercard).                                                   |
| `card_amex`                | `status: "succeeded"` (American Express).                                             |
| `card_discover`            | `status: "succeeded"` (Discover).                                                     |
| `card_visa_declined`       | `status: "failed"`, `failure_reason: "transaction_not_allowed"` (Visa decline).       |
| `card_mastercard_declined` | `status: "failed"`, `failure_reason: "transaction_not_allowed"` (Mastercard decline). |
| `card_insufficient_funds`  | `status: "failed"`, `failure_reason: "insufficient_funds"`.                           |
| `card_expired`             | `status: "failed"`, `failure_reason: "expired_card"`.                                 |
| `card_processing_error`    | `status: "failed"`, `failure_reason: "processor_declined"` (network/processing).      |
| `card_cvv_mismatch`        | `status: "failed"`, `failure_reason: "incorrect_cvv"`.                                |
| `card_chargeback`          | Charge **succeeds** initially. A chargeback can be simulated separately via the dashboard — **no automatic chargeback webhook fires**. |

> Tokens are matched on the literal string. You can also pass a raw numeric
> `billing_id` (16-digit string) in sandbox, but tokens are stable and
> self-documenting — prefer them.

The full failure_reason enum is in `errors.md` ("Failure reasons on declined
orders"). Branch on `order.status === "failed"` first, then on
`order.failure_reason`.

## Testing the headless path (`secure.epd.com`)

For an integration that gets a card on file via `https://secure.epd.com`
(see `security.md`), sandbox testing doesn't use the `card_` tokens above —
POST a standard test card number instead, e.g. `4111 1111 1111 1111` (a
generic always-succeeds Visa test PAN) with any future expiry and any CVC.
Use your sandbox secret key (`epd_test_sk_...`) on the request. The response
is the same payment method object shape as the browser flow; its `id` feeds
into `create_order` / `create_subscription` the same way.

For a browser-based (`card_token`) integration, sandbox testing runs through
the same EPD Elements flow as production, initialized with a **test**
publishable key (`epd_test_pk_...`) — the `cct_...` token it produces is
attached with a sandbox secret key.

## Test mode environment guard pattern

Wrap every EPD Commerce call site behind an environment check that refuses to run a
test key in production or a live key in development:

```ts
function assertEpdEnvSafe(apiKey: string, nodeEnv: string): void {
  const isLiveKey = apiKey.startsWith("epd_live_sk_") || apiKey.startsWith("epd_restricted_sk_live_");
  const isTestKey = apiKey.startsWith("epd_test_sk_") || apiKey.startsWith("epd_restricted_sk_test_");

  if (!isLiveKey && !isTestKey) {
    throw new Error(`Unrecognized EPD Commerce key prefix: ${apiKey.slice(0, 16)}...`);
  }

  const isProd = nodeEnv === "production";
  if (isProd && !isLiveKey) {
    throw new Error("Refusing to use a test EPD Commerce key in production.");
  }
  if (!isProd && isLiveKey) {
    throw new Error("Refusing to use a live EPD Commerce key outside production.");
  }
}
```

Run this at process startup, not on every request. If it throws, the process
exits — you'll catch it in dev/staging long before a customer would.

## Integration test patterns

### 1. Per-test idempotency keys

Every test case generates its own UUID for `X-EPD-Idempotency-Key`. **Don't
use semantic strings like `"test-charge-1"`** — across CI runs they collide
with cached responses from previous runs and produce confusing flakes.

```ts
import { randomUUID } from "node:crypto";

it("creates and charges a customer", async () => {
  const key = randomUUID();
  const order = await epd.request("/v1/orders", {
    method: "POST",
    idempotencyKey: key,
    body: { /* ... */ },
  });
  expect(order.status).toBe("succeeded");
});
```

### 2. Don't share customers across tests

Each test creates its own customer + payment method. Sharing fixtures means
one test failing leaves the next in an unknown state. Sandbox is fast — the
overhead of creating fresh state per test is negligible.

### 3. Clean up explicitly

Sandbox accounts accumulate data. At the end of each test (or at the end of
the suite), delete what you created — but cancel subscriptions first or the
delete is rejected:

```ts
afterEach(async () => {
  for (const subId of createdSubscriptionIds) {
    await epd.request(`/v1/subscriptions/${subId}`, { method: "DELETE" });
  }
  for (const id of createdCustomerIds) {
    await epd.request(`/v1/customers/${id}`, { method: "DELETE" });
  }
});
```

`DELETE /v1/customers/{id}` behavior:

- **Blocked** with `customer_has_active_subscriptions` (400) if the customer
  has any subscription in `active` or `paused` state. Cancel them first.
- **Soft-delete** (archived; `deleted_at` set) if the customer has any orders
  — historical data is preserved.
- **Hard-delete** (row removed) if the customer has no orders.

Re-calling `DELETE` on an already-soft-deleted customer returns the same
success payload — safe to retry.

### 4. Test the failure paths, not just the happy path

Use the declining sandbox tokens above to assert your error-handling code
actually runs. The most common bug in integrations is silently treating a
declined order as a success because nobody tested that branch.

## What sandbox does NOT simulate

- **Real network failures.** To test your retry logic, mock the HTTP client
  in unit tests. The sandbox is up; you can't make it fall over on demand.
- **Webhook signature verification with rotated secrets.** The sandbox emits
  webhooks signed with the configured secret. To test your verifier against
  a wrong-secret scenario, use the verifier's unit tests (see `epd-webhooks`
  scripts).
- **Production-volume rate limiting.** Sandbox has its own (more relaxed)
  rate limits. Don't load-test against sandbox expecting prod rate limits.
- **Issuer-side card behaviors that depend on the real card brand.** The
  sandbox tokens are deterministic by design.

## Common bugs to avoid

1. **Hardcoding sandbox test cards into production migration scripts.** They
   look like real numeric strings; they're not real cards. Reject anything
   with `billing_id` matching the test patterns at the boundary of any
   data-import script.
2. **Reusing sandbox idempotency keys after a failed run.** If a test failed
   and left a partial state, the cached response from your retry will mask
   the real fix. Generate fresh keys per test.
3. **Asserting on `created_at` or `id` values in tests.** They're
   non-deterministic; assert structure, not values.

## Where to go next

- Production key handling and PCI scope → `security.md`
- Webhook testing → `epd-webhooks` skill
