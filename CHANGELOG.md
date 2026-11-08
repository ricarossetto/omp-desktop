# Changelog

## 0.3.1 — release ready (not published)

Release-ready version for the planned multiplatform release. **Not published
yet**: no v0.3.1 tag, release asset, package repository, or update channel is
announced until the release gates pass. The latest published release remains
v0.3.0 (Windows x64 only). Version 0.3.1 is the current source version; it is
not final.

### History integrity

- Long histories are no longer projected into an 8 MiB display budget. The
  desktop no longer drops old messages or replaces content with an omission
  marker: messages, tool arguments, results, and `details` cross
  host → main → renderer intact, including after a renderer reload and the
  post-settle sync.
- The host reads the full branch through `get_entries` first and only falls
  back to `get_messages_page`; large snapshot/event payloads are fragmented on
  the JSONL wire and reassembled by the main process instead of being capped.
- The acceptance regression covers a ~29 MiB history with Unicode, a tool with
  deep arguments/result/details, oldest/latest messages in the virtual list,
  renderer reload, and post-settle sync. The OMP transport frame limit still
  applies (1 MB default; host JSONL lines up to 64 MiB), so this is not a
  promise of unlimited history.

### Linux x86_64

Linux x86_64 enters the same planned **v0.3.1** release as Windows; it is
release-ready but not published until the gates. The v0.3.0 published release
remains Windows-only.

### Distribution

- `.deb` for Debian 12/13 and Ubuntu 24.04/26.04 x86_64, installed with
  `sudo apt install ./OMP-Desktop-0.3.1-linux-amd64.deb`; the app goes to
  `/opt/omp-desktop` with `/usr/bin/omp-desktop`, a desktop entry, hicolor
  icons, an AppArmor profile on Ubuntu 24.04+, and `chrome-sandbox` mode 4755
  when user namespaces are unavailable. Git is only a `Suggests`.
- Arch Linux x86_64 package built by `packaging/arch/PKGBUILD` from the local
  `OMP-Desktop-0.3.1-linux-x64.tar.gz`; `makepkg -f` verifies the TAR against a
  trusted SHA-256 from `OMP_DESKTOP_ARCHIVE_SHA256` or `release/SHA256SUMS` (no
  `SKIP`, no release URL) and `sudo pacman -U` installs to
  `/opt/omp-desktop` with `/usr/bin/omp-desktop`, icons, licenses, and
  `chrome-sandbox` mode 4755. Git and Node.js are `optdepends`; there is no AUR
  package.
- Bundled Bun 1.4.4 baseline for Linux at `resources/bun/bun` (mode 0755),
  verified by SHA-256 and `--version`; `scripts/dist-linux.ts` produces the
  `.deb`, the `.tar.gz`, the Arch package when `makepkg` exists, and
  `SHA256SUMS`.
- Linux packages are unsigned. They are release-ready and enter the same
  planned v0.3.1 release as Windows; until the gates, no v0.3.1 asset is
  published.

### Runtime and app

- POSIX runtime: `$SHELL`/POSIX shell fallback in the terminal, XDG paths,
  `/proc`-based process identity and tree termination (a PID or executable
  name alone never authorizes a signal), POSIX path rules gated from the
  Windows drive/UNC/ADS rules, and executable-bit handling for scripts.
- Treat a process that exits while its children are being stopped as already
  stopped, preserving the process creation/identity guards.
- Closing a session during active work uses a short grace period; quitting no
  longer waits on an already-settled session.
- Electron window on Linux with the sandbox enabled (`sandbox: true`, never
  `--no-sandbox`); packaged Bun at `resources/bun/bun`.
- OMP assisted install on Linux: official `linux-x86_64` binary from the
  official build service into `$HOME/.local/bin/omp` (or `PI_INSTALL_DIR`),
  SHA-256 and `omp --version` verified, mode 0755, never overwriting an
  existing file. Manual command: `curl -fsSL https://omp.sh/install | sh`.
- Optional Node.js LTS on Linux: official `linux-x64` TAR.GZ into
  `$XDG_DATA_HOME/omp-desktop/tools/node` (default
  `~/.local/share/omp-desktop/tools/node`), SHA-256 from the official
  `SHASUMS256.txt`, safe TAR extraction, and only `<tools>/node/bin` added to
  the app process PATH. The official binary needs `libatomic.so.1`
  (`libatomic1` on Debian/Ubuntu, `libatomic` from `gcc-libs` on Arch); the app
  reports the missing library with the package command.
- Git on Linux stays native: the app never downloads MinGit and never runs
  `sudo`, `apt`, or `pacman`. **Install Git** shows `sudo apt install git` or
  `sudo pacman -S git` for the user to run, then re-probes.
- Diagnostics and onboarding are platform-aware: the OMP install path, the Git
  instructions, the signing text, and the missing-library error follow the
  current platform.

## Unreleased

No changes after 0.3.1 yet.

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
