# LeafBridge

![LeafBridge icon](apps/desktop/src-tauri/icons/icon.png)

LeafBridge is a local Overleaf bridge for academic paper projects. It helps a researcher working locally see what changed in Overleaf, inspect those changes, update the local folder safely, prepare local edits, and send those edits back to Overleaf.

It is designed for a common collaboration pattern:

- Author A works locally with VS Code, terminal tools, scripts, figures, tables, and manuscript files.
- Author B works only in Overleaf and does not need to know Git.
- LeafBridge gives Author A a focused sync surface without turning the app into a general Git client.

## What It Does

- Selects one local paper folder.
- Detects whether the folder is Git-backed.
- Detects the configured Overleaf Git remote, defaulting to `overleaf`.
- Detects the Overleaf branch without assuming `master`.
- Fetches Overleaf changes.
- Shows incoming Overleaf edits, prepared local updates, unprepared local edits, overlap risk, and a clear recommendation.
- Provides file-level diffs where possible.
- Prepares selected local edits before sending them to Overleaf.
- Updates from Overleaf and sends to Overleaf only after explicit confirmation.
- Keeps Activity as the single place for check, update, send, diff, and error history.

## Safety Model

LeafBridge is intentionally conservative.

- It never auto-updates from Overleaf.
- It never auto-sends to Overleaf.
- It never auto-stashes.
- It never force-pushes.
- It never runs destructive commands such as `git reset --hard`.
- It blocks update/send flows when the local folder or Overleaf state makes the operation unsafe.
- It treats `.gitignore` overlap as non-blocking, while still showing it in changed-file lists.

The user-facing workflow avoids Git jargon where possible:

- "Prepare local update" means commit selected local edits.
- "Update from Overleaf" means fetch and pull/rebase from the Overleaf remote.
- "Send to Overleaf" means push the prepared local update to the Overleaf remote.

## Monorepo Structure

```text
leafbridge/
  packages/
    core/       Shared Git and Overleaf bridge logic. No UI code.
  apps/
    desktop/    Tauri + React desktop app.
```

The core package is reusable for future clients, such as a VS Code extension, but the current product is the desktop app.

## Requirements

- Node.js and pnpm
- Rust toolchain for Tauri builds
- Git
- An Overleaf project with Git access enabled
- A local paper folder connected to the Overleaf Git remote

The expected remote name is `overleaf`, though it can be changed in Settings.

## Development

Install dependencies:

```sh
pnpm install
```

Run checks:

```sh
pnpm test
pnpm typecheck
pnpm lint
```

Run the desktop app in development:

```sh
pnpm desktop:dev
```

Build the desktop app:

```sh
pnpm desktop:build
```

Build artifacts are produced under:

```text
apps/desktop/src-tauri/target/release/bundle/
```

## Core Test Coverage

The core package includes unit tests and real Git integration tests. The integration tests create temporary repositories, a bare Overleaf-style remote, and separate local/collaborator clones to verify:

- incoming-only Overleaf edits
- prepared local updates
- unprepared local edits
- incoming plus local overlap
- non-`master` branch detection
- pull rebase from Overleaf
- push using `HEAD:<branch>`
- no force-push, reset, or stash commands

## Current Status

LeafBridge is in a reliability-beta stage. The core bridge flows are implemented, the desktop app is usable, and the next major work is real-world QA against multiple Overleaf projects and release packaging.

Deferred items:

- menu bar companion
- native macOS notifications
- signing and notarization
- release update strategy

## License

No license has been selected yet.
