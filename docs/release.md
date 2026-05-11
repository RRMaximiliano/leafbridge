# Release Readiness

This document tracks the practical release path for LeafBridge.

## Current State

- Product stage: reliability beta.
- Distribution target: macOS desktop app.
- Build system: Tauri v2, React, TypeScript, pnpm workspace.
- Repository: `RRMaximiliano/leafbridge`.
- License: MIT.
- CI:
  - Every push and pull request runs tests, typecheck, lint, and package build.
  - macOS Tauri packaging runs manually or on version tags.

## Versioning

Keep these versions aligned before a release:

- Root `package.json`
- `apps/desktop/package.json`
- `apps/desktop/src-tauri/tauri.conf.json`
- `apps/desktop/src-tauri/Cargo.toml`

Use semantic versions once public builds start. Until then, `0.x` versions are expected.

## Local Release Checklist

Run from the repository root:

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @leafbridge/desktop tauri build
```

Then verify the generated app manually:

```text
apps/desktop/src-tauri/target/release/bundle/macos/LeafBridge.app
apps/desktop/src-tauri/target/release/bundle/dmg/
```

Manual checks:

- Launch the built `.app`, not only the dev server.
- Select a real Overleaf project.
- Run the reliability beta QA checklist.
- Check Cmd-Tab and Dock icon appearance.
- Check empty setup, Review, Activity, Settings diagnostics, and action dialogs.
- Confirm the app never performs update/send without explicit confirmation.

## GitHub Release Checklist

1. Ensure `main` is clean and CI is passing.
2. Update version numbers.
3. Update README and release notes.
4. Create a version tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

5. Let the macOS Tauri build job produce artifacts.
6. Create a GitHub release from the tag.
7. Attach the DMG artifact.
8. Include known limitations and setup requirements in the release notes.

## Signing And Notarization

Signing and notarization are not configured yet. Before public distribution, decide:

- Apple Developer Team ID.
- Signing identity.
- Notarization credential storage in GitHub Actions secrets.
- Whether releases are built locally or entirely in CI.

Expected future secrets:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

Do not publish a broad external beta until signing and notarization are working.

## Update Strategy

No automatic updater is configured yet. For now:

- Publish versioned DMGs on GitHub Releases.
- Keep release notes clear about manual replacement.
- Add a Tauri updater only after the core Overleaf bridge flows are stable.

## Release Notes Template

```md
## LeafBridge v0.x.y

### Bridge Reliability
- 

### Desktop App
- 

### Safety
- 

### Known Limitations
- Signing/notarization:
- Auto-updates:
- Notifications:
```

## Deferred Release Work

- App signing and notarization.
- Auto-update strategy.
- Public website or landing page.
- Native macOS notifications.
- Menu bar companion.
