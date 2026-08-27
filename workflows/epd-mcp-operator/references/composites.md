# Composite tools — what they chain, and when not to use them

<!-- TODO (step 17). All 11 composite tools, what primitives each replaces, and
     the rollback-note shape returned on partial failure. -->

## The eleven

<!-- TODO: table of tool | primitives it chains | tier | when to prefer it.

       create_customer_and_charge        BROWSER ONLY - needs card_token
       create_customer_and_subscribe     BROWSER ONLY - needs card_token
       process_order
       cancel_subscription_and_report
       get_customer_financial_summary
       get_revenue_summary
       list_past_due_subscriptions
       refund_transaction
       refund_and_cancel
       setup_webhook_monitoring
       retry_failed_charge                                                  -->

## When a composite beats the primitives

<!-- TODO: the server's own instructions block says composites are
     correctness-tested and idempotency-safe, and to prefer them when one
     matches the user's intent. Fewer round trips against the 60/min bucket,
     and one idempotency_key covering the whole logical operation rather than
     one per step. -->

## The onboarding exception

<!-- TODO: this is the section that matters most.

     Both onboarding composites require card_token (^cct_[0-9a-f]{48}$), which
     only the EPD Elements SDK in a browser can mint. There is no fixture token
     and no server-side way to produce one, so a headless agent cannot call
     either tool — the server's "prefer composites" hint leads straight into a
     wall.

     The server-side path is the primitives:

       1. create_customer             (MCP)   -> customer_id
       2. POST https://secure.epd.com (REST)  -> payment_method_id
          body: {"customer_id": ..., "card": {number, exp_month, exp_year, cvc}}
       3. create_order | create_subscription  (MCP, with payment_method_id)

     Verified end to end in sandbox on 27 Aug: order 1DVZHHMB, succeeded.

     Note step 2 leaves the MCP surface. secure.epd.com is PCI-scoped and takes
     raw card data; the MCP tools deliberately never do. Say so plainly. -->

## Partial failure and rollback notes

<!-- TODO: composites return a structured failure with rollback notes when a
     step fails partway. Show the shape, and the rule: read the rollback note
     before retrying, because some steps may have committed. Relevant codes
     include partial_rollback_failed and created_resources. -->
