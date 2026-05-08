import type {
  ChangedFile,
  CommitSummary,
  GitCommandResult,
  GitExecutor,
  OverleafRemote,
  ProjectError,
  ProjectErrorCode
} from "./types";

export class GitOperationError extends Error {
  readonly code: ProjectErrorCode;
  readonly detail?: string;
  readonly result?: GitCommandResult;

  constructor(code: ProjectErrorCode, message: string, detail?: string, result?: GitCommandResult) {
    super(message);
    this.name = "GitOperationError";
    this.code = code;
    this.detail = detail;
    this.result = result;
  }
}

export async function git(
  executor: GitExecutor,
  projectPath: string,
  args: string[],
  code: ProjectErrorCode = "git_failed"
): Promise<string> {
  const result = await executor.runGit(projectPath, args);
  if (result.exitCode !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new GitOperationError(classifyGitFailure(detail, code), failureMessage(code), detail, result);
  }
  return result.stdout.trimEnd();
}

export function classifyGitFailure(detail: string, fallback: ProjectErrorCode): ProjectErrorCode {
  const text = detail.toLowerCase();
  if (
    text.includes("authentication failed") ||
    text.includes("permission denied") ||
    text.includes("could not read username") ||
    text.includes("could not read from remote repository") ||
    text.includes("repository not found")
  ) {
    return "authentication_failed";
  }
  if (text.includes("couldn't find remote ref") || text.includes("unknown revision")) {
    return "remote_branch_missing";
  }
  return fallback;
}

export function toProjectError(error: unknown, fallback: ProjectErrorCode = "git_failed"): ProjectError {
  if (error instanceof GitOperationError) {
    return {
      code: error.code,
      message: error.message,
      detail: error.detail
    };
  }
  if (error instanceof Error) {
    return {
      code: fallback,
      message: error.message
    };
  }
  return {
    code: fallback,
    message: "Git operation failed."
  };
}

export function failureMessage(code: ProjectErrorCode): string {
  switch (code) {
    case "fetch_failed":
      return "Fetch from Overleaf failed.";
    case "pull_failed":
      return "Update from Overleaf failed.";
    case "push_failed":
      return "Send to Overleaf failed.";
    case "remote_branch_missing":
      return "Overleaf remote branch was not found.";
    default:
      return "Git command failed.";
  }
}

export function parseRemotes(output: string): OverleafRemote[] {
  const remotes = new Map<string, Partial<OverleafRemote>>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const [, name, url, kind] = match;
    const entry = remotes.get(name) ?? { name };
    if (kind === "fetch") entry.fetchUrl = url;
    if (kind === "push") entry.pushUrl = url;
    remotes.set(name, entry);
  }
  return [...remotes.values()]
    .filter((remote): remote is OverleafRemote => Boolean(remote.name && remote.fetchUrl && remote.pushUrl))
    .map((remote) => ({ ...remote, branch: "" }));
}

export function parseCurrentBranch(output: string): string | undefined {
  const branch = output.trim();
  return branch.length > 0 ? branch : undefined;
}

export function parseRemoteHeadBranch(output: string): string | undefined {
  const match = output.match(/^\s*HEAD branch:\s*(.+)$/m);
  const branch = match?.[1]?.trim();
  if (!branch || branch === "(unknown)" || branch === "(not queried)") return undefined;
  return branch;
}

export function parseRemoteTrackingBranches(output: string, remoteName: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith(`${remoteName}/`))
    .filter((line) => line !== `${remoteName}/HEAD`)
    .map((line) => line.slice(remoteName.length + 1))
    .sort((a, b) => a.localeCompare(b));
}

export function parseCommits(output: string): CommitSummary[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split(" ");
      return {
        hash,
        subject: rest.join(" ").trim()
      };
    });
}

export function parseNameStatus(output: string, direction: ChangedFile["direction"]): ChangedFile[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [code = "", ...rest] = line.split(/\s+/);
      const rawPath = code.startsWith("R") || code.startsWith("C") ? rest.at(-1) ?? rest.join(" ") : rest.join(" ");
      const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
      return {
        path,
        status: statusLabel(code),
        code,
        direction
      };
    });
}

export function parsePorcelainStatus(output: string): ChangedFile[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
      return {
        path,
        status: statusLabel(code.trim() || code),
        code,
        direction: "working" as const
      };
    });
}

export function statusLabel(code: string): string {
  const normalized = code.trim();
  if (normalized === "A" || normalized.includes("A")) return "Added";
  if (normalized === "M" || normalized.includes("M")) return "Modified";
  if (normalized === "D" || normalized.includes("D")) return "Deleted";
  if (normalized.startsWith("R")) return "Renamed";
  if (normalized.startsWith("C")) return "Copied";
  if (normalized === "??") return "Untracked";
  if (normalized.includes("U")) return "Unmerged";
  return normalized || "Changed";
}

export function uniquePaths(files: ChangedFile[]): string[] {
  return [...new Set(files.map((file) => file.path))].sort((a, b) => a.localeCompare(b));
}
