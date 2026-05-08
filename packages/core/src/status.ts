import {
  git,
  GitOperationError,
  parseCommits,
  parseCurrentBranch,
  parseNameStatus,
  parsePorcelainStatus,
  parseRemoteHeadBranch,
  parseRemotes,
  parseRemoteTrackingBranches,
  toProjectError,
  uniquePaths
} from "./git";
import type {
  ChangedFile,
  CommitOptions,
  ConflictRiskLevel,
  DiffOptions,
  GitExecutor,
  OverleafRemote,
  ProjectError,
  ProjectStatus,
  StatusOptions,
  SyncOptions,
  SyncResult
} from "./types";

const DEFAULT_REMOTE = "overleaf";

function isNonBlockingOverlap(path: string): boolean {
  return path.split(/[\\/]/).at(-1) === ".gitignore";
}

export async function getProjectStatus(options: StatusOptions): Promise<ProjectStatus> {
  const remoteName = options.remoteName?.trim() || DEFAULT_REMOTE;
  const now = options.now ?? (() => new Date());
  const status = emptyStatus(options.projectPath);
  const errors: ProjectError[] = [];

  status.isGitRepo = await isGitRepo(options.executor, options.projectPath);
  if (!status.isGitRepo) {
    status.errors = [{ code: "not_git_repo", message: "Selected folder is not a Git repository." }];
    status.recommendation = "Choose a paper folder that is already connected to Overleaf with Git.";
    return status;
  }

  status.branch = parseCurrentBranch(await git(options.executor, options.projectPath, ["branch", "--show-current"]));

  const remotes = parseRemotes(await git(options.executor, options.projectPath, ["remote", "-v"]));
  const remote = remotes.find((candidate) => candidate.name === remoteName);
  if (!remote) {
    status.errors = [
      {
        code: "overleaf_remote_missing",
        message: `Remote '${remoteName}' is missing.`
      }
    ];
    status.recommendation = `Add an Overleaf Git remote named '${remoteName}', or change the remote name in Settings.`;
    status.workingTree = await workingTree(options.executor, options.projectPath);
    return status;
  }

  const checkedAt = now().toISOString();
  if (options.fetch !== false) {
    try {
      await git(options.executor, options.projectPath, ["fetch", remoteName, "--prune"], "fetch_failed");
    } catch (error) {
      errors.push(toProjectError(error, "fetch_failed"));
    }
  }
  status.lastFetchedAt = checkedAt;

  status.workingTree = await workingTree(options.executor, options.projectPath);

  const remoteBranch = await detectRemoteBranch(options.executor, options.projectPath, remoteName, status.branch);
  if (!remoteBranch) {
    status.overleafRemote = { ...remote, branch: "" };
    status.errors = [
      ...errors,
      {
        code: "remote_branch_missing",
        message: `No branch could be detected for remote '${remoteName}'.`
      }
    ];
    status.recommendation = "Fetch succeeded, but LeafBridge could not determine which Overleaf branch to compare.";
    return status;
  }

  status.overleafRemote = { ...remote, branch: remoteBranch };
  const remoteRef = `${remoteName}/${remoteBranch}`;

  try {
    const comparisonBase = await git(options.executor, options.projectPath, ["merge-base", "HEAD", remoteRef]);
    const baseRef = comparisonBase.trim() || "HEAD";
    status.incoming.commits = parseCommits(
      await git(options.executor, options.projectPath, ["log", "--oneline", `HEAD..${remoteRef}`])
    );
    status.outgoing.commits = parseCommits(
      await git(options.executor, options.projectPath, ["log", "--oneline", `${remoteRef}..HEAD`])
    );
    status.incoming.files = parseNameStatus(
      await git(options.executor, options.projectPath, ["diff", "--name-status", `${baseRef}..${remoteRef}`]),
      "incoming"
    );
    status.outgoing.files = parseNameStatus(
      await git(options.executor, options.projectPath, ["diff", "--name-status", `${baseRef}..HEAD`]),
      "outgoing"
    );
  } catch (error) {
    errors.push(toProjectError(error));
  }

  status.incoming.hasChanges = status.incoming.commits.length > 0 || status.incoming.files.length > 0;
  status.outgoing.hasChanges = status.outgoing.commits.length > 0 || status.outgoing.files.length > 0;
  status.conflictRisk = computeConflictRisk(status.incoming.files, status.outgoing.files, status.workingTree.files);
  status.errors = [...errors, ...safetyErrors(status)];
  status.recommendation = recommendation(status);
  return status;
}

export async function getFileDiff(options: DiffOptions): Promise<string> {
  const remoteName = options.remoteName?.trim() || DEFAULT_REMOTE;
  const remoteRef = `${remoteName}/${options.remoteBranch}`;
  const comparisonBase = await git(options.executor, options.projectPath, ["merge-base", "HEAD", remoteRef]);
  const baseRef = comparisonBase.trim() || "HEAD";
  if (options.direction === "incoming") {
    return git(options.executor, options.projectPath, ["diff", `${baseRef}..${remoteRef}`, "--", options.filePath]);
  }
  if (options.direction === "outgoing") {
    return git(options.executor, options.projectPath, ["diff", `${baseRef}..HEAD`, "--", options.filePath]);
  }
  return git(options.executor, options.projectPath, ["diff", "HEAD", "--", options.filePath]);
}

