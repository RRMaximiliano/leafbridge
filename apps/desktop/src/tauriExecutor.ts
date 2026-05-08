import { invoke } from "@tauri-apps/api/core";
import type { GitCommandResult, GitExecutor } from "@leafbridge/core";

export const tauriGitExecutor: GitExecutor = {
  async runGit(projectPath: string, args: string[]): Promise<GitCommandResult> {
    return invoke<GitCommandResult>("run_git", { projectPath, args });
  }
};

export async function openExternalUrl(url: string): Promise<void> {
  await invoke("open_external_url", { url });
}

export async function openPathInFinder(path: string): Promise<void> {
  await invoke("open_path_in_finder", { path });
}
