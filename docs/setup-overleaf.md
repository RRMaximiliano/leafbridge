# Connecting An Overleaf Project

LeafBridge expects a local folder that is already connected to Overleaf Git. It diagnoses setup problems, but it does not create or rewrite Git remotes automatically.

## Clone From Overleaf

Use the Git URL from Overleaf:

```sh
git clone https://git.overleaf.com/<project-id> <folder-name>
cd <folder-name>
git remote rename origin overleaf
```

Example:

```sh
git clone https://git.overleaf.com/64945ef27df00ebd80b162c5 manuscript
cd manuscript
git remote rename origin overleaf
```

If you cloned with the remote still named `origin`, either rename it as above or change the remote name in LeafBridge Settings.

## Add An Overleaf Remote To An Existing Git Repo

If the local folder is already a Git repository, add Overleaf as a remote:

```sh
git remote add overleaf https://git.overleaf.com/<project-id>
git fetch overleaf
```

LeafBridge can derive the Git URL from normal Overleaf project URLs such as:

```text
https://www.overleaf.com/project/<project-id>
```

The derived Git URL is:

```text
https://git.overleaf.com/<project-id>
```

## Authentication

Overleaf Git access uses your Overleaf account credentials or the authentication method configured by Overleaf for your account. If fetch fails:

- Confirm Git access is enabled for the Overleaf project.
- Confirm the project URL or Git URL is correct.
- Try `git fetch overleaf` in Terminal to trigger credential prompts.
- Confirm the selected local folder is the repository root.

## What LeafBridge Will Not Do

LeafBridge will not:

- Initialize Git for you.
- Auto-create or edit remotes.
- Auto-stash local changes.
- Force-push.
- Reset your repository.

Those constraints are intentional. The app should make Overleaf sync safer and clearer without becoming a general Git client.
