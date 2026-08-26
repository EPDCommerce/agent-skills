# Coverage audit and skill map

Generated from `audit/tools-2026-08-25.json` (live `tools/list`, sandbox key, `epd-version: 2026-02-11`).
Regenerate with `node audit/matrix.mjs`.

## Summary

| | |
|---|---|
| Tools on the server | **67** (docs publish 63) |
| Documented today | 14 |
| Not mentioned anywhere today | 40 |
| Proposed: worked example | 47 |
| Proposed: reference row only | 19 |
| Proposed: one-line mention | 1 |
| Blocked on client answer | 3 |

**Treatment** is the scope control. A `get_*` that takes an id and returns the object
needs a table row, not a transcript; a destructive tool needs a transcript showing the
confirmation. Uniform coverage across all 67 would be padding.

## Coverage by group

| Group | Tools | Documented today | Absent today | Proposed owner(s) |
|---|---|---|---|---|
| Account | 3 | 0 | 3 | epd-mcp-operator |
| Customers | 5 | 1 | 4 | epd-onboard-customer |
| Payment Methods | 3 | 1 | 2 | epd-onboard-customer |
| Products | 7 | 0 | 7 | epd-catalog |
| Plans | 2 | 0 | 2 | epd-catalog |
| Orders | 5 | 2 | 1 | epd-catalog, epd-transaction-triage, epd-refunds |
| Subscriptions | 5 | 3 | 1 | epd-subscriptions |
| Transactions | 2 | 0 | 0 | epd-transaction-triage |
| Webhook Endpoints | 12 | 0 | 8 | epd-webhook-ops |
| Webhook Versions | 3 | 0 | 2 | epd-webhook-ops |
| Coupons | 9 | 0 | 9 | epd-coupons |
| Composite | 11 | 7 | 1 | epd-onboard-customer, epd-catalog, epd-subscriptions, epd-reporting, epd-refunds, epd-webhook-ops |

## Coverage by safety tier

Tiers are derived from the server's own annotations, not assigned by hand.

| Tier | Tools | Documented today | Absent today |
|---|---|---|---|
| T0 read | 29 | 1 | 18 |
| T2 write | 18 | 5 | 13 |
| T2 external | 2 | 0 | 0 |
| T3 destructive | 18 | 8 | 9 |

## Proposed skill map

| Skill | Tools owned | New or existing |
|---|---|---|
| `epd-mcp-operator` | 3 | new |
| `epd-onboard-customer` | 10 | existing, revised |
| `epd-catalog` | 11 | new |
| `epd-transaction-triage` | 5 | new |
| `epd-refunds` | 3 | existing, revised |
| `epd-subscriptions` | 8 | existing, revised |
| `epd-webhook-ops` | 16 | new |
| `epd-coupons` | 9 | new |
| `epd-reporting` | 2 | new |

`epd-best-practices`, `epd-quickstart` and `epd-webhooks` stay REST/integration-facing and own no MCP tools.
The MCP counterparts are `epd-mcp-operator` and `epd-webhook-ops`.

## Blocked on client answer

- `add_payment_method` — MCP takes card_token (^cct_[0-9a-f]{48}$) only; billing_id is REST-only. Awaiting sandbox token path.
- `create_customer_and_subscribe` — same card_token question. Current example fails schema validation.
- `create_customer_and_charge` — same card_token question. Current example in epd-onboard-customer fails schema validation.

## Tool-by-tool matrix

