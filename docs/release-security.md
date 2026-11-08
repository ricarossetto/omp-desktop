# Dependency security — 0.3.1

Review: November 8, 2026. Next review of the exceptions: December 8, 2026, or
earlier if an OMP or packager update changes the paths described below.

## Applied fix

Monaco 0.57.0 includes DOMPurify 3.4.15 both as a dependency and as an internal
copy. Version 0.3.1 keeps the 0.3.0 fix: DOMPurify is pinned to **3.4.17** in the
lockfile, and Monaco's internal import is redirected to that same version in
Vite. The fix is therefore not limited to changing the package manager result:
the renderer also uses the fixed code.

References: [GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7),
[GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr).

## Residual advisories and scope

`bun audit` may still return exit code 1 because of the advisories below. That
does not mean an audit with no findings. No major-version override was applied to
hide them.

| Dependency | Advisory | Observed scope and decision |
| --- | --- | --- |
| `zod@3.25.76`, via OMP → `puppeteer-core@25.3.0` → `chromium-bidi@16.0.1` | High: [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | The app's direct Zod is 4.6.7, which is fixed. The 3.x copy belongs to Puppeteer's WebDriver BiDi adapter; the inspected OMP browser flow uses CDP, not BiDi. The adapter loads dynamically on the BiDi path. No fixed 3.x version was found. Forcing Zod 4 would break the adapter's declared contract. Exception conditioned on keeping that path unused; re-evaluate if OMP starts using BiDi. |
| `minimatch@9.0.9` and `10.2.6`, via `electron-builder` | Moderate: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Build tooling, outside production dependencies. Packaging uses patterns defined in the project itself, not patterns supplied by users. The fix requires minimatch 11; an incompatible upgrade was not forced. Re-evaluate with the electron-builder update. |

These conclusions are an analysis of existing paths, not a guarantee that no
vulnerabilities exist and not authorization to enable other modes without review.

## Third-party debug material in the packaged dependency

The official `@oh-my-pi/pi-coding-agent` 18.16.0 package contains static
debugging certificate and key constants (referenced as
`CLAUDE_TRACE_DEBUG_CERT` and `CLAUDE_TRACE_DEBUG_KEY` in
`src/cli/claude-trace-cli.ts` and in the built `dist/cli.js`). This material is
part of the upstream package's public debug tracing support. It is **not** a user
credential, not an owner credential, and not generated from this project's build
environment.

The project does not patch upstream code to remove that functionality. The
release instead relies on strict provenance: the dependency is installed from the
official registry package at the pinned version, and the packaged artifact is
verified against the official distribution and its hash. No key material is
reproduced in this document.

- Official tarball: <https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/-/pi-coding-agent-18.16.0.tgz>
- Registry integrity: `sha512-YJ3Gh5IAnIIFEeOihEIKHk9oGtK5FUEq0zxoox5BZgMtr9jWc420yVjirZC7mOvIP6o9jyxcOIHHRLn56hc7aQ==`
- The SHA-512 of the downloaded tarball matches the registry value, and the
  installed files are byte-identical to the official package.

For the final binary gate, allowlist the finding by origin and by file hash
instead of ignoring private-key-shaped material in general:

| File | SHA-256 |
| --- | --- |
| `src/cli/claude-trace-cli.ts` | `d8b245b9c783dd9e1d42c280268e254bddd4f430121227cb9b7d503b80d68dc1` |
| `dist/cli.js` | `1fa4bfb097c688fe73975940459ae171c5ea769f5a35be253896e60030476cb7` |

The constants appear in `src/cli/claude-trace-cli.ts` (lines 30, 50, 634, and
635) and in `dist/cli.js` (line 35545). The app's `src`, `scripts`, and `tests`
do not reference `claude-trace` or `CLAUDE_TRACE`, so the debug CLI is not used
by the application. A third-party `tsconfig.tsbuildinfo` is not personal data
and is not a release blocker; whether to exclude it from packaging is an
electron-builder configuration decision, not a documentation change.

Consequently, release verification should state that no real user credentials,
tokens, or account data are present in the payload. It should **not** claim that
the payload contains no private-key-shaped material at all, because the upstream
debug constants are exactly that. The final gate must still verify zero real
credentials.

## Release artifact gate (0.3.1)

The 0.3.1 artifacts are built from the frozen release commit, and the gate
records that commit before packaging. The gate verifies the packaged
`@oh-my-pi/pi-coding-agent` files against the SHA-256 values in the table above;
a mismatch blocks the release instead of being waived.

The artifact scan covers the NSIS installer, `win-unpacked`, and the installed
tree. It checks for user names, host names, home and checkout paths, owner
e-mail addresses, credential-shaped strings, and forbidden files (`.env`,
credentials, private keys, `builder-debug.yml`, blockmaps, logs, and build
caches). Findings are allowlisted by origin and file hash, never by ignoring a
pattern in general. The Electron/Chromium binary contains private-key-shaped and
access-key-shaped byte patterns inherited from the upstream runtime; they are
not user credentials and are recorded by hash in the gate evidence. The packaged
OMP debug material is the upstream material described above, also allowlisted by
file hash.

Linux packages are built from the same frozen source; their checksums are
consolidated with the Windows installer into the global `SHA256SUMS`.

The gate does not claim an audit with no findings. It confirms that the payload
contains no real user credentials, tokens, or account data and that the public
artifacts match the frozen source and the published `SHA256SUMS`.

## Optional tool installers

Git and Node.js LTS are optional. On Windows, both are installed only after an
explicit confirmation in the app; on Linux, the app installs Node.js only and
shows the fixed Git command for the user's package manager. The renderer cannot
supply a URL, version, or command: sources, versions, destinations, and arguments
are fixed in the main process.

### Git (Changes panel)

- Official Git for Windows MinGit **2.56.0.windows.4** ZIP:
  <https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/MinGit-2.56.0.4-64-bit.zip>
- SHA-256: `e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877`
- Destination: `%LOCALAPPDATA%\omp-desktop\tools\git`; the app adds
  `...\tools\git\cmd` only to its own process PATH.
- The ZIP is verified before extraction, extracted safely (no traversal,
  symlinks, or oversized entries), and `git.exe --version` must succeed before
  activation.
- No administrator rights, no winget or MSI, no registry writes, and no
  persistent user or system PATH changes. A compatible global Git on PATH is
  adopted as-is; an incompatible or partial managed folder is reported, not
  overwritten.

**Linux:** Git is native and is **not** installed by the app. No MinGit
download, no `sudo`, no `apt`, no `pacman`, and no password collection. The app
shows the fixed command for the user to run in their own terminal —
`sudo apt install git` on Debian/Ubuntu or `sudo pacman -S git` on Arch — and
re-probes with **Check again**. Manual reference:
<https://git-scm.com/download/linux>.

### Node.js LTS (projects/MCP)

- The current Node.js LTS is resolved from
  <https://nodejs.org/dist/index.json> at install time (v26.13.0 at release),
  and the official `win-x64` or `win-arm64` ZIP is downloaded from
  `https://nodejs.org/dist/v<version>/`.
- SHA-256 is read from the official
  `https://nodejs.org/dist/v<version>/SHASUMS256.txt` and verified before
  extraction. For v26.13.0 `win-x64`:
  `dcc60d59a0746999f99064a01c020445d54d84228c691cdbf25b49ac3b59150a`.
- Destination: `%LOCALAPPDATA%\omp-desktop\tools\node`; the app adds that folder
  only to its own process PATH. The official npm and npx are included; the app
  does not install project or MCP dependencies.
- No administrator rights, no MSI, no registry writes, and no persistent user or
  system PATH changes. A compatible global Node.js on PATH is adopted as-is; an
  incompatible or partial managed folder is reported, not overwritten.

**Linux:** the same LTS resolution uses the official `linux-x64` TAR.GZ
(`node-v<version>-linux-x64.tar.gz`) and the official `SHASUMS256.txt`. The
archive is read with a TAR reader that accepts only relative symlinks and
rejects traversal or oversized entries. Destination:
`$XDG_DATA_HOME/omp-desktop/tools/node` when `XDG_DATA_HOME` is absolute, else
`$HOME/.local/share/omp-desktop/tools/node`; only `<tools>/node/bin` is added to
the app process PATH. The official binary requires `libatomic.so.1`
(`libatomic1` on Debian/Ubuntu, `libatomic` from `gcc-libs` on Arch); if it is
missing, the app reports `MISSING_SYSTEM_LIBRARY` with the package command and
does not activate the tool. No system package is installed by the app.

Both installers stream with size caps, use a temporary directory and atomic
promotion, never overwrite an existing file, and abort/clean up on cancellation
or app close. Network access is limited to the official Git for Windows release
hosts (`github.com` / `release-assets.githubusercontent.com`) and `nodejs.org`
over TLS. No user credentials are sent. The Node.js version is deliberately not
pinned forever: it is the current LTS at install time. On Linux, the Git
network path is unused.

## Reproducible verification

The optional OMP installer contacts `https://build.stencil.so` (the official build
service used by OMP's installers), downloads the pinned 18.16.0 binary for the
current platform, verifies the SHA-256 returned by that service, and runs
`omp.exe --version` (Windows) or `omp --version` (Linux) before activation. It
writes to `%LOCALAPPDATA%\omp` on Windows or `$HOME/.local/bin/omp` on Linux (or
`PI_INSTALL_DIR`), marks the Linux binary executable (0755), and never
overwrites an existing OMP executable. It does not modify the persistent user
PATH or the registry and does not touch `~/.omp`; the app stores the absolute
path in its own runtime state and adds the folder only to the PATH of its own
processes. The renderer cannot supply a URL or command. No user credentials are
sent in this flow.

Windows:

```powershell
bun install --frozen-lockfile --ignore-scripts
bun audit
bun run typecheck
bun run test
bun run test:acceptance
bun run dist:win
```

Linux (x86_64):

```bash
bun install --frozen-lockfile
node node_modules/electron/install.js   # only if lifecycle scripts were skipped
bun run typecheck
bun run test
bun run test:acceptance
bun run dist:linux                      # .deb + .tar.gz (+ Arch package when makepkg exists)
cd release && sha256sum -c SHA256SUMS
```

The Linux build downloads the official Bun 1.4.4 baseline ZIP once, verifies its
SHA-256 (`e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76`)
and the extracted binary, and writes `resources/bun/bun` with mode 0755. The
`.deb` declares its Electron dependencies, including `libgtk-3-0`/`libgtk-3-0t64`,
`libasound2`/`libasound2t64`, and `libatomic1`; Git is only a `Suggests`. The
Arch PKGBUILD consumes the local `OMP-Desktop-0.3.1-linux-x64.tar.gz` and
verifies it against a trusted SHA-256 from `OMP_DESKTOP_ARCHIVE_SHA256`,
`release/SHA256SUMS`, or `<archive>.sha256`; it aborts if none is available. It
does not treat a hash computed from the artifact as verification. There is no
`SKIP` and no URL to a release that does not exist. Both packages install
`chrome-sandbox` with mode 4755 (the `.deb` also uses an AppArmor profile on
Ubuntu 24.04+) and the app never runs with `--no-sandbox`.

Neither the Windows installer nor the Linux packages are signed. Verify the
origin and compare the SHA-256 with `SHA256SUMS`. Do not
disable antivirus, SmartScreen, AppArmor, or the sandbox to bypass an alert.
Linux packages are built locally and published as release assets in 0.3.1;
verify `SHA256SUMS` before installing.

To report a vulnerability without publishing sensitive data, see
[SECURITY.md](../SECURITY.md).
