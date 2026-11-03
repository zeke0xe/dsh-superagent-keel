# dsh-superagent + Keel

This is a fork of DeepSeek's [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT) with three additions. Everything else — the Router/Worker design, Sources, Threads, the panel — is DeepSeek's work; see the original [README](README.md).

## 1. Changes of mind are consistent ([Keel](https://github.com/zeke0xe/keel))

The original lets you talk to the agent while it works. This fork makes sure that what you say **wins over work already in flight**:

- Every Assignment runs as a Keel work packet scoped to its ticket, holding grants `write`, `comment`, `open_pr`, `push`.
- When you change what you asked for — in Feishu, a GitHub comment, wherever the agent listens — the main Session or the worker calls `orchestrator_change` with your message. The host checks that the message is yours and that you may ask for work; a bot, a quoted text or a web page cannot change the request.
- The change becomes a new delegation version. Affected workers are **interrupted at once** and restart with a notice of what is now in force; "stop changing code" revokes `write`, `push` and `open_pr` in the same transaction.
- Anything a worker queued **before** the change is refused at the send gate (`premiseChanged`), so an answer built on the old request never reaches you.

Live test (GitHub issue in a private test repo): asked for "a full improvement plan with code and tests"; seven seconds after the agent started, changed it to "just one sentence on what's wrong with median". The worker recorded the change itself, its first packet was stopped, a new packet started at delegation v1, and the only answer posted was the one sentence.

## 2. A hardened worker sandbox (macOS)

Upstream runs workers with `danger-full-access`. Here workers run under `workspace-write` and `scripts/hardened/sandbox-exec`, which keeps DSH's Seatbelt profile and adds: no reads under your home except the ticket's checkout and installed tools; credentials and the state database unreadable even if you widen the read list; no keychain; no connection to the local management port or to Unix sockets (SSH agents). Workers have no host-side file tools (they resolve symlinks outside the sandbox) and no subagents. A stopped ticket's leftover processes are found and killed, even those that left their process group. All of it is covered by tests that attack a fake home directory.

## 3. A submission gate for outbound messages

Every message passes one gate: a fingerprint of target and text taken at queue time, voiding of messages queued before a person stopped the ticket, per-conversation and hourly limits that survive restarts, and **at most one request per message** — a lost answer is looked up by its hidden marker, never re-sent.

Optional: a [Jev](https://docs.typesafe.ai) shadow judge records a calibrated intake/injection/impact judgment for every trigger without deciding anything, and raises a panel alert on likely prompt injection.

## Setup

As upstream ([SETUP.md](SETUP.md)), then start with `scripts/dsh-superagent start`. Tests: `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost pnpm check`.
