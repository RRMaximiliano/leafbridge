# Reliability Beta QA

Use this checklist before calling a LeafBridge build reliable. The goal is to prove the app behaves like a narrow Overleaf bridge, not a general Git client.

## Test Projects

Use at least two real Overleaf projects:

- A small manuscript project with one or two `.tex` files.
- A project with figures, references, generated LaTeX artifacts, and at least one collaborator edit from Overleaf.

For each project, clone Overleaf locally and rename the remote to `overleaf`:

```sh
git clone https://git.overleaf.com/<project-id> <folder-name>
cd <folder-name>
git remote rename origin overleaf
```

## Core Bridge Flows

### 1. Clean Sync

- Open LeafBridge.
- Select the local Overleaf project folder.
- Run `Check now`.
- Expected:
  - Sync panel says the local folder and Overleaf are in sync.
  - Review shows no incoming Overleaf files, no prepared local update, and no unprepared local edits.
  - Update and Send actions are disabled.

### 2. Incoming-Only Overleaf Edit

- Edit a manuscript file in Overleaf.
- Wait for Overleaf to save.
- Run `Check now`.
- Expected:
  - Review shows incoming Overleaf changes.
  - Changed file paths are exact.
  - Diff viewer shows the Overleaf edit.
  - `Update from Overleaf` opens an in-app confirmation dialog.
  - After confirming, the local file updates and the app returns to in sync.

### 3. Unprepared Local Edit

- Edit a manuscript file locally without preparing the update.
- Run `Check now`.
- Expected:
  - Review shows unprepared local edits.
  - `Prepare local update` is enabled.
  - `Send to Overleaf` stays disabled until the local edit is prepared.

### 4. Prepare Selected Local Update

- Open `Prepare local update`.
- Confirm manuscript files are selected by default.
- Confirm likely generated artifacts are excluded by default.
- Prepare the update.
- Expected:
  - Only selected files are committed.
  - Prepared local update appears in Review.
  - `Send to Overleaf` opens an in-app confirmation dialog.
  - After confirming, Overleaf receives the update and the app returns to in sync.

### 5. Overlap Risk

- Edit the same manuscript file locally and in Overleaf before updating.
- Run `Check now`.
- Expected:
  - Review clearly shows both-changed/conflict-risk files.
  - `Update from Overleaf` is blocked.
  - The recommendation explains that the user must inspect the overlap before continuing.

### 6. `.gitignore` Overlap

- Change `.gitignore` locally and in Overleaf.
- Run `Check now`.
- Expected:
  - `.gitignore` appears in changed-file lists.
  - `.gitignore` alone does not block update from Overleaf.

### 7. Missing Or Broken Setup

Run these with a disposable folder:

- No project selected.
- Folder is not a Git repository.
- Git repository has no `overleaf` remote.
- Remote exists but branch is missing or not fetched.
- Remote URL is invalid or authentication fails.

Expected:

- The compact setup surface explains the exact issue.
- Settings diagnostics shows the same state.
- Technical command output appears only when the technical output setting is enabled.
- LeafBridge never auto-creates remotes or rewrites Git configuration.

## Performance Checks

- Switch between at least three saved projects.
- Expected:
  - The sidebar selection changes immediately.
  - Cached status appears immediately when available.
  - A stale check from the previous project never overwrites the newly selected project.
  - Diffs load only for the current project.

## Activity Checks

- Confirm Activity records check, prepare, update, send, diff, and error events.
- Confirm background checks that find new Overleaf changes add a quiet Activity entry.
- Confirm logs are not duplicated elsewhere.

## Pass Criteria

LeafBridge passes beta QA only when:

- The app never auto-updates, auto-sends, auto-stashes, force-pushes, or resets.
- A collaborator editing only in Overleaf does not need to change behavior.
- The local author can always answer: what changed, where it changed, whether it is safe, and what action to take next.
