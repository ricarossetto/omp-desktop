# Changelog

## 0.3.0 — 2026-11-07

First public release of OMP Desktop for Windows x64. Independent project, not
affiliated with the OMP authors.

### Interface and usage

- Bancada interface with a custom title bar, navigation history, resizable
  panels, light and dark themes, and drawers in narrow windows.
- Brazilian Portuguese, US English, and Simplified Chinese, with persisted
  language.
- Five-step first-run assistant: welcome, environment, accounts, default model,
  and first project.
- Account and provider search. `Esc` clears a filled search; with an empty
  search, it closes Settings.
- General palette separated from the skills and MCP command list.
- Message queue, steering during work, and pause after the current tool, with
  explicit resume.
- Optional Git and Node.js LTS setup from the app, with explicit confirmation,
  official sources, SHA-256 verification, per-user managed folders, no
  administrator rights, no overwrite of global tools, and no persistent
  PATH/registry changes; new terminals and OMP child processes see the tools
  without restarting running agents.

### Fixes

- Scrolling long histories without a React update loop.
- Restoring sessions and conversations without resending prompts.
- Work state consistent with the OMP process, with the Stop button available
  during execution.
- Approvals answered once; cancellation, timeout, and closing never approve
  actions.
- Saving settings without false conflicts between global and project values.
- Empty catalog and quota failure in the first-run assistant without polling
  loops.
- Unknown usage shown as unavailable; session cost kept separate from
  subscription quotas.
- Terminal state contrast and theme switching without background interpolation
  that is incompatible with button text color.
- The 600 KiB attachment limit matches the transport.
- DOMPurify 3.4.17 applied to the dependency and to the internal copy used by
  Monaco.

### Distribution

- Complete READMEs in three languages, third-party notices, and dependency
  analysis in [docs/release-security.md](docs/release-security.md).
- Per-user NSIS installer with bundled Bun. The OMP executable is not bundled;
  the first-run assistant can install the pinned official Windows binary
  (18.16.0) after an explicit click, verifying SHA-256 and `--version` without
  overwriting an existing file.
- SHA-256 published next to the installer. No digital signature and no
  automatic update.

![OMP Desktop interface](docs/screenshots/conversa-runner.png)
