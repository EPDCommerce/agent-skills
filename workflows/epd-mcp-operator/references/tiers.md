# Safety tiers — every tool, with the annotations behind them

<!-- GENERATED FILE — do not edit by hand.
     Produced by scripts/gen-tiers.mjs from audit/tools-2026-08-25.json.
     Regenerate after any API release:  node scripts/gen-tiers.mjs -->

Tiers are not assigned by hand. Every EPD MCP tool declares four annotation
hints, and the tier is a pure function of them:

| Annotation | Tier | What the agent must do |
|---|---|---|
| `readOnlyHint` | **T0** | Nothing. Read freely, no confirmation. |
| `destructiveHint` | **T3** | Print the plan, echo amount, currency, object id and key mode, wait for an explicit yes. |
| `openWorldHint` | **T2** | Calls an external URL. Confirm first; not idempotent. |
| none of the above | **T2** | An ordinary write. Print the plan and confirm. |

`SAFETY.md` defines what each tier requires. This file only says which tool
sits in which tier, and shows the raw hints so the mapping can be checked
rather than taken on trust.

## Counts

| Tier | Tools |
|---|---|
| T0 read | 29 |
| T2 write | 18 |
| T2 external | 2 |
| T3 destructive | 18 |
| **Total** | **67** |

## Destructive tools, split by retry risk

Not every T3 is dangerous in the same way, and the schema says which is which.
Of the destructive tools, the ones that **require** an idempotency key are
exactly the ones that move money; the ones where it is **optional** are
deletes, cancels and archives, which are naturally idempotent — deleting twice
leaves the same state, charging twice does not.

Both still need T3 confirmation. The difference is what happens after a
timeout with no response: for the money-movers, retry with the same key and
let the server deduplicate. For the rest, read current state back first.

**Money movement — key required (8):**

- `refund_order`
- `retry_order`
- `create_customer_and_subscribe`
- `process_order`
- `refund_transaction`
- `create_customer_and_charge`
- `refund_and_cancel`
- `retry_failed_charge`

**State removal — key optional (10):**

- `upgrade_account_api_version`
- `delete_customer`
- `delete_payment_method`
- `delete_product`
- `delete_product_image`
- `cancel_subscription`
- `delete_webhook_endpoint`
- `rotate_webhook_secret`
- `archive_coupon`
- `cancel_subscription_and_report`

## Writes with no `idempotency_key` parameter

The rule is an idempotency key on every write. These tools have no such
parameter at all, so the rule cannot be applied and a retry is genuinely
unsafe. Confirm before the first attempt and do not blind-retry on timeout —
read current state back instead.

- `reorder_product_images` — T2 write
- `test_webhook_endpoint` — T2 external
- `upgrade_webhook_version` — T2 write
- `downgrade_webhook_version` — T2 write
- `replay_webhook_event` — T2 external

## Every tool

