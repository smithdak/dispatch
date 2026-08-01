# Security policy

Dispatch is prerelease software. Security reports are evaluated against the latest
published prerelease; there is no long-term support policy yet. See
[Project status](../docs/project-status.md) for the current runtime and qualification
boundary.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/smithdak/dispatch/security/advisories/new)
and include:

- the Dispatch version, operating system, and installation method;
- the affected command or integration;
- the security impact and the smallest reproducible case you can provide; and
- whether the report involves prompt content, credentials, repository data, or local
  process boundaries.

Remove live secrets and personal data from logs or evidence. If a safe reproduction is
not possible, describe the conditions and expected impact without attaching sensitive
material.
