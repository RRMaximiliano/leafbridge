import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitLocalChanges,
  getProjectStatus,
  pullFromOverleaf,
  pushToOverleaf,
  type GitCommandResult,
  type GitExecutor
} from "../src";

class RealGit implements GitExecutor {
  readonly calls: string[][] = [];

  async runGit(projectPath: string, args: string[]): Promise<GitCommandResult> {
    this.calls.push(args);
    const result = spawnSync("git", args, {
      cwd: projectPath,
      encoding: "utf8"
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
      exitCode: result.status ?? (result.error ? 1 : 0)
    };
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real Git Overleaf bridge flows", () => {
  it("detects, updates from, prepares, and sends to a non-master Overleaf branch", async () => {
    const repo = await createBridgeFixture();
    const executor = new RealGit();

    await editAndCommit(repo.collaboratorPath, "manuscript/main.tex", "remote title\n", "Overleaf title edit");
    git(repo.collaboratorPath, ["push", "origin", "paper-draft"]);

    const incoming = await getProjectStatus({ projectPath: repo.localPath, executor });

    expect(incoming.overleafRemote?.branch).toBe("paper-draft");
    expect(incoming.incoming.hasChanges).toBe(true);
    expect(incoming.incoming.files.map((file) => file.path)).toEqual(["manuscript/main.tex"]);
    expect(incoming.outgoing.hasChanges).toBe(false);

    const update = await pullFromOverleaf({ projectPath: repo.localPath, executor });

    expect(update.ok).toBe(true);
    expect(executor.calls).toContainEqual(["pull", "--rebase", "overleaf", "paper-draft"]);

    await writeFile(path.join(repo.localPath, "manuscript/main.tex"), "local revision\n");
    const prepared = await commitLocalChanges({
      projectPath: repo.localPath,
      executor,
      message: "Prepare local manuscript revision",
      files: ["manuscript/main.tex"]
    });

    expect(prepared.ok).toBe(true);
    expect(executor.calls).toContainEqual(["add", "--", "manuscript/main.tex"]);

    const outgoing = await getProjectStatus({ projectPath: repo.localPath, executor });

    expect(outgoing.outgoing.hasChanges).toBe(true);
    expect(outgoing.incoming.hasChanges).toBe(false);

    const send = await pushToOverleaf({ projectPath: repo.localPath, executor });

    expect(send.ok).toBe(true);
    expect(executor.calls).toContainEqual(["push", "overleaf", "HEAD:paper-draft"]);
    expect(executor.calls.flat()).not.toContain("--force");
    expect(executor.calls.flat()).not.toContain("reset");
    expect(executor.calls.flat()).not.toContain("stash");
  });

  it("blocks update when unprepared local edits overlap with Overleaf edits", async () => {
    const repo = await createBridgeFixture();
    const executor = new RealGit();

    await writeFile(path.join(repo.localPath, "manuscript/main.tex"), "unprepared local edit\n");
    await editAndCommit(repo.collaboratorPath, "manuscript/main.tex", "remote overlapping edit\n", "Overleaf overlap");
    git(repo.collaboratorPath, ["push", "origin", "paper-draft"]);

    const status = await getProjectStatus({ projectPath: repo.localPath, executor });

    expect(status.workingTree.clean).toBe(false);
    expect(status.incoming.hasChanges).toBe(true);
    expect(status.conflictRisk).toEqual({ level: "high", files: ["manuscript/main.tex"] });

    const update = await pullFromOverleaf({ projectPath: repo.localPath, executor });

    expect(update.ok).toBe(false);
    expect(update.error?.code).toBe("local_uncommitted_changes");
    expect(executor.calls.some((args) => args[0] === "pull")).toBe(false);
  });
});

async function createBridgeFixture(): Promise<{ root: string; localPath: string; collaboratorPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "leafbridge-core-"));
  tempRoots.push(root);
  const remotePath = path.join(root, "overleaf.git");
  const localPath = path.join(root, "paper");
  const collaboratorPath = path.join(root, "overleaf-user");

  git(root, ["init", "--bare", remotePath]);
  git(root, ["init", "-b", "paper-draft", localPath]);
  configureUser(localPath);
  await mkdir(path.join(localPath, "manuscript"), { recursive: true });
  await writeFile(path.join(localPath, "manuscript/main.tex"), "initial manuscript\n");
  git(localPath, ["add", "manuscript/main.tex"]);
  git(localPath, ["commit", "-m", "Initial paper"]);
  git(localPath, ["remote", "add", "overleaf", remotePath]);
  git(localPath, ["push", "-u", "overleaf", "paper-draft"]);

  git(root, ["clone", remotePath, collaboratorPath]);
  configureUser(collaboratorPath);
  git(collaboratorPath, ["checkout", "paper-draft"]);

  return { root, localPath, collaboratorPath };
}

function configureUser(projectPath: string) {
  git(projectPath, ["config", "user.email", "leafbridge@example.test"]);
  git(projectPath, ["config", "user.name", "LeafBridge Test"]);
}

async function editAndCommit(projectPath: string, filePath: string, content: string, message: string) {
  await writeFile(path.join(projectPath, filePath), content);
  git(projectPath, ["add", filePath]);
  git(projectPath, ["commit", "-m", message]);
}

function git(projectPath: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd: projectPath,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed\n${result.stderr}\n${result.stdout}`);
  }
  return result.stdout.trimEnd();
}
