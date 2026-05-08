import { describe, expect, it } from "vitest";
import {
  commitLocalChanges,
  computeConflictRisk,
  classifyPrepareFiles,
  deriveOverleafGitUrl,
  getFileDiff,
  getProjectStatus,
  pullFromOverleaf,
  pushToOverleaf,
  type GitCommandResult,
  type GitExecutor
} from "../src";

class MockGit implements GitExecutor {
  readonly calls: string[][] = [];

  constructor(private readonly responses: Record<string, GitCommandResult | string>) {}

  async runGit(_projectPath: string, args: string[]): Promise<GitCommandResult> {
    this.calls.push(args);
    const key = args.join(" ");
    const response = this.responses[key] ?? "";
    if (typeof response === "string") {
      return { stdout: response, stderr: "", exitCode: 0 };
    }
    return response;
  }
}

const baseResponses = {
  "rev-parse --is-inside-work-tree": "true\n",
  "branch --show-current": "paper-draft\n",
  "remote -v":
    "origin\tgit@github.com:lab/paper.git (fetch)\norigin\tgit@github.com:lab/paper.git (push)\noverleaf\thttps://git.overleaf.com/123 (fetch)\noverleaf\thttps://git.overleaf.com/123 (push)\n",
  "fetch overleaf --prune": "",
  "status --porcelain": "",
  "remote show -n overleaf": "* remote overleaf\n  Fetch URL: https://git.overleaf.com/123\n  Push  URL: https://git.overleaf.com/123\n  HEAD branch: overleaf-main\n",
  "for-each-ref refs/remotes/overleaf --format=%(refname:short)": "overleaf/overleaf-main\n",
  "merge-base HEAD overleaf/overleaf-main": "0000000\n",
  "log --oneline HEAD..overleaf/overleaf-main": "",
  "log --oneline overleaf/overleaf-main..HEAD": "",
  "diff --name-status 0000000..overleaf/overleaf-main": "",
  "diff --name-status 0000000..HEAD": ""
};

describe("getProjectStatus", () => {
  it("returns a clear non-git status", async () => {
    const executor = new MockGit({
      "rev-parse --is-inside-work-tree": { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 }
    });

    const status = await getProjectStatus({ projectPath: "/tmp/paper", executor });

    expect(status.isGitRepo).toBe(false);
    expect(status.errors[0]?.code).toBe("not_git_repo");
    expect(status.recommendation).toContain("Git");
  });

  it("detects the configured Overleaf remote and remote HEAD branch without assuming master", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "log --oneline HEAD..overleaf/overleaf-main": "abc1234 Revise abstract\n",
      "diff --name-status 0000000..overleaf/overleaf-main": "M\tmanuscript/main.tex\nA\tmanuscript/sections/results.tex\n"
    });

    const status = await getProjectStatus({
      projectPath: "/tmp/paper",
      executor,
      now: () => new Date("2026-05-05T10:00:00.000Z")
    });

    expect(status.overleafRemote?.branch).toBe("overleaf-main");
    expect(status.lastFetchedAt).toBe("2026-05-05T10:00:00.000Z");
    expect(status.incoming.hasChanges).toBe(true);
    expect(status.incoming.commits).toEqual([{ hash: "abc1234", subject: "Revise abstract" }]);
    expect(status.incoming.files.map((file) => file.path)).toEqual([
      "manuscript/main.tex",
      "manuscript/sections/results.tex"
    ]);
    expect(status.outgoing.files).toEqual([]);
  });

  it("does not turn remote-only edits into local file changes", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "merge-base HEAD overleaf/overleaf-main": "HEAD\n",
      "log --oneline HEAD..overleaf/overleaf-main": "abc1234 Remote-only manuscript edit\n",
      "diff --name-status HEAD..overleaf/overleaf-main": "M\tmanuscript/main.tex\n",
      "diff --name-status HEAD..HEAD": ""
    });

    const status = await getProjectStatus({ projectPath: "/tmp/paper", executor });

    expect(status.incoming.files.map((file) => file.path)).toEqual(["manuscript/main.tex"]);
    expect(status.outgoing.files).toEqual([]);
    expect(status.conflictRisk).toEqual({ level: "none", files: [] });
  });

  it("falls back to the local branch when the remote HEAD is unknown", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "remote show -n overleaf": "  HEAD branch: (unknown)\n",
      "for-each-ref refs/remotes/overleaf --format=%(refname:short)": "overleaf/paper-draft\noverleaf/review\n",
      "merge-base HEAD overleaf/paper-draft": "0000000\n",
      "log --oneline HEAD..overleaf/paper-draft": "",
      "log --oneline overleaf/paper-draft..HEAD": "",
      "diff --name-status 0000000..overleaf/paper-draft": "",
      "diff --name-status 0000000..HEAD": ""
    });

    const status = await getProjectStatus({ projectPath: "/tmp/paper", executor });

    expect(status.overleafRemote?.branch).toBe("paper-draft");
  });

  it("reports outgoing commits, working tree files, and high overlap risk", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "status --porcelain": " M manuscript/main.tex\n?? outputs/table.csv\n",
      "log --oneline HEAD..overleaf/overleaf-main": "1111111 Update title\n",
      "log --oneline overleaf/overleaf-main..HEAD": "2222222 Local figures\n",
      "diff --name-status 0000000..overleaf/overleaf-main": "M\tmanuscript/main.tex\n",
      "diff --name-status 0000000..HEAD": "M\tfigures/plot.pdf\n"
    });

    const status = await getProjectStatus({ projectPath: "/tmp/paper", executor });

    expect(status.workingTree.clean).toBe(false);
    expect(status.outgoing.hasChanges).toBe(true);
    expect(status.conflictRisk).toEqual({ level: "high", files: ["manuscript/main.tex"] });
    expect(status.errors.map((error) => error.code)).toContain("local_uncommitted_changes");
    expect(status.errors.map((error) => error.code)).toContain("conflict_risk");
  });
});

