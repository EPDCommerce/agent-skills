# Error envelopes on the MCP surface

Every code and shape below was observed against the live sandbox on 25–27 August
2026. Nothing here is inherited from the REST error reference in
`integration/epd-best-practices/references/errors.md`, which documents
idempotency codes this surface does not return.

## Three shapes, not one

The most common way to mishandle an EPD failure is to only know one of these.

### 1. Tool-level error — HTTP 200

The usual case. The HTTP request succeeded; the *tool* failed.

```
HTTP 200
event: message
data: {"result":{"isError":true,"content":[{"type":"text","text":"{ …json… }"}]},"jsonrpc":"2.0","id":1}
```

The error is JSON **inside a string** in `content[0].text`, and must be parsed
out. `isError: true` is the signal.

> A refund that fails arrives as HTTP 200. An agent that checks only the status
> code, or only for a JSON-RPC `error`, will report it to the customer as done.

### 2. Protocol error — HTTP 200, but not JSON

Asking for a tool that does not exist returns `isError: true` with **plain
text**, not an envelope:

```
MCP error -32602: Tool no_such_tool not found
```

So `JSON.parse(content[0].text)` throws here. Always guard it, and treat a
parse failure as the error message itself rather than as a crash.

### 3. Transport error — HTTP 4xx, no MCP envelope at all

Authentication, authorisation and rate limiting are rejected before the MCP
layer. There is no SSE framing and no `isError` — just a status code and a bare
JSON body:

```
HTTP 403
{"error":{"type":"authorization_error","code":"insufficient_permissions",
          "message":"Restricted API keys cannot access endpoints without explicit permission declarations.",
          "request_id":"req_…"}}
```

```
HTTP 429
retry-after: 17
{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded",
          "message":"Rate limit exceeded for data operations. Please retry after 17 seconds.",
          "request_id":"req_…"}}
```

## The envelope

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_format",
    "message": "Invalid string: must match pattern /^cct_[0-9a-f]{48}$/.",
    "param": "card_token",
    "field_errors": [
      { "field": "card_token", "code": "invalid_format",
        "message": "Invalid string: must match pattern /^cct_[0-9a-f]{48}$/." }
    ],
    "request_id": "req_3ace0df1371f46ba94704042f84a0c76"
  }
}
```

| Field | Always present | Notes |
|---|---|---|
| `type` | yes | error class — branch on this first |
| `code` | yes | the specific failure |
| `message` | yes | human-readable; safe to show |
| `param` | validation errors only | the **first** offending field |
| `field_errors[]` | validation errors only | **every** offending field |
| `request_id` | yes | quote it verbatim when reporting to a human |
| `idempotency_key` | idempotency errors only | echoes the key that clashed |

### Read `field_errors`, not `param`

`param` names one field. `field_errors` names them all. A `create_customer` call
missing three required fields returns:

```json
"message": "Validation failed for 3 fields. Invalid input: expected string, received undefined.",
"param": "first_name",
"field_errors": [
  { "field": "first_name", "code": "invalid_type", "message": "Invalid input: expected string, received undefined." },
  { "field": "last_name",  "code": "invalid_type", "message": "Invalid input: expected string, received undefined." },
  { "field": "phone",      "code": "invalid_type", "message": "Invalid input: expected string, received undefined." }
]
```

Fixing only `param` costs three round trips against the 60/minute bucket for one
mistake. Ask the human for all three at once.

### A missing field is reported as a type error

There is no `missing_field` code. An absent required argument comes back as
`invalid_type` with `received undefined`. Detect missing arguments by that
phrase in `field_errors`, not by a distinct code — and then apply
[`SAFETY.md` rule 5](https://github.com/EPDCommerce/agent-skills/blob/main/SAFETY.md): stop and ask, never guess the value.

## Codes observed

| Code | `type` | Where | Meaning | Retry? |
|---|---|---|---|---|
| `resource_not_found` | `invalid_request_error` | tool | ID does not exist | No — re-read, do not invent an ID |
| `invalid_type` | `invalid_request_error` | tool | wrong type, or required field absent | No — fix the call |
| `invalid_format` | `invalid_request_error` | tool | failed a pattern, e.g. `card_token` | No — fix the value |
| `invalid_value` | `invalid_request_error` | tool | not one of an enum's options | No — fix the value |
| `idempotency_key_conflict` | `idempotency_error` | tool + REST | key reused with a different body | **No — stop and ask why** |
| `request_in_progress` | `idempotency_error` | REST only | key still in flight | No — see the caveat below |
| `insufficient_permissions` | `authorization_error` | HTTP 403 | key cannot reach this surface | No |
| `rate_limit_exceeded` | `rate_limit_error` | HTTP 429 | a bucket is exhausted | **Yes** — after `retry-after` |
| `email_already_exists` | `invalid_request_error` | REST 409 | unique constraint | No |
| `phone_already_exists` | `invalid_request_error` | REST 409 | unique constraint | No |

Only two conditions justify a retry: a rate limit, and a timeout with no
response at all. Everything above is a defect in the request.

## `insufficient_permissions` on this surface

Over REST this means the key lacks scope for that resource, and the right
response is to name the missing permission rather than retry.

On MCP it almost always means something else: **the key is restricted**, and
restricted keys cannot reach the MCP endpoint at all. They return zero tools and
are refused even for `ping`. If this appears against `api.epd.com/mcp`, the fix
is a full-access key, not a wider scope. See the permissions section of
[`SAFETY.md`](https://github.com/EPDCommerce/agent-skills/blob/main/SAFETY.md).

## Idempotency errors differ by surface

`idempotency_key_conflict` means the key was reused with a **different** body.
Do not paper over it with a fresh key — something changed between attempts, and
in payments that is usually an amount or a target.

Two REST behaviours to know about, both observed and both looking like defects:

- `POST /v1/customers` with the same key and an identical body returns
  `409 request_in_progress` rather than replaying the original response, and
  still did 90 seconds later.
- `POST secure.epd.com` with the same key and a `sha256`-identical body returns
  `409 idempotency_key_conflict` — reporting different parameters when none
  differed.

MCP tools replay correctly. So after a timeout: retry MCP calls with the same
key, but do **not** retry `secure.epd.com` — call `list_payment_methods` and
look for the card first.

## Always surface `request_id`

It is in every failure, at every shape, and it is the first thing EPD support
asks for. Include it verbatim; it cannot be recovered afterwards.
