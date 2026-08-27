# Error envelopes on the MCP surface

<!-- TODO (step 16). Every code below must come from a response actually
     observed against the server. Do NOT copy from
     integration/epd-best-practices/references/errors.md — that file documents
     idempotency_key_mismatch (422) and idempotency_key_in_use, neither of
     which the server returns. Correcting it is Phase D work. -->

## The shape

<!-- TODO: an MCP tool failure comes back as a result with isError: true and a
     JSON body in content[0].text — it is not a JSON-RPC error. Agents that
     only check for rpc errors will read a failure as a success. Show both
     shapes side by side.

     Envelope fields: type, code, message, param, request_id, plus
     field_errors[] on validation failures. Always surface request_id when
     reporting a failure to a human — it is what support will ask for. -->

## Codes observed in sandbox

<!-- TODO: table of code | type | what it means | safe to retry?

     Confirmed on 27 Aug:
       idempotency_key_conflict  idempotency_error     same key, different body. NO retry, new key for new intent.
       request_in_progress       idempotency_error     REST only; key in flight
       insufficient_permissions  authorization_error   restricted key, or key lacks scope
       resource_not_found        invalid_request_error id does not exist
       invalid_type              invalid_request_error wrong type; check field_errors
       invalid_format            invalid_request_error failed a pattern, e.g. card_token ^cct_[0-9a-f]{48}$

     Note that permission is checked BEFORE existence: a scoped-out resource
     returns insufficient_permissions, not resource_not_found. That ordering is
     what lets a skill name the missing permission instead of retrying. -->

## Naming the missing permission

<!-- TODO: on insufficient_permissions the agent must stop, say which resource
     and which access level is missing, and not retry. Restricted keys cannot
     reach MCP at all today (zero tools, even ping), so on this surface the
     code almost always means the key is restricted rather than under-scoped. -->

## Rate limit responses

<!-- TODO: 429 handling, Retry-After, and the three-bucket detail — back off on
     the minimum of x-ratelimit-remaining, -global and -data. -->
