# Architecture decisions

These records explain accepted choices and their consequences. The
[architecture specification](../../arch.md) remains the system-level explanation.

| Decision | Question answered |
| --- | --- |
| [ADR 0001 — Stage 0 contracts](0001-stage-0-contracts.md) | What is authoritative, rebuildable, isolated, and required for the first durable-session slice? |
| [ADR 0002 — Windows primary target](0002-windows-primary-target.md) | Which operating system is the primary v1 qualification target, and why? |
| [ADR 0003 — Herdr Windows orchestration](0003-herdr-windows-orchestration.md) | Which retained-terminal backend does Stage 1 use, and where is the adapter boundary? |
| [ADR 0004 — Herdr namespaces and restart generations](0004-herdr-namespaces-and-restart-generations.md) | How are server namespaces and post-restart terminal generations identified and recovered? |
| [ADR 0005 — Private Herdr prompt transport](0005-private-herdr-prompt-transport.md) | How can Dispatch submit a prompt without placing its body in argv or the ledger? |

Return to the [documentation index](../README.md).
