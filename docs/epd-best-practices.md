---
skill: epd-best-practices
surface: integration
guide_version: 1.0.0
api_version: "2026-02-11"
---

# epd-best-practices — guide

**Skill:** [`integration/epd-best-practices/SKILL.md`](../integration/epd-best-practices/SKILL.md) ·
**References:** [`integration/epd-best-practices/references/`](../integration/epd-best-practices/references/)

The master router for building EPD Commerce into your own backend over the v1
REST API. It is the code-generation counterpart to
[`epd-mcp-operator`](./epd-mcp-operator.md), which covers operating an account.

## What it does

Encodes the rules that never change across endpoints, then routes to a
per-domain reference for the detail. The SKILL.md stays small on purpose; the
nine references are loaded on demand.

| Task | Reference |
|---|---|
| Reusable HTTP client (auth + retry + idempotency) | `references/sdk-wrapper.md` |
| One-time charge / order processing | `references/payments.md` |
| Plans, subscriptions, trials, dunning | `references/subscriptions.md` |
| Refunds — partial, full, order vs transaction | `references/refunds.md` |
| Decoding an error response, retry strategy | `references/errors.md` |
| Stuck on a confusing error — decision tree | `references/debugging.md` |
| Key handling, sandbox vs live, PCI scope | `references/security.md` |
| Sandbox tokens, environment guards | `references/testing.md` |
| API version pinning, deprecation, migration | `references/versioning.md` |

### The universal rules, and why each one is load-bearing

**Pin the version on every request.** `EPD-Version: 2026-02-11`. Without it the
merchant's account-default version is used, which silently changes when they
upgrade. Pinning decouples your release schedule from theirs.

**Idempotency is a header here, a body parameter on MCP.** REST takes
`X-EPD-Idempotency-Key`; the MCP tool schemas take `idempotency_key` as a flat
field. Confusing the two when porting code between surfaces is a named trap in
the skill.

The key must be 16–64 characters of alphanumerics, hyphens and underscores —
anything else is `400 invalid_idempotency_key` — and one fresh UUID v4 per
logical operation. Semantic strings like `"order-123"` collide.

**Two 409s that mean opposite things:**

| Code | Means | Do |
|---|---|---|
| `idempotency_key_conflict` | same key, **different** body | Stop. Something changed between attempts — find out what before sending anything else. |
| `request_in_progress` | same key, **same** body | Treat as "the first attempt may have gone through". Look the resource up. Do not spin. |

The skill records a divergence worth knowing: the API reference promises that a
repeat within 24 hours returns the original response, and in sandbox it did
not — a same-key, same-body repeat got `request_in_progress` 1.5 seconds later
on 18 September 2026, and still at +90 seconds in August. So code that waits for
the replay waits forever.

> The MCP surface *does* replay a repeated key correctly. That asymmetry is
> documented in [`epd-mcp-operator`](./epd-mcp-operator.md) rather than here,
> and it matters when porting an operation between the two surfaces — the same
> retry is safe on one and not the other.

**The error envelope is uniform, and `field_errors` is the one to read.**
Validation failures carry `param` (the first bad field) and `field_errors[]`
(all of them). Reading `param` alone costs three round trips to fix one call.
Always surface `request_id` to support tooling.

**Pagination is cursor-based only.** `starting_after` / `ending_before`, never
both in one request, no `?page=`. Default limit 10, max 100.

**Filtering uses bracket notation** — `?amount[gte]=2999`, not `amount_gte`.

Two behaviours that pull in opposite directions and are worth holding together:

- **Unknown query *parameters* return 400.** The list endpoints use a strict
  schema; you cannot sneak `page=2` past the validator.
- **Unknown filter *values* do not.** A `status` the endpoint does not recognise
  is dropped silently. `GET /v1/subscriptions?status=past_due` returned all 130
  sandbox subscriptions on 18 September 2026 — active, canceled, paused and
  completed alike. Check the rows you get back against the filter you sent.

**Money is integer minor units**, currency is lowercase ISO 4217, country is
uppercase ISO 3166-1 alpha-2, datetimes are ISO 8601 with a timezone.

**Rate limits are three buckets, not one**, on REST as on MCP: 100/60s,
60/60s for data, 1000/hour global. Pace on the smallest `remaining`. The hourly
bucket is the one that ends long jobs — 1000 an hour is about 17 a minute
sustained, so a batch running at the data limit uses the hour in about 17
minutes.

### Schema lookup for what is not deep-covered

The references deep-cover payments, subscriptions, refunds and webhook
consumption. For transactions, plans, products, product images, shipping
addresses, shipping options, webhook endpoints and account, the skill fetches
the OpenAPI spec **on demand with a targeted prompt** — roughly 2–3 KB instead
of the 220 KB full read — and explicitly does not fetch it for anything the
skill already encodes, because the spec carries backward-compat aliases that
conflict.