export async function pullFromOverleaf(options: SyncOptions): Promise<SyncResult> {
  const status = await getProjectStatus({ ...options, fetch: true });
  const guard = guardPull(status, options.forceIfDirty);
  if (guard) return { ok: false, status, error: guard };

  try {
    const remote = status.overleafRemote!;
    const output = await git(
      options.executor,
      options.projectPath,
      ["pull", "--rebase", remote.name, remote.branch],
      "pull_failed"
    );
    return { ok: true, output, status };
  } catch (error) {
    return { ok: false, status, error: toProjectError(error, "pull_failed") };
  }
}

export async function pushToOverleaf(options: SyncOptions): Promise<SyncResult> {
  const status = await getProjectStatus({ ...options, fetch: true });
  const guard = guardPush(status);
  if (guard) return { ok: false, status, error: guard };

  try {
    const remote = status.overleafRemote!;
    const output = await git(
      options.executor,
      options.projectPath,
      ["push", remote.name, `HEAD:${remote.branch}`],
      "push_failed"
    );
    return { ok: true, output, status };
  } catch (error) {
    return { ok: false, status, error: toProjectError(error, "push_failed") };
  }
}

export async function commitLocalChanges(options: CommitOptions): Promise<SyncResult> {
  const message = options.message.trim();
  const files = options.files?.map((file) => file.trim()).filter(Boolean);
  const status = await getProjectStatus({ ...options, fetch: false });
  const guard = guardCommit(status, message, files);
  if (guard) return { ok: false, status, error: guard };

  try {
    await git(options.executor, options.projectPath, files ? ["add", "--", ...files] : ["add", "-A"], "commit_failed");
    const output = await git(options.executor, options.projectPath, ["commit", "-m", message], "commit_failed");
    return { ok: true, output, status };
  } catch (error) {
    return { ok: false, status, error: toProjectError(error, "commit_failed") };
  }
}

export function deriveOverleafGitUrl(overleafUrl: string): string | undefined {
  const rawUrl = overleafUrl.trim();
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.hostname === "git.overleaf.com") {
      const projectId = url.pathname.split("/").filter(Boolean)[0];
      return projectId ? `https://git.overleaf.com/${projectId}` : undefined;
    }
    if (!url.hostname.endsWith("overleaf.com")) return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    const projectIndex = parts.findIndex((part) => part === "project");
    const projectId = projectIndex >= 0 ? parts[projectIndex + 1] : undefined;
    return projectId ? `https://git.overleaf.com/${projectId}` : undefined;
  } catch {
    return undefined;
  }
}

export function classifyPrepareFiles(files: ChangedFile[]): { included: ChangedFile[]; excluded: ChangedFile[] } {
  const included: ChangedFile[] = [];
  const excluded: ChangedFile[] = [];
  for (const file of files) {
    if (isLikelyGeneratedUntrackedFile(file)) {
      excluded.push(file);
    } else {
      included.push(file);
    }
  }
  return { included, excluded };
}

export function computeConflictRisk(
  incomingFiles: ChangedFile[],
  outgoingFiles: ChangedFile[],
  workingFiles: ChangedFile[]
): { level: ConflictRiskLevel; files: string[] } {
  const incoming = new Set(uniquePaths(incomingFiles));
  const local = new Set(uniquePaths([...outgoingFiles, ...workingFiles]));
  const overlap = [...incoming]
    .filter((path) => local.has(path) && !isNonBlockingOverlap(path))
    .sort((a, b) => a.localeCompare(b));
  if (overlap.length > 0) return { level: "high", files: overlap };
  if (incomingFiles.length > 0 && workingFiles.length > 0) return { level: "medium", files: [] };
  if (incomingFiles.length > 0 && outgoingFiles.length > 0) return { level: "low", files: [] };
  return { level: "none", files: [] };
}

async function isGitRepo(executor: GitExecutor, projectPath: string): Promise<boolean> {
  try {
    const output = await git(executor, projectPath, ["rev-parse", "--is-inside-work-tree"]);
    return output.trim() === "true";
  } catch {
    return false;
  }
}

async function workingTree(executor: GitExecutor, projectPath: string): Promise<ProjectStatus["workingTree"]> {
  const files = parsePorcelainStatus(await git(executor, projectPath, ["status", "--porcelain"]));
  return {
    clean: files.length === 0,
    files
  };
}

async function detectRemoteBranch(
  executor: GitExecutor,
  projectPath: string,
  remoteName: string,
  currentBranch?: string
): Promise<string | undefined> {
  let headBranch: string | undefined;
  try {
    headBranch = parseRemoteHeadBranch(await git(executor, projectPath, ["remote", "show", "-n", remoteName]));
  } catch (error) {
    if (!(error instanceof GitOperationError)) throw error;
  }

  const branches = parseRemoteTrackingBranches(
    await git(executor, projectPath, ["for-each-ref", `refs/remotes/${remoteName}`, "--format=%(refname:short)"]),
    remoteName
  );
  if (headBranch && branches.includes(headBranch)) return headBranch;
  if (currentBranch && branches.includes(currentBranch)) return currentBranch;
  if (headBranch) return headBranch;
  if (branches.length === 1) return branches[0];
  return undefined;
}

