export type ChangeDirection = "incoming" | "outgoing" | "working";

export type ConflictRiskLevel = "none" | "low" | "medium" | "high";

export type ChangedFile = {
  path: string;
  status: string;
  code: string;
  direction: ChangeDirection;
};

export type CommitSummary = {
  hash: string;
  subject: string;
};

export type OverleafRemote = {
  name: string;
  fetchUrl: string;
  pushUrl: string;
  branch: string;
};

export type ProjectErrorCode =
  | "not_git_repo"
  | "overleaf_remote_missing"
  | "authentication_failed"
  | "remote_branch_missing"
  | "local_uncommitted_changes"
  | "no_local_changes"
  | "conflict_risk"
  | "fetch_failed"
  | "commit_failed"
  | "pull_failed"
  | "push_failed"
  | "git_failed";

export type ProjectError = {
  code: ProjectErrorCode;
  message: string;
  detail?: string;
};

export type ProjectStatus = {
  projectPath: string;
  projectName: string;
  isGitRepo: boolean;
  branch?: string;
  overleafRemote?: OverleafRemote;
  lastFetchedAt?: string;
  workingTree: {
    clean: boolean;
    files: ChangedFile[];
  };
  incoming: {
    hasChanges: boolean;
    commits: CommitSummary[];
    files: ChangedFile[];
  };
  outgoing: {
    hasChanges: boolean;
    commits: CommitSummary[];
    files: ChangedFile[];
  };
  conflictRisk: {
    level: ConflictRiskLevel;
    files: string[];
  };
  recommendation: string;
  errors: ProjectError[];
};

export type GitCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitExecutor = {
  runGit(projectPath: string, args: string[]): Promise<GitCommandResult>;
};

export type StatusOptions = {
  projectPath: string;
  executor: GitExecutor;
  remoteName?: string;
  fetch?: boolean;
  now?: () => Date;
};

export type DiffOptions = {
  projectPath: string;
  executor: GitExecutor;
  remoteName?: string;
  remoteBranch: string;
  filePath: string;
  direction: ChangeDirection;
};

export type SyncOptions = {
  projectPath: string;
  executor: GitExecutor;
  remoteName?: string;
  forceIfDirty?: boolean;
};

export type CommitOptions = SyncOptions & {
  message: string;
  files?: string[];
};

export type SyncResult = {
  ok: boolean;
  status?: ProjectStatus;
  output?: string;
  error?: ProjectError;
};