describe("sync guards and diffs", () => {
  it("blocks pull when uncommitted changes exist", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "status --porcelain": " M manuscript/main.tex\n"
    });

    const result = await pullFromOverleaf({ projectPath: "/tmp/paper", executor });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("local_uncommitted_changes");
    expect(executor.calls.some((args) => args[0] === "pull")).toBe(false);
  });

  it("does not block pull when the only overlapping file is .gitignore", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "log --oneline HEAD..overleaf/overleaf-main": "1111111 Remote ignore cleanup\n",
      "log --oneline overleaf/overleaf-main..HEAD": "2222222 Local ignore cleanup\n",
      "diff --name-status 0000000..overleaf/overleaf-main": "D\t.gitignore\n",
      "diff --name-status 0000000..HEAD": "A\t.gitignore\n",
      "pull --rebase overleaf overleaf-main": "Successfully rebased and updated refs/heads/paper-draft.\n"
    });

    const result = await pullFromOverleaf({ projectPath: "/tmp/paper", executor });

    expect(result.ok).toBe(true);
    expect(result.status?.conflictRisk).toEqual({ level: "low", files: [] });
    expect(executor.calls).toContainEqual(["pull", "--rebase", "overleaf", "overleaf-main"]);
  });

  it("blocks push when Overleaf has incoming changes", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "log --oneline HEAD..overleaf/overleaf-main": "1111111 Remote edit\n",
      "diff --name-status 0000000..overleaf/overleaf-main": "M\tmanuscript/main.tex\n"
    });

    const result = await pushToOverleaf({ projectPath: "/tmp/paper", executor });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("conflict_risk");
    expect(executor.calls.some((args) => args[0] === "push")).toBe(false);
  });

  it("commits uncommitted local changes without pulling or pushing", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "status --porcelain": " M manuscript/main.tex\n?? manuscript/notes.tex\n",
      "add -A": "",
      "commit -m Update manuscript locally": "[paper-draft 3333333] Update manuscript locally\n"
    });

    const result = await commitLocalChanges({
      projectPath: "/tmp/paper",
      executor,
      message: "Update manuscript locally"
    });

    expect(result.ok).toBe(true);
    expect(executor.calls).toContainEqual(["add", "-A"]);
    expect(executor.calls).toContainEqual(["commit", "-m", "Update manuscript locally"]);
    expect(executor.calls.some((args) => args[0] === "pull" || args[0] === "push")).toBe(false);
  });

  it("does not commit when there are no uncommitted local changes", async () => {
    const executor = new MockGit(baseResponses);

    const result = await commitLocalChanges({
      projectPath: "/tmp/paper",
      executor,
      message: "No-op"
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("no_local_changes");
    expect(executor.calls.some((args) => args[0] === "commit")).toBe(false);
  });

  it("commits only selected local files when file paths are provided", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "status --porcelain": " M manuscript/main.tex\n?? outputs/table.csv\n",
      "add -- manuscript/main.tex": "",
      "commit -m Prepare manuscript edit": "[paper-draft 4444444] Prepare manuscript edit\n"
    });

    const result = await commitLocalChanges({
      projectPath: "/tmp/paper",
      executor,
      message: "Prepare manuscript edit",
      files: ["manuscript/main.tex"]
    });

    expect(result.ok).toBe(true);
    expect(executor.calls).toContainEqual(["add", "--", "manuscript/main.tex"]);
    expect(executor.calls).not.toContainEqual(["add", "-A"]);
  });

  it("runs push only as HEAD to detected branch and never force pushes", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "log --oneline overleaf/overleaf-main..HEAD": "2222222 Local revision\n",
      "diff --name-status 0000000..HEAD": "M\tmanuscript/main.tex\n",
      "push overleaf HEAD:overleaf-main": "To https://git.overleaf.com/123\n"
    });

    const result = await pushToOverleaf({ projectPath: "/tmp/paper", executor });

    expect(result.ok).toBe(true);
    expect(executor.calls).toContainEqual(["push", "overleaf", "HEAD:overleaf-main"]);
    expect(executor.calls.flat()).not.toContain("--force");
  });

  it("builds file diffs from core for each direction", async () => {
    const executor = new MockGit({
      "merge-base HEAD overleaf/main": "0000000\n",
      "diff 0000000..overleaf/main -- manuscript/main.tex": "incoming diff",
      "diff 0000000..HEAD -- manuscript/main.tex": "outgoing diff",
      "diff HEAD -- manuscript/main.tex": "working diff"
    });

    await expect(
      getFileDiff({
        projectPath: "/tmp/paper",
        executor,
        remoteBranch: "main",
        filePath: "manuscript/main.tex",
        direction: "incoming"
      })
    ).resolves.toBe("incoming diff");
    await expect(
      getFileDiff({
        projectPath: "/tmp/paper",
        executor,
        remoteBranch: "main",
        filePath: "manuscript/main.tex",
        direction: "outgoing"
      })
    ).resolves.toBe("outgoing diff");
    await expect(
      getFileDiff({
        projectPath: "/tmp/paper",
        executor,
        remoteBranch: "main",
        filePath: "manuscript/main.tex",
        direction: "working"
      })
    ).resolves.toBe("working diff");
  });

  it("grades conflict risk by overlap and local dirt", () => {
    expect(computeConflictRisk([{ path: "a.tex", status: "Modified", code: "M", direction: "incoming" }], [], []))
      .toEqual({ level: "none", files: [] });
    expect(
      computeConflictRisk(
        [{ path: "a.tex", status: "Modified", code: "M", direction: "incoming" }],
        [{ path: "b.tex", status: "Modified", code: "M", direction: "outgoing" }],
        []
      )
    ).toEqual({ level: "low", files: [] });
    expect(
      computeConflictRisk(
        [{ path: "a.tex", status: "Modified", code: "M", direction: "incoming" }],
        [],
        [{ path: "b.tex", status: "Modified", code: " M", direction: "working" }]
      )
    ).toEqual({ level: "medium", files: [] });
    expect(
      computeConflictRisk(
        [{ path: "a.tex", status: "Modified", code: "M", direction: "incoming" }],
        [],
        [{ path: "a.tex", status: "Modified", code: " M", direction: "working" }]
      )
    ).toEqual({ level: "high", files: ["a.tex"] });
    expect(
      computeConflictRisk(
        [{ path: ".gitignore", status: "Deleted", code: "D", direction: "incoming" }],
        [{ path: ".gitignore", status: "Added", code: "A", direction: "outgoing" }],
        []
      )
    ).toEqual({ level: "low", files: [] });
  });

  it("derives Overleaf Git URLs from web project URLs", () => {
    expect(deriveOverleafGitUrl("https://www.overleaf.com/project/abc123456789?foo=bar")).toBe(
      "https://git.overleaf.com/abc123456789"
    );
    expect(deriveOverleafGitUrl("https://git.overleaf.com/abc123456789")).toBe("https://git.overleaf.com/abc123456789");
    expect(deriveOverleafGitUrl("https://example.com/project/abc123456789")).toBeUndefined();
  });

  it("classifies likely generated untracked files for prepare defaults", () => {
    const manuscript = { path: "manuscript/main.tex", status: "Modified", code: "M", direction: "working" as const };
    const log = { path: "manuscript/main.log", status: "Untracked", code: "??", direction: "working" as const };
    const output = { path: "outputs/table.csv", status: "Untracked", code: "??", direction: "working" as const };
    const trackedOutput = { path: "outputs/figure.pdf", status: "Modified", code: "M", direction: "working" as const };

    const result = classifyPrepareFiles([manuscript, log, output, trackedOutput]);

    expect(result.included.map((file) => file.path)).toEqual(["manuscript/main.tex", "outputs/figure.pdf"]);
    expect(result.excluded.map((file) => file.path)).toEqual(["manuscript/main.log", "outputs/table.csv"]);
  });

  it("uses renamed destination paths from Git name-status output", async () => {
    const executor = new MockGit({
      ...baseResponses,
      "log --oneline HEAD..overleaf/overleaf-main": "1111111 Rename section\n",
      "diff --name-status 0000000..overleaf/overleaf-main": "R100\tmanuscript/old.tex\tmanuscript/new.tex\n"
    });

    const status = await getProjectStatus({ projectPath: "/tmp/paper", executor });

    expect(status.incoming.files).toEqual([
      {
        path: "manuscript/new.tex",
        status: "Renamed",
        code: "R100",
        direction: "incoming"
      }
    ]);
  });
});
