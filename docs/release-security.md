# Dependency security — 0.3.0

Review: November 7, 2026. Next review of the exceptions: December 7, 2026, or
earlier if an OMP or packager update changes the paths described below.

## Applied fix

Monaco 0.57.0 includes DOMPurify 3.4.15 both as a dependency and as an internal
copy. Version 0.3.0 pins DOMPurify to **3.4.17** in the lockfile and redirects
Monaco's internal import to that same version in Vite. The fix is therefore not
limited to changing the package manager result: the renderer also uses the fixed
code.

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

## Optional tool installers

Git and Node.js LTS are optional and are installed only after an explicit
confirmation in the app. The renderer cannot supply a URL, version, or command:
sources, versions, destinations, and arguments are fixed in the main process.

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

Both installers stream with size caps, use a temporary directory and atomic
promotion, never overwrite an existing file, and abort/clean up on cancellation
or app close. Network access is limited to the official Git for Windows release
hosts (`github.com` / `release-assets.githubusercontent.com`) and `nodejs.org`
over TLS. No user credentials are sent. The Node.js version is deliberately not
pinned forever: it is the current LTS at install time.

## Reproducible verification

The optional OMP installer contacts `https://build.stencil.so` (the official build
service used by OMP's Windows installer), downloads the pinned 18.16.0 binary,
verifies the SHA-256 returned by that service, and runs `omp.exe --version`
before activation. It writes to `%LOCALAPPDATA%\omp` (or `PI_INSTALL_DIR`) and
never overwrites an existing `omp.exe`. It does not modify the persistent user
PATH or the registry and does not touch `~/.omp`; the app stores the absolute
path in its own runtime state and adds the folder only to the PATH of its own
processes. The renderer cannot supply a URL or command. No user credentials are
sent in this flow.

```powershell
bun install --frozen-lockfile --ignore-scripts
bun audit
bun run typecheck
bun run test
bun run test:acceptance
bun run dist:win
```

The installer is not signed. Verify its origin on GitHub Releases and compare the
SHA-256 with `SHA256SUMS.txt`. Do not disable antivirus or SmartScreen to bypass
an alert.

To report a vulnerability without publishing sensitive data, see
[SECURITY.md](../SECURITY.md).