| Tool | Group | Annotations (from server) | Tier | `idempotency_key` | Today | Proposed owner | Treatment | Notes |
|---|---|---|---|---|---|---|---|---|
| `ping` | Account | readOnly, idempotent | T0 read | — | — | `epd-mcp-operator` | MENTION | Liveness check with no workflow around it. One line in epd-mcp-operator as the connection test; a dedicated section would be padding. |
| `get_account` | Account | readOnly, idempotent | T0 read | — | — | `epd-mcp-operator` | REFERENCE |  |
| `upgrade_account_api_version` | Account | destructive, idempotent | T3 destructive | optional | — | `epd-mcp-operator` | EXAMPLE | Destructive and account-wide. Sandbox account currently has api_version=null (floating on latest), so the Aug 31 release lands automatically. |
| `create_customer` | Customers | idempotent | T2 write | optional | documented (epd-best-practices, epd-onboard-customer) | `epd-onboard-customer` | EXAMPLE |  |
| `list_customers` | Customers | readOnly, idempotent | T0 read | — | — | `epd-onboard-customer` | REFERENCE |  |
| `get_customer` | Customers | readOnly, idempotent | T0 read | — | — | `epd-onboard-customer` | REFERENCE |  |
| `update_customer` | Customers | idempotent | T2 write | optional | — | `epd-onboard-customer` | EXAMPLE |  |
| `delete_customer` | Customers | destructive, idempotent | T3 destructive | optional | — | `epd-onboard-customer` | EXAMPLE |  |
| `list_payment_methods` | Payment Methods | readOnly, idempotent | T0 read | — | — | `epd-onboard-customer` | REFERENCE |  |
| `add_payment_method` | Payment Methods | idempotent | T2 write | optional | documented (epd-best-practices, epd-onboard-customer, epd-subscriptions) | `epd-onboard-customer` | EXAMPLE | BLOCKED ON CLIENT — MCP takes card_token (^cct_[0-9a-f]{48}$) only; billing_id is REST-only. Awaiting sandbox token path. |
| `delete_payment_method` | Payment Methods | destructive, idempotent | T3 destructive | optional | — | `epd-onboard-customer` | EXAMPLE |  |
| `create_product` | Products | idempotent | T2 write | optional | — | `epd-catalog` | EXAMPLE |  |
| `list_products` | Products | readOnly, idempotent | T0 read | — | — | `epd-catalog` | REFERENCE |  |
| `get_product` | Products | readOnly, idempotent | T0 read | — | — | `epd-catalog` | REFERENCE |  |
| `update_product` | Products | idempotent | T2 write | optional | — | `epd-catalog` | EXAMPLE |  |
| `delete_product` | Products | destructive, idempotent | T3 destructive | optional | — | `epd-catalog` | EXAMPLE |  |
| `delete_product_image` | Products | destructive, idempotent | T3 destructive | optional | — | `epd-catalog` | EXAMPLE |  |
| `reorder_product_images` | Products | idempotent | T2 write | — | — | `epd-catalog` | EXAMPLE | Write tool with no idempotency_key parameter — the "idempotency_key on every write" rule needs a stated exception here. |
| `list_plans` | Plans | readOnly, idempotent | T0 read | — | — | `epd-catalog` | REFERENCE |  |
| `get_plan` | Plans | readOnly, idempotent | T0 read | — | — | `epd-catalog` | REFERENCE |  |
| `create_order` | Orders | idempotent | T2 write | required | documented (epd-best-practices, epd-onboard-customer) | `epd-catalog` | EXAMPLE |  |
| `list_orders` | Orders | readOnly, idempotent | T0 read | — | prose-only (epd-refunds) | `epd-transaction-triage` | REFERENCE |  |
| `get_order` | Orders | readOnly, idempotent | T0 read | — | prose-only (epd-refunds) | `epd-transaction-triage` | REFERENCE |  |
| `refund_order` | Orders | destructive, idempotent | T3 destructive | required | documented (epd-best-practices, epd-refunds, epd-subscriptions) | `epd-refunds` | EXAMPLE |  |
| `retry_order` | Orders | destructive, idempotent | T3 destructive | required | — | `epd-transaction-triage` | EXAMPLE | Absent from the published docs entirely. Destructive + retries money movement, so it needs the soft/hard decline split from epd-transaction-triage. |
| `create_subscription` | Subscriptions | idempotent | T2 write | required | documented (epd-onboard-customer, epd-subscriptions) | `epd-subscriptions` | EXAMPLE |  |
| `list_subscriptions` | Subscriptions | readOnly, idempotent | T0 read | — | — | `epd-subscriptions` | REFERENCE |  |
| `get_subscription` | Subscriptions | readOnly, idempotent | T0 read | — | prose-only (epd-subscriptions) | `epd-subscriptions` | REFERENCE |  |
| `update_subscription` | Subscriptions | idempotent | T2 write | optional | documented (epd-subscriptions) | `epd-subscriptions` | EXAMPLE |  |
| `cancel_subscription` | Subscriptions | destructive, idempotent | T3 destructive | optional | documented (epd-subscriptions) | `epd-subscriptions` | EXAMPLE |  |
| `list_transactions` | Transactions | readOnly, idempotent | T0 read | — | table-only (epd-refunds, epd-subscriptions) | `epd-transaction-triage` | EXAMPLE |  |
| `get_transaction` | Transactions | readOnly, idempotent | T0 read | — | prose-only (epd-refunds) | `epd-transaction-triage` | EXAMPLE |  |
| `create_webhook_endpoint` | Webhook Endpoints | idempotent | T2 write | optional | — | `epd-webhook-ops` | EXAMPLE |  |
| `list_webhook_endpoints` | Webhook Endpoints | readOnly, idempotent | T0 read | — | — | `epd-webhook-ops` | REFERENCE |  |
| `get_webhook_endpoint` | Webhook Endpoints | readOnly, idempotent | T0 read | — | — | `epd-webhook-ops` | REFERENCE |  |
| `update_webhook_endpoint` | Webhook Endpoints | idempotent | T2 write | optional | — | `epd-webhook-ops` | EXAMPLE |  |
| `delete_webhook_endpoint` | Webhook Endpoints | destructive, idempotent | T3 destructive | optional | — | `epd-webhook-ops` | EXAMPLE |  |
| `rotate_webhook_secret` | Webhook Endpoints | destructive, idempotent | T3 destructive | optional | — | `epd-webhook-ops` | EXAMPLE | Needs the overlap-window procedure written before the rotate call, not after. |
| `test_webhook_endpoint` | Webhook Endpoints | openWorld | T2 external | — | prose-only (epd-webhooks) | `epd-webhook-ops` | EXAMPLE | openWorldHint — calls an external URL. No idempotency_key parameter exists. |
| `upgrade_webhook_version` | Webhook Endpoints | idempotent | T2 write | — | — | `epd-webhook-ops` | EXAMPLE | Write tool with no idempotency_key parameter. Run preview_webhook_payload and compare_webhook_versions first. |
| `downgrade_webhook_version` | Webhook Endpoints | idempotent | T2 write | — | — | `epd-webhook-ops` | EXAMPLE | Write tool with no idempotency_key parameter. |
| `replay_webhook_event` | Webhook Endpoints | openWorld | T2 external | — | prose-only (epd-webhooks) | `epd-webhook-ops` | EXAMPLE | openWorldHint — calls an external URL. No idempotency_key parameter exists. |
| `list_webhook_events` | Webhook Endpoints | readOnly, idempotent | T0 read | — | heading-only (epd-webhooks) | `epd-webhook-ops` | REFERENCE |  |
| `list_webhook_delivery_logs` | Webhook Endpoints | readOnly, idempotent | T0 read | — | prose-only (epd-webhooks) | `epd-webhook-ops` | EXAMPLE |  |
| `list_webhook_versions` | Webhook Versions | readOnly, idempotent | T0 read | — | — | `epd-webhook-ops` | REFERENCE |  |
| `preview_webhook_payload` | Webhook Versions | readOnly, idempotent | T0 read | — | prose-only (epd-webhooks) | `epd-webhook-ops` | EXAMPLE |  |
| `compare_webhook_versions` | Webhook Versions | readOnly, idempotent | T0 read | — | — | `epd-webhook-ops` | EXAMPLE |  |
| `create_coupon` | Coupons | idempotent | T2 write | optional | — | `epd-coupons` | EXAMPLE |  |
| `list_coupons` | Coupons | readOnly, idempotent | T0 read | — | — | `epd-coupons` | REFERENCE |  |
| `retrieve_coupon` | Coupons | readOnly, idempotent | T0 read | — | — | `epd-coupons` | REFERENCE |  |
| `update_coupon` | Coupons | idempotent | T2 write | optional | — | `epd-coupons` | EXAMPLE |  |
| `archive_coupon` | Coupons | destructive, idempotent | T3 destructive | optional | — | `epd-coupons` | EXAMPLE | Archive vs delete distinction must be explicit — unarchive_coupon exists, so archive is reversible and should not be described as deletion. |
| `unarchive_coupon` | Coupons | idempotent | T2 write | optional | — | `epd-coupons` | EXAMPLE |  |
| `generate_coupon_codes` | Coupons | idempotent | T2 write | optional | — | `epd-coupons` | EXAMPLE |  |
| `list_coupon_codes` | Coupons | readOnly, idempotent | T0 read | — | — | `epd-coupons` | REFERENCE |  |
| `validate_coupon` | Coupons | readOnly, idempotent | T0 read | — | — | `epd-coupons` | EXAMPLE |  |
| `create_customer_and_subscribe` | Composite | destructive, idempotent | T3 destructive | required | documented (epd-best-practices, epd-onboard-customer, epd-subscriptions) | `epd-onboard-customer` | EXAMPLE | BLOCKED ON CLIENT — same card_token question. Current example fails schema validation. |
| `process_order` | Composite | destructive, idempotent | T3 destructive | required | table-only (epd-best-practices, epd-onboard-customer) | `epd-catalog` | EXAMPLE |  |
| `cancel_subscription_and_report` | Composite | destructive, idempotent | T3 destructive | optional | documented (epd-best-practices, epd-subscriptions) | `epd-subscriptions` | EXAMPLE |  |
| `get_customer_financial_summary` | Composite | readOnly, idempotent | T0 read | — | prose-only (epd-onboard-customer, epd-refunds, epd-subscriptions) | `epd-reporting` | EXAMPLE |  |
| `get_revenue_summary` | Composite | readOnly, idempotent | T0 read | — | prose-only (epd-onboard-customer) | `epd-reporting` | EXAMPLE |  |
| `list_past_due_subscriptions` | Composite | readOnly, idempotent | T0 read | — | documented (epd-subscriptions) | `epd-subscriptions` | EXAMPLE |  |
| `refund_transaction` | Composite | destructive, idempotent | T3 destructive | required | documented (epd-best-practices, epd-refunds) | `epd-refunds` | EXAMPLE |  |
| `setup_webhook_monitoring` | Composite | idempotent | T2 write | optional | — | `epd-webhook-ops` | EXAMPLE |  |
| `create_customer_and_charge` | Composite | destructive, idempotent | T3 destructive | required | documented (epd-best-practices, epd-onboard-customer) | `epd-onboard-customer` | EXAMPLE | BLOCKED ON CLIENT — same card_token question. Current example in epd-onboard-customer fails schema validation. |
| `refund_and_cancel` | Composite | destructive, idempotent | T3 destructive | required | documented (epd-best-practices, epd-refunds, epd-subscriptions) | `epd-refunds` | EXAMPLE |  |
| `retry_failed_charge` | Composite | destructive, idempotent | T3 destructive | required | documented (epd-best-practices, epd-subscriptions) | `epd-subscriptions` | EXAMPLE |  |

## Deliberately not given dedicated treatment

- `ping` — Liveness check with no workflow around it. One line in epd-mcp-operator as the connection test; a dedicated section would be padding.

