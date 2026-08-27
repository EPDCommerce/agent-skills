---
name: epd-mcp-operator
description: Use when an operator-agent connected to the EPD Commerce MCP server needs cross-cutting guidance rather than a single domain workflow — which tool to reach for, whether a call is safe to make, test-vs-live mode, idempotency, rate limits, and permission errors. Triggers when the user asks "which EPD tool should I use", "am I in test or live", "is this safe to run", when a call returns insufficient_permissions or 429, or before the first write of a session. Skip when the task is a specific domain workflow — load the owning skill named in the routing table below.
compatibility: Requires an MCP-connected agent authenticated against an EPD Commerce account with a full-access key. Restricted keys cannot reach the MCP endpoint.
metadata:
  version: 1.0.0
  api_version: "2026-02-11"
---

# Operating an EPD Commerce account through the MCP server

<!-- TODO: two-paragraph intro. What this skill is (the safety layer and router
     for the MCP surface, counterpart to epd-best-practices on the REST side),
     and what it deliberately is not (a domain workflow). State up front that
     the server ships its own `instructions` block covering money units, bare
     UUIDs and pagination — this skill does not restate it. -->

## Routing — pick the skill that matches the task

<!-- TODO: table of the 9 workflow skills, one row each, "if the task is X ->
     load Y". GATE-DEPENDENT: fill from audit/SKILL-MAP.md only once the Phase A
     map is signed off. Until then this section stays stubbed. -->

## Universal rules — apply to every MCP tool call

### Establish mode before anything else

<!-- TODO: ping returns environment / is_sandbox. Responses carry
     x-epd-environment, x-epd-test-mode, x-epd-sandbox. State the mode out loud
     before the first write of a session. Note that key prefix alone
     (epd_test_sk_ vs epd_live_sk_) is the other signal. -->

### Safety tiers — what the annotations mean

<!-- TODO: T0/T1/T2/T3 summary table, derived from the server's own annotation
     hints. Link to SAFETY.md for the full policy and to
     references/tiers.md for the per-tool table. Do not restate the policy. -->

### Idempotency — and the five tools that cannot

<!-- TODO: one fresh UUID v4 per logical operation; retry with the SAME key;
     idempotency_key_conflict means a different body reused a key.
     Required on 10 tools, optional on 23, and ABSENT on 5:
       reorder_product_images, test_webhook_endpoint, upgrade_webhook_version,
       downgrade_webhook_version, replay_webhook_event
     State the rule, then the exception and what to do instead. -->

### Error envelope

<!-- TODO: shape of an isError result, type vs code vs message, request_id.
     Route to references/errors.md. Codes must come from observed responses,
     NOT from integration/epd-best-practices/references/errors.md, which still
     carries the wrong idempotency codes pending Phase D. -->

### Rate limiting — three buckets, not one

<!-- TODO: 100/min (route), 60/min (data), 1000/hour (global). Every POST
     decrements all three, including initialize and tools/list. Back off on the
     MINIMUM of the three remaining counters — the unprefixed
     x-ratelimit-remaining reads on the 100 scale and overstates headroom ~2x.
     The hourly ceiling is ~17 minutes at full rate. -->

### No backgrounding

<!-- TODO: all 67 tools declare execution.taskSupport: "forbidden". Every call
     is synchronous; there is no fire-and-forget. Relevant to how recipes and
     long chains are written. -->

## Composite tools — when they beat the primitives

<!-- TODO: the 11 composites, what they chain, and the rollback-note shape on
     partial failure. Route to references/composites.md.
     THE INVERSION: the server's own instructions say to prefer composites.
     For onboarding that advice is wrong — create_customer_and_charge and
     create_customer_and_subscribe both require a browser-only card_token, so a
     server-side agent must use create_customer -> secure.epd.com ->
     create_order / create_subscription instead. Say this explicitly or agents
     will follow the server hint into a tool they cannot call. -->

## Permissions — why your key is full-access

<!-- TODO: restricted keys are refused by the MCP endpoint outright
     (authorization_error / insufficient_permissions, zero tools, even ping),
     while honouring their scopes correctly over REST. Least privilege is not
     available on this surface today, so the confirmation policy in SAFETY.md
     is the only control. Re-check with audit/key-matrix.mjs once EPD ships the
     API Access permission. -->

## What this skill will not do

<!-- TODO: does not perform domain workflows (routing table sends those on);
     does not restate the server's instructions block; does not grant or widen
     permissions; does not substitute for SAFETY.md. -->
