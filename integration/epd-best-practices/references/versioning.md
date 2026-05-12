# Versioning — pinning, deprecation, migration

EPD Commerce uses **dated versions** (`YYYY-MM-DD`), not semver. The date is
the release date. Once a version is published its behavior is frozen — new
behavior ships in a new dated version. Version bumps are always
forward-only.

## Why pin

Every merchant account has a **default API version**. When a request omits
the `EPD-Version` header, the merchant's account default is used — meaning a
single dashboard upgrade can change the behavior of every running
integration that doesn't pin its own version.

Pin on every request from a single constant in your codebase:

```
EPD-Version: 2026-02-11
```

When you upgrade, you bump that constant in one place, run your test suite,
and roll out — independently of when the merchant upgrades their account
default.

## Response headers EPD Commerce sends

| Header        | When                                                | Action                                              |
|---------------|-----------------------------------------------------|-----------------------------------------------------|
| `EPD-Version` | Always — echoes the resolved version                | Confirm it matches what you sent                    |
| `Deprecation` | Your version is deprecated (RFC 9745)               | Plan an upgrade                                     |
| `Sunset`      | Your version has a hard removal date (RFC 8594)     | Upgrade before this date or requests start failing  |

If your monitoring sees `Deprecation` or `Sunset` headers, surface them as
alerts. They're how EPD Commerce tells you upgrade work is needed.

## Deprecation policy

- A version stays **current** for at least 12 months after release.
- After deprecation, it's supported for at least 12 more months before sunset.
- `Sunset` response header carries the hard removal date.

Plan upgrade work to land **at least 6 months before the sunset date** so
you have margin for unexpected issues.

## Migration playbook

> **Status (2026-05-08):** only one published version exists (`2026-02-11`).
> The steps below are the playbook for when the next dated version ships.

### 1. Read the diff

The version diff lists new endpoints, removed endpoints, changed
request/response schemas, new error codes, and new event types. Most version
bumps are additive (new optional fields) and require no code changes.

Breaking changes typically fall into:

- **Renamed field** — update the mapping.
- **Removed field** — pick the replacement (the changelog names it).
- **Type change** — e.g. `string` → `enum`. Update validation.
- **Removed error code** — your `switch` on `error.code` has dead branches.

### 2. Test against the new version

Run your integration tests with `EPD-Version` set to the target version
against the **sandbox**. Don't upgrade production without test coverage.

```ts
const EPD_API_VERSION = process.env.EPD_API_VERSION ?? '2026-02-11';
```

Override in CI for the upgrade-validation run.

### 3. Roll out by environment

```
1. Pin to new version in CI tests       (validate)
2. Pin to new version in staging        (smoke test for a few days)
3. Pin to new version in production     (one constant change, deploy)
4. (Separately) upgrade the account default in the dashboard
```

Step 4 is independent — you can run pinned to the new version without
touching the account default. The account default matters only for any
unpinned integrations (third-party tools, dashboards) that hit your account.

## Webhook endpoints version separately

Each webhook endpoint has its own pinned event schema version. Upgrading
your REST API version does **not** automatically upgrade webhook payload
schemas — those are a separate operation. See the `epd-webhooks` skill for
the webhook-specific flow.