One known drift: the spec's `servers:` block may list a non-canonical host such
as `api-commerce.epd.com`. The canonical base URL is `https://api.epd.com`, and
the skill says to trust itself over the spec on that one point.

## When it fires

- Imports or calls against `api.epd.com`.
- Env vars `EPD_API_KEY` / `EPD_WEBHOOK_SECRET` in the file.
- File content matching a key prefix — `epd_live_sk_`, `epd_test_sk_`,
  `epd_restricted_sk_live_`, `epd_restricted_sk_test_`.
- The user names EPD Commerce or EasyPayDirect and asks how to charge a card,
  start a subscription, or refund an order.

### What it must not answer

| Near miss | Goes to |
|---|---|
| Operating a live account via an MCP-connected agent | [`epd-mcp-operator`](./epd-mcp-operator.md) |
| A first integration with nothing built yet | [`epd-quickstart`](./epd-quickstart.md) |
| Writing or debugging a webhook receiver | [`epd-webhooks`](./epd-webhooks.md) |

## What it refuses to do, and why

| Refusal | Why |
|---|---|
| **Write business logic** — cart math, tax, fulfilment. | Not payments. A skill that starts inventing tax rules is confidently wrong in a domain it was never given. |
| **Pick a tokenization strategy for you.** | EPD Elements (browser capture, publishable key), `secure.epd.com` (server-to-server, secret key) and the legacy Collect.js vault are all live options. Which fits is a product decision with PCI-scope consequences; the skill explains each and stops. |
| **Generate webhook signature verification.** | That is [`epd-webhooks`](./epd-webhooks.md), which ships tested verifier scripts in three languages. Generating a fourth by hand is how a truthiness bug gets written. |
| **Operate against a live account.** | Code generation and account operation are separate surfaces with separate safety models. |
| **Pre-load the OpenAPI spec.** | 220 KB of context for a question a 3 KB targeted fetch answers. |
| **Fetch the spec for what it already encodes.** | Auth, idempotency, the error envelope, pagination, filtering, money rules and the four deep-covered domains. The spec's backward-compat aliases conflict with the current guidance. |

### The publishable key, stated precisely

EPD Commerce **does** issue a browser-safe key (`epd_live_pk_…` /
`epd_test_pk_…`), and it is capture-only: it can tokenize a card through the EPD
Elements SDK and nothing else. Every other call, including attaching that token
to a customer, uses a server-side secret key. The distinction matters because
"publishable key" in other payment APIs implies a wider surface.

Restricted keys (`epd_restricted_sk_…`) exist for analytics dashboards and
read-only workloads over REST — and are refused outright by the MCP endpoint,
which is why [`epd-mcp-operator`](./epd-mcp-operator.md) says every agent holds
a full-access key.

## What to check afterwards

Reviewing code an agent generated with this skill:

- [ ] **The version header is on every request**, not just the first.
- [ ] **The idempotency key is persisted with the operation**, not generated at
      the call site. A key in a local variable deduplicates nothing after a
      restart.
- [ ] **Retries reuse the same key** — 5xx and network errors, with exponential
      backoff and a cap. Every other 4xx is never retried.
- [ ] **409 is not handled as one case.** `idempotency_key_conflict` stops;
      `request_in_progress` reads the resource back.
- [ ] **`field_errors[]` is read**, not just `param`.
- [ ] **`request_id` reaches your logs** on every failure.
- [ ] **List responses are checked against the filter that was sent.** An
      unrecognised filter value is dropped silently.
- [ ] **`payment_method_id` is passed bare**, with no prefix. It is the one ID
      that never accepts one.
- [ ] **Amounts are integers in minor units** and nothing divides by 100 twice.
- [ ] **No secret key can reach a browser**, and no key is logged.

## A worked transcript

Illustrative. Endpoint shapes, error codes and the measured sandbox behaviours
are as the skill documents them. The corrected wrapper below is a sketch in its
helpers, not in its control flow — it was exercised against mocked responses for
every branch it claims, including a proxy 502 with an HTML body, a 429 with no
`Retry-After`, and a rejected `fetch`.

---

**Developer:** Our retry logic is double-charging occasionally. Here's the
wrapper — can you see it?

