# Security Policy

## Reporting a vulnerability

Please report security issues in this driver privately — do **not** open a
public GitHub issue.

- Email: [security@testingbot.com](mailto:security@testingbot.com)
- Or use GitHub's [private vulnerability reporting](../../security/advisories/new)
  on this repository.

We aim to acknowledge reports within 2 business days. Please include a
description of the issue, steps to reproduce, and the driver version.

For vulnerabilities in the TestingBot platform itself (hub, API, dashboard),
see [testingbot.com/security](https://testingbot.com/security).

## Supported versions

Only the latest published version of `@testingbot/mobilewright-driver`
receives security fixes.

## What this package handles

The driver sends your TestingBot API key/secret to `hub.testingbot.com` and
`api.testingbot.com` over HTTPS only, and uploads the app binaries you
configure to TestingBot storage. Credentials are read from options or
environment variables and are never written to disk or logs (`DEBUG` output
redacts `tb:options`). Releases are published from GitHub Actions via npm
trusted publishing (OIDC) with provenance attestations — you can verify a
release's provenance on its npm package page.