| Tool | Group | Annotations (from server) | Tier | `idempotency_key` |
|---|---|---|---|---|
| `ping` | Account | readOnly, idempotent | T0 read | none |
| `get_account` | Account | readOnly, idempotent | T0 read | none |
| `upgrade_account_api_version` | Account | destructive, idempotent | T3 destructive | optional |
| `create_customer` | Customers | idempotent | T2 write | optional |
| `list_customers` | Customers | readOnly, idempotent | T0 read | none |
| `get_customer` | Customers | readOnly, idempotent | T0 read | none |
| `update_customer` | Customers | idempotent | T2 write | optional |
| `delete_customer` | Customers | destructive, idempotent | T3 destructive | optional |
| `list_payment_methods` | Payment Methods | readOnly, idempotent | T0 read | none |
| `add_payment_method` | Payment Methods | idempotent | T2 write | optional |
| `delete_payment_method` | Payment Methods | destructive, idempotent | T3 destructive | optional |
| `create_product` | Products | idempotent | T2 write | optional |
| `list_products` | Products | readOnly, idempotent | T0 read | none |
| `get_product` | Products | readOnly, idempotent | T0 read | none |
| `update_product` | Products | idempotent | T2 write | optional |
| `delete_product` | Products | destructive, idempotent | T3 destructive | optional |
| `delete_product_image` | Products | destructive, idempotent | T3 destructive | optional |
| `reorder_product_images` | Products | idempotent | T2 write | none |
| `list_plans` | Plans | readOnly, idempotent | T0 read | none |
| `get_plan` | Plans | readOnly, idempotent | T0 read | none |
| `create_order` | Orders | idempotent | T2 write | required |
| `list_orders` | Orders | readOnly, idempotent | T0 read | none |
| `get_order` | Orders | readOnly, idempotent | T0 read | none |
| `refund_order` | Orders | destructive, idempotent | T3 destructive | required |
| `retry_order` | Orders | destructive, idempotent | T3 destructive | required |
| `create_subscription` | Subscriptions | idempotent | T2 write | required |
| `list_subscriptions` | Subscriptions | readOnly, idempotent | T0 read | none |
| `get_subscription` | Subscriptions | readOnly, idempotent | T0 read | none |
| `update_subscription` | Subscriptions | idempotent | T2 write | optional |
| `cancel_subscription` | Subscriptions | destructive, idempotent | T3 destructive | optional |
| `list_transactions` | Transactions | readOnly, idempotent | T0 read | none |
| `get_transaction` | Transactions | readOnly, idempotent | T0 read | none |
| `create_webhook_endpoint` | Webhook Endpoints | idempotent | T2 write | optional |
| `list_webhook_endpoints` | Webhook Endpoints | readOnly, idempotent | T0 read | none |
| `get_webhook_endpoint` | Webhook Endpoints | readOnly, idempotent | T0 read | none |
| `update_webhook_endpoint` | Webhook Endpoints | idempotent | T2 write | optional |
| `delete_webhook_endpoint` | Webhook Endpoints | destructive, idempotent | T3 destructive | optional |
| `rotate_webhook_secret` | Webhook Endpoints | destructive, idempotent | T3 destructive | optional |
| `test_webhook_endpoint` | Webhook Endpoints | openWorld | T2 external | none |
| `upgrade_webhook_version` | Webhook Endpoints | idempotent | T2 write | none |
| `downgrade_webhook_version` | Webhook Endpoints | idempotent | T2 write | none |
| `replay_webhook_event` | Webhook Endpoints | openWorld | T2 external | none |
| `list_webhook_events` | Webhook Endpoints | readOnly, idempotent | T0 read | none |
| `list_webhook_delivery_logs` | Webhook Endpoints | readOnly, idempotent | T0 read | none |
| `list_webhook_versions` | Webhook Versions | readOnly, idempotent | T0 read | none |
| `preview_webhook_payload` | Webhook Versions | readOnly, idempotent | T0 read | none |
| `compare_webhook_versions` | Webhook Versions | readOnly, idempotent | T0 read | none |
| `create_coupon` | Coupons | idempotent | T2 write | optional |
| `list_coupons` | Coupons | readOnly, idempotent | T0 read | none |
| `retrieve_coupon` | Coupons | readOnly, idempotent | T0 read | none |
| `update_coupon` | Coupons | idempotent | T2 write | optional |
| `archive_coupon` | Coupons | destructive, idempotent | T3 destructive | optional |
| `unarchive_coupon` | Coupons | idempotent | T2 write | optional |
| `generate_coupon_codes` | Coupons | idempotent | T2 write | optional |
| `list_coupon_codes` | Coupons | readOnly, idempotent | T0 read | none |
| `validate_coupon` | Coupons | readOnly, idempotent | T0 read | none |
| `create_customer_and_subscribe` | Composite | destructive, idempotent | T3 destructive | required |
| `process_order` | Composite | destructive, idempotent | T3 destructive | required |
| `cancel_subscription_and_report` | Composite | destructive, idempotent | T3 destructive | optional |
| `get_customer_financial_summary` | Composite | readOnly, idempotent | T0 read | none |
| `get_revenue_summary` | Composite | readOnly, idempotent | T0 read | none |
| `list_past_due_subscriptions` | Composite | readOnly, idempotent | T0 read | none |
| `refund_transaction` | Composite | destructive, idempotent | T3 destructive | required |
| `setup_webhook_monitoring` | Composite | idempotent | T2 write | optional |
| `create_customer_and_charge` | Composite | destructive, idempotent | T3 destructive | required |
| `refund_and_cancel` | Composite | destructive, idempotent | T3 destructive | required |
| `retry_failed_charge` | Composite | destructive, idempotent | T3 destructive | required |
