# Release checklist

This checklist describes the release process without account data or development
paths.

## Before publishing

- Run `bun install --frozen-lockfile --ignore-scripts`, run
  `node node_modules/electron/install.js` if lifecycle scripts were skipped, and
  run the type check, unit tests, and acceptance tests in Electron.
- Run `bun audit`; record the scope, rationale, and review date of any dependency
  still flagged in [release-security.md](release-security.md).
- Check the READMEs in [English](../README.md), [Portuguese](README.pt-BR.md), and
  [Simplified Chinese](README.zh-CN.md).
- Check screenshots and their metadata: do not include accounts, personal emails,
  user directories, tokens, or real private sessions.
- Use a public or `noreply` identity in commits. Verify the entire history that
  will become public, not just the latest file.
- If the old history contains private data, keep it separate and private; publish
  only a clean snapshot without sharing old Git objects.
- Preserve third-party licenses and notices in `resources/licenses` and in the
  distributed packages.
- Build the artifacts from the commit intended for the release and test the
  installation outside the checkout, with a temporary profile:
  - Windows: the NSIS installer.
  - Linux: the `.deb` on Debian 12/13 and Ubuntu 24.04/26.04, and the Arch
    package produced by `packaging/arch/PKGBUILD` with `makepkg` on a non-root
    user. For the flat delivery (TAR and `SHA256SUMS` at the root, no
    `release/`), pass `OMP_DESKTOP_ARCHIVE` and `OMP_DESKTOP_ARCHIVE_SHA256`
    explicitly; confirm the PKGBUILD rejects a missing trusted hash instead of
    computing it from the artifact.
- When OMP is absent, exercise the assisted install in a temporary profile:
  confirm that it uses `%LOCALAPPDATA%\omp` on Windows or `$HOME/.local/bin` on
  Linux (or `PI_INSTALL_DIR`), verifies SHA-256 and `--version`, never
  overwrites an existing file, does not modify the persistent PATH or registry,
  does not modify the real `~/.omp` profile, and marks the Linux binary 0755.
- Exercise the optional Node.js install in a temporary profile: confirm official
  sources, SHA-256 verification, managed folders, no administrator rights, no
  overwrite of global tools, no persistent PATH/registry changes, and that new
  terminals and OMP child processes see the tool without restarting running
  agents. On Linux, confirm the destination is
  `$XDG_DATA_HOME/omp-desktop/tools/node` (or `~/.local/share/...`), only
  `node/bin` enters the app PATH, and a missing `libatomic.so.1` is reported with
  the package command instead of activating the tool.
- Exercise the Linux Git action: confirm the app shows `sudo apt install git` or
  `sudo pacman -S git`, never runs `sudo`/`apt`/`pacman`, never collects a
  password, and re-probes after the user installs Git.
- Inspect the installed content and confirm that no application settings,
  credentials, logs, tests, source maps, or `builder-debug.yml` are present. For
  Linux, also check `/opt`, the `/usr/bin/omp-desktop` symlink, the desktop entry,
  hicolor icons, licenses, and the sandbox setup (`chrome-sandbox` 4755 or the
  AppArmor profile).
- Compute the SHA-256 of the final artifacts and publish the checksum file
  (the global `SHA256SUMS` covering the Windows and Linux artifacts) next to
  them.
- Upload only the explicitly reviewed files. Do not upload the whole `release/`
  folder: `builder-debug.yml` contains build-machine paths.
- Do not publish `.cache`, browser profiles, test results, private backups, or
  `win-unpacked`/`linux-unpacked`.
- Confirm that the tag, the published code, the app version, and the artifacts
  match. Linux packages are built locally and, in 0.3.1, published as release
  assets after explicit approval; do not add an AUR package, PPA, or AppImage to
  a release unless that publication is explicitly approved.

## Product limits

The Windows x64 installer has no digital signature and no automatic update. It
bundles Bun but does not bundle the OMP executable; the first-run assistant can
install the pinned official Windows binary (18.16.0) after explicit user consent,
verifying SHA-256 and `--version` without overwriting an existing file.

The Linux x86_64 packages (`.deb` for Debian 12/13 and Ubuntu 24.04/26.04, and
the Arch `pkg.tar.zst` built from the local source archive) are also unsigned and
have no automatic update. They bundle Bun but not OMP; the assisted install uses
the official `linux-x86_64` binary in `$HOME/.local/bin/omp` (or
`PI_INSTALL_DIR`). Git is native and installed only by the user's package
manager; Node.js LTS is optional and managed under the XDG data directory. There
is no ARM, macOS, AppImage, AUR, or PPA build. Publishing hashes does not replace
code signing or an independent audit.

Automated accessibility checks and interface tests do not replace testing with
users and assistive technology. Data typed into conversations may contain
sensitive information: review any material before sharing it.
