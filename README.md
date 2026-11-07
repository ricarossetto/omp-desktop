<div align="center">

# OMP Desktop

**OMP, now with a window.** Projects, sessions, runners, approvals, Git, and a terminal in one Windows app.

![Windows x64](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Bun](https://img.shields.io/badge/Bun-1.4-000000?logo=bun&logoColor=white)
![Version](https://img.shields.io/badge/version-0.3.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Languages](https://img.shields.io/badge/languages-pt--BR%20%7C%20en--US%20%7C%20zh--CN-blue)

[English (US)](README.md) · [Português (Brasil)](docs/README.pt-BR.md) · [简体中文](docs/README.zh-CN.md)

![OMP Desktop interface in English](docs/screenshots/overview-en-US.png)

</div>

---

> **Independent, unofficial project**
>
> OMP Desktop is an independent desktop client for [OMP](https://omp.sh) (oh-my-pi). It is not part of the OMP project and is not maintained or endorsed by its authors. The agent, models, credentials, and sessions all come from the OMP installation on your machine.
>
> The app does not use OpenCode as its engine, and no OpenCode code or trademark was copied. Third-party components and their copyright notices are listed in [`resources/licenses`](resources/licenses/NOTICE.txt).

## Contents

- [What it is](#what-it-is)
- [What it does not do](#what-it-does-not-do)
- [Release status](#release-status)
- [First run](#first-run)
- [Installation](#installation)
- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Languages](#languages)
- [Where your data lives](#where-your-data-lives)
- [Development](#development)
- [Architecture](#architecture)
- [Security and privacy](#security-and-privacy)
- [Error recovery](#error-recovery)
- [Known limitations](#known-limitations)
- [Contributing](#contributing)
- [License and third-party components](#license-and-third-party-components)

## What it is

OMP Desktop is a Windows desktop application that gives OMP a real window. It **does not reimplement the agent**: every active session starts your own `omp --mode rpc-ui` process, in the project directory, with the same model, credentials, presets, and sessions you already use in the terminal. The app talks to that process over RPC and shows the conversation, runners, approvals, and changes.

In practice, the app is a window: the work is still done by the OMP installed on your machine. The desktop handles the interface, process lifecycle, terminal, Git panel, and project organization — not the agent's reasoning.

- **Windows x64** desktop app built with **Electron 45**, **React 19**, and **Bun 1.4**.
- OMP handles the agent's reasoning and tool calls. Git actions, attachment handling, the PTY, and window management run locally in the Electron main process.
- No data migration: OMP sessions and configuration stay where OMP keeps them (`~/.omp`).
- First public release: **v0.3.0**. The project is pre-1.0: configuration keys, UI details, and internal contracts may change between releases.

### What it does not do

- **It is not another agent.** There is no built-in model and no second implementation of OMP.
- **It does not install OMP silently.** If OMP is missing on first run, the assistant offers an official installation after an explicit click; nothing is installed when the component mounts. You can also point to an existing `omp.exe` at any time.
- **It does not approve anything on its own.** Commands, targets, and details are visible before any confirmation.
- **It does not resend prompts.** When you reopen the app or recover from a crash, tabs return with their history, but nothing is sent again without your action.
- **It is not a fork of OMP.** This project is an independent desktop client.

## Release status

The current version is **0.3.0**, the first public release. Download it from [github.com/ricarossetto/omp-desktop/releases/latest](https://github.com/ricarossetto/omp-desktop/releases/latest) (tag `v0.3.0`).

The installer is **Windows x64**, per-user, without administrator rights, and **not digitally signed**. There is no auto-update: to upgrade, download the new installer and install it over the current version. v0.3.0 is the start of the public cycle; treat it as software in progress, not as 1.0.

## First run

On first launch, a five-step assistant prepares the environment:

1. **Welcome** — explains that the app uses your OMP, that nothing is approved on its own, and that tabs return without resending prompts. It also warns that the installer is unsigned.
2. **Environment** — checks OMP, the RPC protocol, the host Bun, Git, and the terminal/shell. If OMP is not found, the step offers **Install OMP**: nothing runs until you click **Install OMP**, the installation reports progress (resolving, downloading, verifying, activating) and ends in success or an actionable error, and on success the app detects the real executable and updates diagnostics without restarting, reopening the flow, or losing your draft or language. If installation fails, **Select omp.exe** remains available. The step also shows optional **Git** and **Node.js LTS** actions; neither is required to continue. The install methods are described in [Installing OMP from the app](#installing-omp-from-the-app) and [Installing optional tools](#installing-optional-tools).
3. **Accounts** — shows the usage OMP already knows, without displaying tokens. To add another account, open a project and use **Settings → Accounts**; login only starts with a click from you.
4. **Default model** — lists the models announced by OMP and lets you choose the global default. If the configuration changes outside the app, nothing is overwritten: the values are reloaded and you choose again.
5. **Theme and project** — chooses dark, light, or match Windows, shows the shortcuts, and lets you open your first folder. Finishing without opening a folder only closes the introduction; no project is created.

After that, open a folder, create a session, and start talking. Settings live in the command palette (`Ctrl+K`) and the gear icon.

## Installation

| Item | Detail |
| --- | --- |
| System | Windows x64 (Windows 10 or 11) |
| Installer | `OMP-Desktop-0.3.0-setup.exe` (NSIS, x64) |
| Scope | per-user; does not request administrator rights |
| Signature | unsigned; SmartScreen may warn |
| Bun | bundled at `resources/bun/bun.exe` |
| OMP | not bundled; first run can install the pinned official Windows x64 binary (18.16.0) after an explicit click, or you can select an existing `omp.exe` |
| Git | optional; only needed for the Changes panel; the app can install the official MinGit build on request |
| Node.js | optional; only needed for projects/MCP and the official npm; the app can install the current Node.js LTS on request |
| Updates | manual; there is no auto-update |

**OMP version support:** The validated baseline is 18.16.0, and the assisted installer pins exactly 18.16.0. The host accepts OMP major version 18 or newer; OMP 17 or older is rejected as incompatible. Versions newer than the 18.x series are accepted but marked as not validated.

1. Download the installer from the [latest release](https://github.com/ricarossetto/omp-desktop/releases/latest) (tag `v0.3.0`).
2. If the release publishes a SHA-256, verify the file before running it (see below).
3. Run the installer. It installs into the user folder and does not request elevation.
4. Open OMP Desktop. The assistant checks the environment. If OMP is not found, choose **Install OMP**, or point to an existing `omp.exe`.
5. Open a project folder and create your first session.

The installer **does not include the OMP executable**. It includes the Bun runtime used by the local service and the `@oh-my-pi/pi-coding-agent` dependency (MIT), which is a host library — the agent remains the `omp.exe` from your installation or from the assisted install. Git and Node.js LTS are not bundled; both are optional and can be installed from the app. Without Git, the Changes panel explains the absence and does not simulate a repository; the rest of the app keeps working.

### Installing OMP from the app

If OMP is missing, the first-run assistant and the diagnostics screen offer **Install OMP**. After an explicit click on **Install OMP**, the app:

- resolves the pinned **18.16.0** Windows binary through the same official build service used by OMP's Windows installer (`build.stencil.so`), for the current architecture (`windows-x86_64` on the x64 build);
- downloads it over HTTPS to `%LOCALAPPDATA%\omp\omp.exe`, honoring `PI_INSTALL_DIR` like the official installer, without administrator rights;
- verifies the SHA-256 published by the official service and runs `omp.exe --version`, requiring the exact pinned version before using the file;
- never overwrites an existing `omp.exe`: a compatible file is adopted, and an incompatible one is reported as a conflict while manual selection remains available.

On first launch without OMP, the app opens Diagnostics directly; the onboarding Environment step shows the same action. The app does not modify the persistent user PATH or the registry: it stores the absolute path in its own runtime state and adds the folder only to the PATH of its own processes (host and terminal). It does not touch `~/.omp`. Concurrent clicks share one installation, and closing the app during installation aborts the download and removes temporary files.

The bundled Bun is only the local host runtime; the OMP binary is standalone, so no global Bun installation is required. The renderer cannot supply a URL or command: the download host, file name, version, and arguments are fixed in the main process. On success, the app applies the detected path and updates onboarding/diagnostics without restarting or losing the draft or language. Network, checksum, version, write, activation, and cancellation errors are shown with a retry path (an activation failure keeps the installed binary), **Check again** re-probes the environment, and **Select omp.exe** remains available.

You can also install OMP manually by following the official instructions at [omp.sh](https://omp.sh) and then choosing **Select omp.exe**; a global Bun is not required for the standalone binary.

### Installing optional tools

Git and Node.js LTS are optional. The app, OMP, and onboarding work without either; Bun is already bundled, and OMP does not require a system Node.js. The Environment step, Diagnostics, and **Settings → General** show the **Optional developer tools** section with the status of Git and Node.js LTS. **Install Git** or **Install Node.js LTS** shows a **Before installing …** confirmation; the download only starts after **Download and install**.

**Git (Changes panel).** The app installs the official Git for Windows [MinGit](https://gitforwindows.org/mingit.html) **2.56.0.windows.4** ZIP (the distribution Git for Windows documents for embedding) into `%LOCALAPPDATA%\omp-desktop\tools\git`, without an installer, administrator rights, winget, or MSI. It verifies the published SHA-256, extracts the ZIP safely, and runs `git.exe --version` before using it. The app adds `...\tools\git\cmd` only to its own process PATH. Manual alternative: [git-scm.com/download/win](https://git-scm.com/download/win).

**Node.js LTS (projects/MCP).** The app installs the **current Node.js LTS resolved from [nodejs.org](https://nodejs.org) at install time** (v26.13.0 at release) from the official Windows ZIP into `%LOCALAPPDATA%\omp-desktop\tools\node`, without an installer or administrator rights, including the official npm and npx. It verifies the SHA-256 from the official `SHASUMS256.txt`, extracts safely, and probes the executable before use. The app adds that folder only to its own process PATH. It does not install project or MCP dependencies; npm is available for you to run them. Manual alternative: [nodejs.org/en/download](https://nodejs.org/en/download).

Both installs are per-user and do not modify the persistent user or system PATH, the registry, or an existing global Git/Node.js installation. A compatible global tool on PATH is detected and adopted as-is; an incompatible or partial managed folder is reported, not overwritten. New terminals and newly spawned host/OMP child processes see the tools; running agents and terminals are not restarted or interrupted, and the next local service start also picks them up. Installations report progress (resolving, downloading, verifying, extracting, activating) and end in success or an actionable error with **Try again**; **Check again** re-probes the environment. After success, the row shows the installed version and location. Concurrent clicks share one installation per tool, and closing the app aborts the download and cleans up temporary files.

The renderer cannot supply a URL, version, command, or folder: sources, versions, destinations, and arguments are fixed in the main process. **Cancel** aborts the download and leaves the existing installation untouched. You can also install Git or Node.js manually from the official pages and use **Check again**.

### SmartScreen and installer verification

The installer is not digitally signed. Windows may show a SmartScreen warning; this is expected in this version.

- **Do not disable** SmartScreen, antivirus, or the Windows execution policy to install. If the warning blocks you, verify the origin and the hash; do not bypass the protection.
- Download only from the official repository and confirm that the file came from the expected release.
- If the release publishes a SHA-256, compare it with the output of:

```powershell
Get-FileHash .\OMP-Desktop-0.3.0-setup.exe -Algorithm SHA256
```

If the hash does not match, do not run the file.

### Uninstall

Uninstalling removes the application. Data in `%APPDATA%\omp-desktop` and the `~/.omp` profile **are not deleted automatically**; remove them manually if you want to. The uninstaller does not promise to clean everything up. **Do not delete `~/.omp` just to uninstall the desktop app**: that profile belongs to OMP and holds accounts and sessions also used outside this app.

## Features

### Projects and sessions

- Open any folder as a project; recent projects are saved. A missing folder appears as unavailable and can be relocated. Removing a recent project never deletes files.
- The session list comes from OMP itself, without creating a parallel copy of the history.
- **One active session = one OMP process**, in the project directory. Switching tabs does not interrupt an agent that is working.
- A session in use by another process is not taken by force: the app warns you and offers to open another one.
- When you reopen the app, tabs return with the same conversation. **No prompt is resent**, even after a crash.
- The title bar has session history (Back/Forward, `Alt+←`/`Alt+→`), search, and a theme toggle. The sidebar shows the Git branch and the change count when the project is a repository.

### Conversation

- Markdown with tables (GFM), no raw HTML; code blocks with a copy button, collapsible thinking, and images. Remote images become links because of the CSP; local images and attachments appear in the conversation.
- Tool cards with intent, arguments, partial output in real time, result, and error. Very large results are paginated in the interface and, when they exceed the transport budget, appear with an explicit omission marker — the full data remains stored in OMP.
- Long history is virtualized, with **Jump to answer** while you are reading older messages.
- `Enter` sends, `Shift+Enter` inserts a line break, and IME composition is respected. The draft and attachments are discarded only after OMP confirms receipt; if sending is refused, they remain.
- During a response, you choose: **Interrupt with steering** (delivered on the next step) or **Send after** (a queue with remove/promote). **Stop** recovers drafts and attachments from the queue.
- **Pause after current step** waits for the running tool to finish and returns control without losing anything; **Continue** resumes with an explicit message, without resending the previous one.
- **Rewind to here** and **Fork** act only on the conversation: no project file is restored, deleted, or changed. Later history remains in the OMP tree.
- Conversation export to HTML from the command palette.
- In the composer, `/` opens the commands OMP announces; skills, MCP, and extensions are still executed by OMP. The palette (`Ctrl+K`) has a general mode and a mode restricted to skills/MCP.
- Attachments through the button, drag and drop, or pasted image. Text files enter as a delimited block with name and content; PDFs and binaries become file references, not content sent to the model. The limit is **600 KiB per attachment**, because the whole prompt must fit in one OMP frame; the frame limit is checked before sending and nothing is silently truncated.

### Runners, tasks, and goal

- A panel shows each runner: agent, task, state, and **effective model**, separate from the configured model. If OMP does not report the effective model, **Model not reported** appears.
- Click to read the runner transcript incrementally. Completed cards remain accessible **after closing and reopening the app**.
- Cancel (with confirmation) or steer a specific runner; the others are unaffected.
- Tasks (`todo`) with blocked/abandoned states and goal control (`goal`): create, pause, resume, and discard.

### Approvals

- `select`, `confirm`, `input` (masked, with a reveal option), `editor`, and `ask` with multiple questions, multi-select, and a free-form answer.
- **The app never approves anything on its own.** Details, target, and command are visible before the decision.
- Each request is answered once; canceling or letting the deadline expire never becomes approval. When OMP has its own timeout for `ask`, the interface warns that it may proceed with the recommended options.
- Closing the session or losing the process cancels the request explicitly. Reloading the window does not lose a pending approval.

### Models, roles, and presets

- The active model (`set_model`), persisted roles (`modelRoles`), and presets (`modelPresets`) appear separately. The active model belongs to the session; roles and presets show the origin layer (global or project) and the effective value.
- Reasoning shows only the levels OMP announces; if the change fails, the previous choice is preserved.
- Applying a preset uses OMP's own `/modelpreset` command. If the version does not announce the command, the app warns and keeps the current preset.
- Editing has conflict detection: if another window or the terminal changed the value, nothing is overwritten; the screen reloads and you decide again.

### Accounts and usage

- Providers and connected accounts, with usage per window reported by OMP (for example, 5 hours, weekly, and monthly, when the provider announces those labels) through `omp usage --json`.
- Unknown usage appears as **Unavailable**, never as 0%. Session cost is labeled **estimated**, comes from `get_session_stats`, and is neither a charge nor a percentage of the subscription.
- Adding an account only after an explicit click. OAuth login happens in the external browser; when the provider requires interactive input, the app shows a command to run in the app terminal. Disconnecting asks for confirmation. Tokens never reach the interface.
- Search accounts and providers within the tab.

### Changes and Git

- Repository status with renames, untracked files, binaries, names with Unicode and spaces, and a repository without commits.
- **Working** and **index** diffs in the Monaco editor, local and without a CDN.
- Stage and unstage per file without touching the working tree. Commit only with a typed message and a click; a hook failure is shown and the files remain intact.
- No `push`, `reset`, `clean`, or automatic discard. Outside a repository, the panel explains the situation and does not run `git init`.
- Git is optional. If it is missing, the panel explains the absence; the optional install action is available in Diagnostics and **Settings → General**. No repository is simulated.

### Integrated terminal

- A real PTY through node-pty (ConPTY on Windows) with xterm: PowerShell when available, then `pwsh`, and finally `cmd.exe`. Resize and `Ctrl+C` work, the working directory is the project folder, and output is not sent to the model automatically.

### Interface, theme, and languages

- Dark, light, or match Windows theme; resizable panels with persisted sizes.
- Below 1000 px, the sidebar and the right panel become drawers; the conversation is never squeezed.
- Visible focus, keyboard navigation, accessible labels, and respect for `prefers-reduced-motion`.
- Portuguese (Brazil), English (US), and Simplified Chinese. The app follows the Windows language on first run; the choice lives in **Settings → General → Language**. Identifiers, commands, paths, and model names are not translated.

### Accessibility and quality

The interface was built with visible focus, keyboard navigation, accessible labels, and respect for reduced motion. Automated acceptance includes axe-core checks, but **automated reports have limits**: they do not replace testing with screen readers or validation with users. The project does not claim WCAG conformance and does not claim that the interface has been tested with screen readers.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Command palette and session search |
| `Ctrl+M` | Model and reasoning selector |
| `Ctrl+Shift+P` | Open project |
| `Ctrl+N` | New session |
| `Ctrl+B` | Toggle sidebar |
| ``Ctrl+` `` | Open or close the terminal |
| `Alt+←` / `Alt+→` | Back/forward through session history |
| `Esc` | Closes the palette, model selector, or settings; with an approval open, cancels the request (never approves); with nothing open and outside a text field, stops the agent |
| `Ctrl+Enter` | Sends in the dialog editor (`Enter` inserts a line break) |
| `Enter` / `Shift+Enter` | Send / insert a line break in the composer |

The `Ctrl+K` palette has two groups: the app's own actions and the OMP commands. The `/` palette in the composer lists the skills, MCP, and extension commands announced by OMP; all of them are executed by OMP.

## Languages

The app speaks Portuguese (Brazil), English (US), and Simplified Chinese. Dates and numbers follow the chosen language. Commands, identifiers, paths, and model names remain as OMP announces them.

## Where your data lives

| Location | What lives there |
| --- | --- |
| `%APPDATA%\omp-desktop` | Desktop state: recent projects, tabs, layout, theme, window, attachments, logs, and the `host-data` subfolder of the local service |
| `%LOCALAPPDATA%\omp-desktop\tools\git` | Managed Git installed by the app (optional) |
| `%LOCALAPPDATA%\omp-desktop\tools\node` | Managed Node.js LTS and npm installed by the app (optional) |
| `~/.omp` | OMP profile: configuration, credentials, sessions, presets, and profiles |
| Project folder | Project files and the Git repository, when one exists |

The app does not copy credentials into the project or the repository. When opening issues, PRs, or screenshots, **do not include** credential files, personal logs, paths containing a username, emails, or account IDs.

## Development

Requirements: Windows x64, Bun 1.4+, and Node.js available for the Electron download step. OMP must be installed to test the app for real; Git is optional.

The Node.js used to download Electron is a development requirement. It is separate from the optional Node.js LTS that the app can install for projects/MCP; the app does not require a system Node.js to run.

```powershell
git clone https://github.com/ricarossetto/omp-desktop.git C:\dev\omp-desktop
Set-Location C:\dev\omp-desktop
bun install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
bun run dev
```

| Command | What it does |
| --- | --- |
| `bun run dev` | Builds the host and opens the app in development mode |
| `bun run build` | Generates `out/` (main, preload, renderer, and host) |
| `bun run start` | Opens Electron from the build |
| `bun run build:host` | Builds only the Bun host |
| `bun run typecheck` | Type check |
| `bun run test` | Unit tests |
| `bun run test:acceptance` | Build + acceptance in real Electron with the test OMP (`tests/fixtures/fake-omp.ts`), without spending quota |
| `bun run dist:win` | Generates the NSIS x64 installer in `release/` |
| `bun run smoke:installed -- --exe "<path>\OMP Desktop.exe" --cwd "<folder>"` | Starts the installed app outside the checkout, with a temporary `userData` |

The real smoke test uses the real OMP and **consumes quota** (one prompt with a runner). Run it deliberately:

```powershell
$env:REAL_OMP = "1"
bunx playwright test real-smoke
Remove-Item Env:REAL_OMP
```

The normal acceptance test uses the test OMP and does not spend quota. The real smoke test should not run in public CI without credential and quota control.

Because the project pins `@oh-my-pi/pi-coding-agent` at 18.16.0, when running with Bun the `node_modules/.bin` can enter `PATH` and a local OMP shim may take precedence over the global `omp`. To point to the system OMP, use `OMP_DESKTOP_OMP_PATH` or select `omp.exe` in diagnostics. The project baseline is 18.16.0; versions newer than the 18.x series are marked as not validated.

Automated checks cover repeatable behavior only and do not replace manual verification in a real environment. Before submitting a change, run at least the type check, unit tests, and acceptance tests; for UI changes, attach a screenshot of the real window.

## Architecture

```mermaid
flowchart LR
  R["Renderer<br/>React 19, no Node"] -- "window.ompDesktop<br/>invoke / subscribe" --> M["Electron main<br/>validated IPC, PTY, Git, files"]
  M -- "private JSONL" --> H["Bun host<br/>sessions, runners, attachments, config"]
  H -- "rpc-ui" --> O1["omp (session A)"]
  H -- "rpc-ui" --> O2["omp (session B)"]
```

```text
src/
  main/       window, IPC, PTY, Git, files, and host lifecycle
  host/       Bun service: RPC transport, sessions, runners, attachments, config
  renderer/   React 19: screens, conversation, panels, and dialogs
  preload/    the only bridge exposed to the renderer
  shared/     zod contracts and session reducer
scripts/      host build, installer, and installed-app smoke
tests/        unit tests, acceptance with test OMP, and real smoke
resources/    icon and license notices
docs/         screenshots and documentation
design/       visual and interaction brief
```

The contracts live in `src/shared/contracts.ts`; the pure reducer `applyEvent` in `src/shared/session-state.ts` is used by both the host and the renderer. Screens, states, and tokens are in [`design/opendesign-brief.md`](design/opendesign-brief.md).

The renderer has no Node, filesystem, or shell; only `invoke` and `subscribe`. Main talks to the host over private JSONL, and the host keeps one `omp --mode rpc-ui` process per active session, with `--resume <sessionPath>` when reopening and `--profile` when applicable. Protocol v2 is negotiated when available; the default frame is 1 MB and attachments are limited to 600 KiB to fit in the prompt.

### Configuration scopes

| Scope | What it is | How the app changes it |
| --- | --- | --- |
| Session | Active model and reasoning level | Through RPC (`set_model`, `set_thinking_level`); does not change persisted roles |
| Project | Project `modelRoles` | In this version, edits only `modelRoles`; other overrides are displayed but not overwritten |
| Global | Global OMP profile layer; `modelRoles` and `modelPresets` | Through the OMP CLI (`omp config set`), with schema validation and conflict detection |

## Security and privacy

- Isolated renderer (`contextIsolation`, `sandbox`, no Node, no webview, local CSP). Only `invoke` and `subscribe` are exposed.
- Every IPC call validates the origin frame, the schema, and the association with the project, session, terminal, and attachment.
- Paths are always relative to the project, resolved with `realpath`, and reject `..`, UNC paths, alternate data streams, and links pointing outside.
- Files open outside the app only through an allowlist of harmless extensions; scripts and executables are only shown in the folder.
- Data sent to the interface and logs do not carry tokens, authentication headers, or `providerPayload`. Logs redact keys and values that look like secrets.
- Processes are terminated only by the PID tree the app started, never by name.
- The app has no telemetry of its own; network traffic is that of OMP and the providers you configured, plus the official OMP build service and the official Git/Node.js sources when you choose those install actions.
- The OMP installation offered on first run uses the official Windows binary from the official build service, pinned to 18.16.0, verifies the published SHA-256 and `omp.exe --version`, writes only to `%LOCALAPPDATA%\omp` (or `PI_INSTALL_DIR`), and never overwrites an existing file; the renderer cannot supply a URL or command.
- Optional Git and Node.js installs use fixed official sources, verify SHA-256, extract safely, never overwrite an existing global tool, and do not modify the persistent PATH or registry; only the app process PATH is extended.

**Important limit:** redaction protects transport fields and logs, but **it is not a promise to erase sensitive content you type into the conversation**. Text, tool arguments, and results are preserved literally for the agent and may remain in the OMP transcript. Do not paste secrets into the chat; if you do, remove the history using OMP's tools and revoke the credential. The app cannot guarantee removal of what OMP has already recorded.

Dependency auditing and the release process are described in [`docs/release-security.md`](docs/release-security.md). To report a vulnerability, follow [`SECURITY.md`](SECURITY.md) — do not open a public issue.

## Error recovery

| Situation | What happens |
| --- | --- |
| OMP not found | The diagnostics screen shows the state and offers **Install OMP** (official pinned binary after an explicit click) and **Select omp.exe**; nothing is installed silently, and a failed install keeps manual selection available for retry |
| OMP 17 or older | Rejected as incompatible. Use **Install OMP** or update OMP before continuing |
| OMP crashes during the session | The session is marked as interrupted, the transcript is preserved, and no prompt is resent; the draft can be recovered |
| Local service fails | Diagnostics shows `host-failed`; persisted tabs remain saved and reopen without a prompt when the service returns |
| Configuration changed outside the app | Saving detects the conflict, reloads the values, and overwrites nothing |
| Session in use by another process | The app warns and does not open it by force; close the other process or choose another session |
| Git missing | The Changes panel explains that Git is not on `PATH`; the optional install action is available in Diagnostics and **Settings → General**. The rest of the app works |
| Node.js missing | Projects or MCP that need Node.js/npm are unavailable until it is installed; the optional install action is available in Diagnostics and **Settings → General**. The app and OMP work without it |
| Optional tool install fails | A localized error with retry is shown; nothing is overwritten, and a manual install remains possible |
| Folder is not a repository | The panel explains and does not run `git init`; to version it, use the terminal deliberately |
| Commit refused by a hook | The error is displayed and the files remain intact |
| Unsigned installer | SmartScreen may warn; verify the origin and SHA-256 and do not disable security |
| Uninstall | The application is removed; `%APPDATA%\omp-desktop` and `~/.omp` remain |

## Known limitations

- **Windows x64 only.** There are no macOS or Linux builds.
- **No auto-update.** Download the new installer and install it over the current version.
- **OMP is not bundled.** The first-run assistant can install the pinned official Windows binary (18.16.0) after an explicit click, but it does not update OMP silently; a compatible `omp.exe` (major version 18 or newer; validated at 18.16.0) is required.
- **No permission-mode selector of its own.** The app shows the approvals OMP sends and does not invent permission levels the RPC does not announce.
- **Git and Node.js LTS are optional and not bundled.** The app can install official builds on request, but it does not update them silently; a compatible global installation is detected and used as-is.
- **Git without `push`, `reset`, `clean`, or discard.** The panel covers status, diff, stage, unstage, and commit.
- **Unsigned installer.** SmartScreen may warn; there is no code-signing certificate in this version.
- **Attachments limited to 600 KiB per file** and to OMP's default 1 MB frame.
- **No WCAG conformance claim** and no documented testing with screen readers or users. Automated checks have limits.
- **v0.3.0 is the first public release.** Some rough edges are expected; do not treat it as 1.0.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening an issue or PR. In short:

- Run `bun run typecheck`, `bun run test`, and `bun run test:acceptance` before submitting.
- Describe the system (Windows x64), the app version, and the OMP version (`omp --version`).
- One change per PR, with the reason in the title. If you change the interface, attach a screenshot of the real window.
- Do not include personal data (paths containing a username, emails, tokens) in screenshots, fixtures, or logs.
- For security issues, use [`SECURITY.md`](SECURITY.md), not a public issue.

## License and third-party components

OMP Desktop is distributed under the **MIT** license. See [`LICENSE`](LICENSE).

Third-party notices are in [`resources/licenses/NOTICE.txt`](resources/licenses/NOTICE.txt). Distributed components include `@oh-my-pi/pi-coding-agent`, zod, `@lydell/node-pty`, React, React DOM, react-markdown, remark-gfm, xterm, Monaco, and Electron, all with their licenses preserved. The build uses electron-builder. The Bun runtime is included in the installer as `resources/bun/bun.exe`; the OMP executable is **not** redistributed.

Architecture and UX references from open-source projects were studied; no proprietary code was copied. MIT components keep their copyright notices.
