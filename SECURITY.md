# Security Policy

## Reporting a vulnerability

If you discover a security issue in this repository — for example, a skill
example that leaks a secret, a CI workflow with an unsafe permission, or
guidance that would lead an integrator to a vulnerable pattern — please do
**not** open a public GitHub issue.

Email **merchantsuccess@easypaydirect.com** with:

- A clear description of the issue and where it lives in the repo
  (file path, line number).
- A proof-of-concept or reproduction, if applicable.
- Your name and a contact address for follow-up.

You will receive an acknowledgement within **3 business days**. We aim to
publish a fix or advisory within **30 days** of confirming the report,
faster for issues with active exploitation impact.

## Reporting a vulnerability in the EPD Commerce platform itself

This repo only houses agent skill content. To report a vulnerability in
the EPD Commerce API, gateway, dashboard, or webhook delivery
infrastructure, contact EPD Commerce support through your account or
email **merchantsuccess@easypaydirect.com**.

## Scope

In-scope for this repository:

- Skill content (`SKILL.md`, references, scripts) that ships secrets,
  promotes insecure patterns, or instructs the user to disable security
  controls.
- Tooling (`scripts/validate.js`, CI workflows, dependency manifests).
- Infrastructure-as-code in `.github/`.

Out-of-scope here (report to product security instead):

- Bugs in `api.epd.com` or any merchant-facing EPD Commerce surface.
- Issues in the EPD Commerce MCP server implementation.
- Account-level access issues for live merchants.

## Supported versions

Security fixes land on `main` and ship in the next tagged release. Older
tags are not patched — pin a tag if you need reproducibility, but track
`main` for security currency.