```ts
async function post(path: string, body: unknown) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://api.epd.com${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.EPD_API_KEY}`,
        'X-EPD-Idempotency-Key': crypto.randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    await sleep(2 ** attempt * 100);
  }
  throw new Error('failed after 3 attempts');
}
```

**Agent:** Yes — there are four problems, and the first one is the double
charge.

**1. The idempotency key is generated inside the retry loop.** Every attempt
gets a fresh UUID, so the server sees three unrelated operations rather than
three attempts at one. That is not a retry; it is three charges. The key must be
minted once per *logical operation* and reused across attempts:

```ts
async function post(path: string, body: unknown, idempotencyKey: string) {
  // key is an argument — the caller owns it
```

And the caller should **persist** it with the operation's state. A key that only
exists in memory is gone on the next process start, which is the version of this
bug that survives a code review.

**2. Every non-2xx is retried.** A `400 validation_error` is wrong, not
transient — retrying it three times produces the same 400 and delays the real
error. Retry 5xx and network errors. The **only** 4xx worth retrying is `429`,
and then only after `Retry-After`. `409 request_in_progress` is not a retry
either — it means read the resource back, which is a different action against a
different endpoint.

**3. Two 409s are being treated as one, and they mean opposite things.**

| Code | Means | Do |
|---|---|---|
| `idempotency_key_conflict` | same key, different body | **Stop.** Something changed between attempts — the amount, the customer, the items. Do not mint a new key to force it through. |
| `request_in_progress` | same key, same body | The first attempt may have gone through. **Read the resource back.** Do not spin. |

Worth knowing: the API reference says a same-key, same-body repeat within 24
hours returns the original response. In sandbox it did not — it returned
`request_in_progress` 1.5 seconds later on 18 September 2026, and still at +90
seconds in August. So code that waits for the replay waits forever.

**4. No version header.** Without `EPD-Version`, you get the merchant's
account-default version, which changes when they upgrade their account and not
when you deploy.

Two more things I would add while you are in here. Respect `Retry-After` on a
429 rather than computing your own backoff — and note there are three rate-limit
buckets, of which the unsuffixed header is the loosest. And surface `request_id`
from the error envelope into your logs; EPD support asks for it first and it is
not recoverable after the fact.

```ts
async function post(path: string, body: unknown, idempotencyKey: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`https://api.epd.com${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.EPD_API_KEY}`,
          'EPD-Version': '2026-02-11',
          'X-EPD-Idempotency-Key': idempotencyKey,   // same key every attempt
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      await sleep(2 ** attempt * 100);   // network error — same key, try again
      continue;
    }

    if (res.ok) return res.json();

    // A 5xx from a proxy is HTML, not the error envelope. Never parse blind.
    const error = await res.json().then((b) => b?.error, () => undefined);
    log.warn({ status: res.status, request_id: error?.request_id, code: error?.code });

    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      await sleep((Number.isFinite(after) ? after : 2 ** attempt) * 1000);
      continue;
    }
    if (res.status >= 500) { await sleep(2 ** attempt * 100); continue; }
    if (error?.code === 'request_in_progress') throw new ReadBackRequired(error);
    throw new EpdError(error ?? { code: `http_${res.status}` });   // other 4xx: no retry
  }
  throw new Error('failed after 3 attempts');
}
```

The shape that matters is the key being an argument. Three details in there are
not decoration:

- **`fetch` is wrapped.** It *rejects* on a network failure rather than
  returning a response, so an unwrapped call leaves the retry loop entirely —
  the one failure the loop most exists for.
- **The body parse is guarded.** A 502 from a load balancer is HTML, and
  `await res.json()` on it throws a `SyntaxError` that looks nothing like a
  payments problem. `error` stays `undefined` and the status still routes.
- **`retry-after` has a fallback.** The header is not always present, and
  `sleep(NaN)` is `sleep(0)` — which turns a rate-limit backoff into three
  instant retries. Each one still spends hourly quota, so spinning makes the
  limit worse rather than shorter.

---

### What the transcript demonstrates

- **The reported symptom was traced to the actual cause**, which was one line
  and not the retry count.
- **The persistence point was made**, because the in-memory version of the fix
  survives review and still fails.
- **Two same-status errors were separated**, with opposite handling.
- **A documented-versus-measured divergence was stated with its date**, rather
  than repeating the documentation.
- **The control flow is complete, not sketched.** The helpers — `sleep`, `log`,
  the two error classes — are named rather than written, but every branch the
  prose claims is present and handles the failure it names, including the three
  that are easy to leave out: a rejected `fetch`, a 5xx whose body is HTML, and
  a 429 with no `Retry-After`.

## Where it hands off

| If the task is | Load |
|---|---|
| Nothing built yet, first charge | [`epd-quickstart`](./epd-quickstart.md) |
| Webhook receiver, signatures, raw body | [`epd-webhooks`](./epd-webhooks.md) |
| Operating a live account over MCP | [`epd-mcp-operator`](./epd-mcp-operator.md) |
| Per-domain detail | the nine references listed at the top of this guide |
