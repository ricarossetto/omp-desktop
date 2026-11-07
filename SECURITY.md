# Security

## How to report

Do not open a public issue for security vulnerabilities. Use GitHub's **Report a
vulnerability** feature (*Security* tab → *Advisories*) in this repository, with:

- OMP Desktop and OMP versions (`omp --version`);
- steps to reproduce;
- observed impact (what leaks, what executes, what is approved without a click).

You will receive a response as soon as the issue is triaged.

## Scope

In scope:

- code execution in the renderer (XSS, tool HTML, malicious link);
- approvals answered without user action;
- reading files outside opened projects (path traversal, symlink, UNC);
- exposure of tokens, headers, or credentials in the interface, logs, or IPC;
- Git/CLI commands with argument injection.

## What the app already guarantees

- The renderer has no Node, filesystem, or shell; only `invoke`/`subscribe`.
- Every IPC call validates the origin frame, the schema, and the association with
  the project/session.
- The app never approves a tool on its own.
- No prompt is resent automatically after a crash or restart.
- OMP credentials stay in its profile (`~/.omp`), never in the repository.
- Optional Git and Node.js installs use fixed official sources, verify SHA-256,
  extract safely, never overwrite an existing global tool, and do not modify the
  persistent PATH or registry.