function safetyErrors(status: ProjectStatus): ProjectError[] {
  const errors: ProjectError[] = [];
  if (!status.workingTree.clean) {
    errors.push({
      code: "local_uncommitted_changes",
      message: "Local edits are not prepared yet."
    });
  }
  if (status.conflictRisk.level === "high") {
    errors.push({
      code: "conflict_risk",
      message: "The same files changed locally and on Overleaf.",
      detail: status.conflictRisk.files.join("\n")
    });
  }
  return errors;
}

function guardPull(status: ProjectStatus, forceIfDirty?: boolean): ProjectError | undefined {
  if (!status.isGitRepo) return { code: "not_git_repo", message: "Cannot update because this folder is not a Git repo." };
  if (!status.overleafRemote?.branch) {
    return { code: "remote_branch_missing", message: "Cannot update because the Overleaf branch was not detected." };
  }
  if (!status.workingTree.clean && !forceIfDirty) {
    return {
      code: "local_uncommitted_changes",
      message: "Update from Overleaf is blocked while local edits are not prepared."
    };
  }
  if (status.conflictRisk.level === "high") {
    return {
      code: "conflict_risk",
      message: "Update from Overleaf is blocked because the same files changed locally and on Overleaf.",
      detail: status.conflictRisk.files.join("\n")
    };
  }
  return undefined;
}

function guardPush(status: ProjectStatus): ProjectError | undefined {
  if (!status.isGitRepo) return { code: "not_git_repo", message: "Cannot send because this folder is not a Git repo." };
  if (!status.overleafRemote?.branch) {
    return { code: "remote_branch_missing", message: "Cannot send because the Overleaf branch was not detected." };
  }
  if (!status.workingTree.clean) {
    return {
      code: "local_uncommitted_changes",
      message: "Send to Overleaf is blocked while local edits are not prepared."
    };
  }
  if (status.incoming.hasChanges) {
    return {
      code: "conflict_risk",
      message: "Send to Overleaf is blocked because Overleaf has changes that are not local yet."
    };
  }
  return undefined;
}

function guardCommit(status: ProjectStatus, message: string, files?: string[]): ProjectError | undefined {
  if (!status.isGitRepo) return { code: "not_git_repo", message: "Cannot prepare local update because this folder is not a Git repo." };
  if (!message) return { code: "commit_failed", message: "An update note is required." };
  if (status.workingTree.clean) {
    return {
      code: "no_local_changes",
      message: "There are no local edits to prepare."
    };
  }
  if (files && files.length === 0) {
    return {
      code: "no_local_changes",
      message: "Choose at least one local file to prepare."
    };
  }
  return undefined;
}

function recommendation(status: ProjectStatus): string {
  if (status.errors.some((error) => error.code === "authentication_failed")) {
    return "Overleaf authentication failed. Check your Git credentials, then try Check now again.";
  }
  if (!status.workingTree.clean && status.incoming.hasChanges) {
    return "Prepare or set aside local edits before updating from Overleaf.";
  }
  if (status.conflictRisk.level === "high") {
    return "Inspect the overlapping files before updating from Overleaf; manual resolution may be needed.";
  }
  if (status.incoming.hasChanges) {
    return "Overleaf has new changes. Inspect them, then update the local folder when ready.";
  }
  if (status.outgoing.hasChanges) {
    return "A local update is ready to send to Overleaf.";
  }
  if (!status.workingTree.clean) {
    return "Local edits need to be prepared before they can be sent to Overleaf.";
  }
  return "Local folder and Overleaf match as of the last check.";
}

function emptyStatus(projectPath: string): ProjectStatus {
  return {
    projectPath,
    projectName: projectNameFromPath(projectPath),
    isGitRepo: false,
    workingTree: {
      clean: true,
      files: []
    },
    incoming: {
      hasChanges: false,
      commits: [],
      files: []
    },
    outgoing: {
      hasChanges: false,
      commits: [],
      files: []
    },
    conflictRisk: {
      level: "none",
      files: []
    },
    recommendation: "Select a local paper folder to begin.",
    errors: []
  };
}

function projectNameFromPath(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath;
}

function isLikelyGeneratedUntrackedFile(file: ChangedFile): boolean {
  if (file.direction !== "working" || file.code.trim() !== "??") return false;
  const normalizedPath = file.path.replace(/\\/g, "/").toLowerCase();
  if (normalizedPath === "outputs" || normalizedPath.startsWith("outputs/")) return true;
  return [
    ".aux",
    ".log",
    ".out",
    ".toc",
    ".fls",
    ".fdb_latexmk",
    ".synctex.gz",
    ".bbl",
    ".blg"
  ].some((suffix) => normalizedPath.endsWith(suffix));
}
