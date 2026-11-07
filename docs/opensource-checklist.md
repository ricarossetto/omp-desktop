# Release checklist

This checklist describes the release process without account data or development
paths.

## Before publishing

- Run `bun install --frozen-lockfile --ignore-scripts`, the type check, unit
  tests, and acceptance tests in Electron.
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
- Build the installer from the commit intended for the release and test the
  installation outside the checkout, with a temporary profile.
- When OMP is absent, exercise the assisted install in a temporary profile:
  confirm that it uses `%LOCALAPPDATA%\omp`, verifies SHA-256 and `--version`,
  never overwrites an existing file, does not modify the persistent PATH or
  registry, and does not modify the real `~/.omp` profile.
- Exercise the optional Git and Node.js installs in a temporary profile: confirm
  official sources, SHA-256 verification, managed folders, no administrator
  rights, no overwrite of global tools, no persistent PATH/registry changes, and
  that new terminals and OMP child processes see the tools without restarting
  running agents.
- Inspect the installed content and confirm that no application settings,
  credentials, logs, tests, or source maps are present.
- Compute the SHA-256 of the final installer and publish `SHA256SUMS.txt` next to
  it.
- Upload only the explicitly reviewed files. Do not upload the whole `release/`
  folder: `builder-debug.yml` contains build-machine paths.
- Do not publish `.cache`, browser profiles, test results, private backups, or
  `win-unpacked`.
- Confirm that the tag, the published code, the app version, and the installer
  match.

## Product limits

The Windows x64 installer has no digital signature and no automatic update. It
bundles Bun but does not bundle the OMP executable; the first-run assistant can
install the pinned official Windows binary (18.16.0) after explicit user consent,
verifying SHA-256 and `--version` without overwriting an existing file. Publishing
hashes does not replace code signing or an independent audit.

Automated accessibility checks and interface tests do not replace testing with
users and assistive technology. Data typed into conversations may contain
sensitive information: review any material before sharing it.
