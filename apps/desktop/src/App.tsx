import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Archive,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ExternalLink,
  FolderOpen,
  GitCompareArrows,
  History,
  Loader2,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  ChevronDown,
  X
} from "lucide-react";
import {
  classifyPrepareFiles,
  commitLocalChanges,
  deriveOverleafGitUrl,
  getFileDiff,
  getProjectStatus,
  pullFromOverleaf,
  pushToOverleaf,
  type ChangedFile,
  type ChangeDirection,
  type ProjectStatus
} from "@leafbridge/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { openExternalUrl, openPathInFinder, tauriGitExecutor } from "./tauriExecutor";

type ViewKey = "review" | "activity" | "settings";
type ActivityKind = "fetch" | "pull" | "push" | "commit" | "diff" | "settings" | "error";
type BridgeActionKind = "update" | "send";
type SetupStepState = "complete" | "current" | "blocked";
type PrepareSelection = Record<string, boolean>;
type ActivityEntry = {
  id: string;
  at: string;
  kind: ActivityKind;
  level: "info" | "success" | "warning" | "error";
  message: string;
  detail?: string;
};
type StoredSettings = {
  projectPath: string;
  remoteName: string;
  overleafUrl: string;
  autoFetch: boolean;
  autoFetchInterval: number;
  showAdvancedGitOutput: boolean;
  recentProjects: string[];
  projectAliases: Record<string, string>;
  pinnedProjects: string[];
  archivedProjects: string[];
  sidebarCollapsed: boolean;
};

const defaultSettings: StoredSettings = {
  projectPath: "",
  remoteName: "overleaf",
  overleafUrl: "",
  autoFetch: true,
  autoFetchInterval: 5,
  showAdvancedGitOutput: false,
  recentProjects: [],
  projectAliases: {},
  pinnedProjects: [],
  archivedProjects: [],
  sidebarCollapsed: false
};

const settingsKey = "leafbridge.settings.v1";
const activityKey = "leafbridge.activity.v1";

export default function App() {
  const [settings, setSettings] = useState<StoredSettings>(() => loadSettings());
  const [view, setView] = useState<ViewKey>("review");
  const [status, setStatus] = useState<ProjectStatus | undefined>();
  const [activity, setActivity] = useState<ActivityEntry[]>(() => loadActivity());
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<{ file: ChangedFile; text: string } | undefined>();
  const [diffBusy, setDiffBusy] = useState(false);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectMenu, setProjectMenu] = useState<{ path: string; x: number; y: number } | undefined>();
  const [renameTarget, setRenameTarget] = useState<string | undefined>();
  const [renameValue, setRenameValue] = useState("");
  const [prepareDialogOpen, setPrepareDialogOpen] = useState(false);
  const [prepareMessage, setPrepareMessage] = useState("");
  const [prepareSelection, setPrepareSelection] = useState<PrepareSelection>({});
  const [bridgeAction, setBridgeAction] = useState<BridgeActionKind | undefined>();
  const [checkingKey, setCheckingKey] = useState<string | undefined>();
  const initialLoaded = useRef(false);
  const statusRef = useRef<ProjectStatus | undefined>(undefined);
  const statusCache = useRef(new Map<string, ProjectStatus>());
  const activeProjectKey = useRef(statusCacheKey(settings.projectPath, settings.remoteName));
  const statusRequestId = useRef(0);
  const diffRequestId = useRef(0);

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem(activityKey, JSON.stringify(activity));
  }, [activity]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    activeProjectKey.current = statusCacheKey(settings.projectPath, settings.remoteName);
  }, [settings.projectPath, settings.remoteName]);

  useEffect(() => {
    if (!projectMenu) return;
    const close = () => setProjectMenu(undefined);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProjectMenu(undefined);
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [projectMenu]);

  useEffect(() => {
    if (!projectSearchOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProjectSearchOpen(false);
        setProjectSearch("");
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [projectSearchOpen]);

  useEffect(() => {
    if (initialLoaded.current || !settings.projectPath) return;
    initialLoaded.current = true;
    void checkNow("fetch");
  }, [settings.projectPath]);

  useEffect(() => {
    if (!settings.autoFetch || !settings.projectPath) return;
    const intervalMs = Math.max(settings.autoFetchInterval, 1) * 60 * 1000;
    const id = window.setInterval(() => {
      void checkNow("fetch", true);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [settings.autoFetch, settings.autoFetchInterval, settings.projectPath, settings.remoteName]);

  const conflictFiles = useMemo(() => new Set(status?.conflictRisk.files ?? []), [status]);
  const visibleProjects = useMemo(() => {
    const archived = new Set(settings.archivedProjects);
    const pinned = new Set(settings.pinnedProjects);
    return settings.recentProjects
      .filter((path) => !archived.has(path))
      .sort((a, b) => Number(pinned.has(b)) - Number(pinned.has(a)) || projectDisplayName(a, settings).localeCompare(projectDisplayName(b, settings)));
  }, [settings]);
  const searchedProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    if (!query) return visibleProjects;
    return visibleProjects.filter((path) => projectDisplayName(path, settings).toLowerCase().includes(query) || path.toLowerCase().includes(query));
  }, [projectSearch, settings, visibleProjects]);
  const canPull = Boolean(status?.incoming.hasChanges && status?.workingTree.clean && status?.conflictRisk.level !== "high");
  const canPush = Boolean(status?.outgoing.hasChanges && status?.workingTree.clean && !status?.incoming.hasChanges);
  const canCommit = Boolean(status?.isGitRepo && !status.workingTree.clean);
  const pullTitle = canPull
    ? "Update the local folder from Overleaf"
    : "Updating requires Overleaf changes, no unprepared local edits, and no high conflict risk";
  const pushTitle = canPush
    ? "Send the prepared local update to Overleaf"
    : "Sending requires a prepared local update and no Overleaf changes waiting to be brought local";
  const commitTitle = canCommit ? "Prepare local edits so they can be sent to Overleaf" : "Preparing requires local edits";

  useEffect(() => {
    if (!status?.overleafRemote?.branch || busy || checkingKey) return;
    const reviewFiles = reviewFilesForStatus(status);
    if (reviewFiles.length === 0) {
      setDiff(undefined);
      return;
    }
    if (diff && reviewFiles.some((file) => fileKey(file) === fileKey(diff.file))) return;
    void loadDiff(reviewFiles[0], true);
  }, [busy, checkingKey, status]);

  async function chooseProject() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose paper project folder"
    });
    if (typeof selected !== "string") return;
    const nextSettings = {
      ...settings,
      projectPath: selected,
      recentProjects: [selected, ...settings.recentProjects.filter((path) => path !== selected)],
      archivedProjects: settings.archivedProjects.filter((path) => path !== selected)
    };
    const key = statusCacheKey(selected, nextSettings.remoteName);
    activeProjectKey.current = key;
    setSettings(nextSettings);
    setStatus(statusCache.current.get(key));
    setDiff(undefined);
    diffRequestId.current += 1;
    setView("review");
    addActivity("settings", "info", "Project folder changed.", selected);
    await refreshStatus(selected, nextSettings.remoteName, false, "settings");
  }

  async function selectProject(path: string) {
    const nextSettings = {
      ...settings,
      projectPath: path,
      recentProjects: [path, ...settings.recentProjects.filter((candidate) => candidate !== path)]
    };
    const key = statusCacheKey(path, nextSettings.remoteName);
    activeProjectKey.current = key;
    setSettings(nextSettings);
    setStatus(statusCache.current.get(key));
    setView("review");
    setDiff(undefined);
    diffRequestId.current += 1;
    await refreshStatus(path, nextSettings.remoteName, false, "settings");
  }

  async function checkNow(kind: ActivityKind = "fetch", quiet = false) {
    if (!settings.projectPath) return;
    await refreshStatus(settings.projectPath, settings.remoteName, quiet, kind);
  }

  async function refreshStatus(projectPath: string, remoteName: string, quiet = false, kind: ActivityKind = "fetch", fetch = true) {
    const key = statusCacheKey(projectPath, remoteName);
    const requestId = ++statusRequestId.current;
    setBusy(true);
    setCheckingKey(key);
    try {
      const next = await getProjectStatus({
        projectPath,
        remoteName,
        fetch,
        executor: tauriGitExecutor
      });
      statusCache.current.set(key, next);
      if (activeProjectKey.current !== key || statusRequestId.current !== requestId) return;
      const backgroundOverleafChange =
        quiet && next.incoming.hasChanges && incomingSignature(statusRef.current) !== incomingSignature(next);
      statusRef.current = next;
      setStatus(next);
      if (backgroundOverleafChange) {
        addActivity("fetch", "warning", "Overleaf changed in the background.", summarizeOverleafChanges(next));
      } else if (!quiet) {
        const errors = next.errors.map((error) => error.message).join("\n");
        addActivity(
          kind,
          next.errors.length ? "warning" : "success",
          next.errors.length ? "Checked project with warnings." : "Checked project status.",
          errors || summarizeStatus(next)
        );
      }
    } catch (error) {
      if (activeProjectKey.current !== key || statusRequestId.current !== requestId) return;
      addActivity("error", "error", "Status check failed.", errorDetail(error));
    } finally {
      if (statusRequestId.current === requestId) {
        setBusy(false);
        setCheckingKey(undefined);
      }
    }
  }

  async function loadDiff(file: ChangedFile, silent = false) {
    if (!status?.overleafRemote?.branch) return;
    const projectPath = settings.projectPath;
    const remoteName = settings.remoteName;
    const remoteBranch = status.overleafRemote.branch;
    const key = statusCacheKey(projectPath, remoteName);
    const requestId = ++diffRequestId.current;
    setDiffBusy(true);
    setDiff({ file, text: "" });
    try {
      const text = await getFileDiff({
        projectPath,
        remoteName,
        remoteBranch,
        filePath: file.path,
        direction: file.direction,
        executor: tauriGitExecutor
      });
      if (activeProjectKey.current !== key || diffRequestId.current !== requestId) return;
      setDiff({ file, text: text || "No textual diff is available for this file." });
      if (!silent) addActivity("diff", "info", `Opened diff for ${file.path}.`);
    } catch (error) {
      if (activeProjectKey.current !== key || diffRequestId.current !== requestId) return;
      const detail = errorDetail(error);
      setDiff({ file, text: detail });
      addActivity("error", "error", `Diff failed for ${file.path}.`, detail);
    } finally {
      if (diffRequestId.current === requestId) setDiffBusy(false);
    }
  }

  async function pull() {
    if (!status?.overleafRemote) return;
    setBusy(true);
    const result = await pullFromOverleaf({
      projectPath: settings.projectPath,
      remoteName: settings.remoteName,
      executor: tauriGitExecutor
    });
    if (result.ok) {
      setBridgeAction(undefined);
      addActivity("pull", "success", "Updated local folder from Overleaf.", result.output);
      await checkNow("pull");
    } else {
      addActivity("pull", "error", result.error?.message ?? "Update from Overleaf failed.", result.error?.detail);
      if (result.status) setStatus(result.status);
    }
    setBusy(false);
  }

  async function push() {
    if (!status?.overleafRemote) return;
    setBusy(true);
    const result = await pushToOverleaf({
      projectPath: settings.projectPath,
      remoteName: settings.remoteName,
      executor: tauriGitExecutor
    });
    if (result.ok) {
      setBridgeAction(undefined);
      addActivity("push", "success", "Sent local update to Overleaf.", result.output);
      await checkNow("push");
    } else {
      addActivity("push", "error", result.error?.message ?? "Send to Overleaf failed.", result.error?.detail);
      if (result.status) setStatus(result.status);
    }
    setBusy(false);
  }

  function openPrepareLocalUpdate() {
    if (!status?.isGitRepo || status.workingTree.clean) return;
    const classified = classifyPrepareFiles(status.workingTree.files);
    const nextSelection: PrepareSelection = {};
    for (const file of classified.included) nextSelection[file.path] = true;
    for (const file of classified.excluded) nextSelection[file.path] = false;
    setPrepareSelection(nextSelection);
    setPrepareMessage(defaultPrepareMessage(status));
    setPrepareDialogOpen(true);
  }

  async function prepareLocalUpdate(message: string, selection: PrepareSelection) {
    if (!status?.isGitRepo || status.workingTree.clean) return;
    const preparedMessage = message.trim();
    if (!preparedMessage) return;
    const selectedFiles = status.workingTree.files.filter((file) => selection[file.path]).map((file) => file.path);
    if (selectedFiles.length === 0) return;

    setBusy(true);
    const result = await commitLocalChanges({
      projectPath: settings.projectPath,
      remoteName: settings.remoteName,
      message: preparedMessage,
      files: selectedFiles,
      executor: tauriGitExecutor
    });
    if (result.ok) {
      setPrepareDialogOpen(false);
      setPrepareMessage("");
      setPrepareSelection({});
      addActivity("commit", "success", "Prepared local update.", result.output);
      await refreshStatus(settings.projectPath, settings.remoteName, false, "commit", false);
    } else {
      addActivity("error", "error", result.error?.message ?? "Could not prepare local update.", result.error?.detail);
      if (result.status) setStatus(result.status);
    }
    setBusy(false);
  }

  async function openOverleaf() {
    if (!settings.overleafUrl) return;
    try {
      await openExternalUrl(settings.overleafUrl);
      addActivity("settings", "info", "Opened Overleaf project.");
    } catch (error) {
      addActivity("error", "error", "Could not open Overleaf URL.", errorDetail(error));
    }
  }

  async function openProjectInFinder(path: string) {
    try {
      await openPathInFinder(path);
      addActivity("settings", "info", "Opened project in Finder.", path);
    } catch (error) {
      addActivity("error", "error", "Could not open project in Finder.", errorDetail(error));
    }
  }

  function beginRenameProject(path: string) {
    setProjectMenu(undefined);
    setRenameTarget(path);
    setRenameValue(projectDisplayName(path, settings));
  }

  function saveProjectRename() {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) {
      setRenameTarget(undefined);
      setRenameValue("");
      return;
    }
    updateSettings({
      projectAliases: {
        ...settings.projectAliases,
        [renameTarget]: name
      }
    });
    setRenameTarget(undefined);
    setRenameValue("");
  }

  function pinProject(path: string) {
    const pinned = new Set(settings.pinnedProjects);
    if (pinned.has(path)) {
      pinned.delete(path);
    } else {
      pinned.add(path);
    }
    updateSettings({ pinnedProjects: [...pinned] });
  }

  function archiveProject(path: string) {
    updateSettings({
      archivedProjects: [path, ...settings.archivedProjects.filter((candidate) => candidate !== path)],
      projectPath: settings.projectPath === path ? "" : settings.projectPath
    });
    if (settings.projectPath === path) setStatus(undefined);
  }

  function removeProject(path: string) {
    const { [path]: _removedAlias, ...projectAliases } = settings.projectAliases;
    updateSettings({
      projectPath: settings.projectPath === path ? "" : settings.projectPath,
      recentProjects: settings.recentProjects.filter((candidate) => candidate !== path),
      pinnedProjects: settings.pinnedProjects.filter((candidate) => candidate !== path),
      archivedProjects: settings.archivedProjects.filter((candidate) => candidate !== path),
      projectAliases
    });
    if (settings.projectPath === path) setStatus(undefined);
  }

  function updateSettings(patch: Partial<StoredSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function addActivity(kind: ActivityKind, level: ActivityEntry["level"], message: string, detail?: string) {
    setActivity((entries) =>
      [
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          kind,
          level,
          message,
          detail
        },
        ...entries
      ].slice(0, 200)
    );
  }

  return (
    <div className={`app-shell ${settings.sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div className="window-drag-region" data-tauri-drag-region aria-hidden="true" />
      <button
        type="button"
        className="sidebar-toggle"
        data-tauri-drag-region="false"
        onClick={() => updateSettings({ sidebarCollapsed: !settings.sidebarCollapsed })}
        title={settings.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        aria-label={settings.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
      >
        <PanelLeft size={14} strokeWidth={1.75} />
      </button>
      <aside className="source-rail" aria-label="LeafBridge navigation">
        <nav className="rail-nav primary">
          <SidebarAction icon={<Plus size={15} />} label="New project" onClick={chooseProject} />
          <SidebarAction
            icon={<Search size={15} />}
            label="Search"
            onClick={() => {
              setProjectSearchOpen(true);
              setProjectSearch("");
            }}
          />
          <SidebarAction
            icon={busy ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            label="Sync"
            onClick={() => {
              setView("review");
              void checkNow();
            }}
            disabled={!settings.projectPath || busy}
            title={settings.projectPath ? "Fetch from Overleaf and refresh status" : "Choose a project first"}
          />
          <NavButton view="review" current={view} setView={setView} icon={<GitCompareArrows size={15} />} label="Review" />
          <NavButton view="activity" current={view} setView={setView} icon={<History size={15} />} label="Activity" />
          <NavButton view="settings" current={view} setView={setView} icon={<SlidersHorizontal size={15} />} label="Settings" />
        </nav>
        <div className="recent-list">
          <div className="rail-label">Projects</div>
          {visibleProjects.length === 0 ? (
            <div className="muted-small">No projects</div>
          ) : (
            visibleProjects.map((path) => (
              <ProjectRow
                key={path}
                path={path}
                active={settings.projectPath === path}
                pinned={settings.pinnedProjects.includes(path)}
                name={projectDisplayName(path, settings)}
                onSelect={() => void selectProject(path)}
                onMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setProjectMenu({ path, x: event.clientX, y: event.clientY });
                }}
              />
            ))
          )}
        </div>
      </aside>

      <main className="stage">
        {view === "review" && (
          <ReviewSurface
            status={status}
            settings={settings}
            isChecking={checkingKey === statusCacheKey(settings.projectPath, settings.remoteName)}
            chooseProject={chooseProject}
            checkNow={() => void checkNow("settings")}
            openSettings={() => setView("settings")}
            diff={diff}
            diffBusy={diffBusy}
            loadDiff={loadDiff}
            conflictFiles={conflictFiles}
          />
        )}
        {view === "activity" && <ActivitySurface activity={activity} showAdvanced={settings.showAdvancedGitOutput} />}
        {view === "settings" && (
          <SettingsSurface
            settings={settings}
            status={status}
            activity={activity}
            updateSettings={updateSettings}
            chooseProject={chooseProject}
            refresh={() => void checkNow("settings")}
          />
        )}
      </main>

      <Inspector
        status={status}
        settings={settings}
        busy={busy}
        canPull={canPull}
        canPush={canPush}
        canCommit={canCommit}
        pullTitle={pullTitle}
        pushTitle={pushTitle}
        commitTitle={commitTitle}
        checkNow={() => void checkNow()}
        commitLocal={openPrepareLocalUpdate}
        pull={() => setBridgeAction("update")}
        push={() => setBridgeAction("send")}
        openOverleaf={() => void openOverleaf()}
      />
      {bridgeAction && status ? (
        <BridgeActionDialog
          kind={bridgeAction}
          status={status}
          canProceed={bridgeAction === "update" ? canPull : canPush}
          busy={busy}
          onCancel={() => setBridgeAction(undefined)}
          onConfirm={() => void (bridgeAction === "update" ? pull() : push())}
        />
      ) : null}
      {prepareDialogOpen && status ? (
        <PrepareUpdateDialog
          status={status}
          message={prepareMessage}
          busy={busy}
          onMessageChange={setPrepareMessage}
          onCancel={() => {
            setPrepareDialogOpen(false);
            setPrepareMessage("");
            setPrepareSelection({});
          }}
          selection={prepareSelection}
          onSelectionChange={setPrepareSelection}
          onPrepare={() => void prepareLocalUpdate(prepareMessage, prepareSelection)}
        />
      ) : null}
      {projectMenu ? (
        <ProjectMenu
          path={projectMenu.path}
          x={projectMenu.x}
          y={projectMenu.y}
          pinned={settings.pinnedProjects.includes(projectMenu.path)}
          onPin={() => pinProject(projectMenu.path)}
          onOpenFinder={() => void openProjectInFinder(projectMenu.path)}
          onRename={() => beginRenameProject(projectMenu.path)}
          onArchive={() => archiveProject(projectMenu.path)}
          onRemove={() => removeProject(projectMenu.path)}
        />
      ) : null}
      {renameTarget ? (
        <RenameProjectDialog
          value={renameValue}
          path={renameTarget}
          onValueChange={setRenameValue}
          onCancel={() => {
            setRenameTarget(undefined);
            setRenameValue("");
          }}
          onSave={saveProjectRename}
        />
      ) : null}
      {projectSearchOpen ? (
        <SearchOverlay
          query={projectSearch}
          projects={searchedProjects}
          settings={settings}
          onQueryChange={setProjectSearch}
          onClose={() => {
            setProjectSearchOpen(false);
            setProjectSearch("");
          }}
          onSelect={(path) => {
            setProjectSearchOpen(false);
            setProjectSearch("");
            void selectProject(path);
          }}
        />
      ) : null}
    </div>
  );
}

function ReviewSurface({
  status,
  settings,
  isChecking,
  chooseProject,
  checkNow,
  openSettings,
  diff,
  diffBusy,
  loadDiff,
  conflictFiles
}: {
  status?: ProjectStatus;
  settings: StoredSettings;
  isChecking: boolean;
  chooseProject: () => void;
  checkNow: () => void;
  openSettings: () => void;
  diff?: { file: ChangedFile; text: string };
  diffBusy: boolean;
  loadDiff: (file: ChangedFile) => void;
  conflictFiles: Set<string>;
}) {
  if (!settings.projectPath) {
    return <SetupSurface status={status} settings={settings} chooseProject={chooseProject} checkNow={checkNow} openSettings={openSettings} />;
  }

  if (!status && isChecking) {
    return <CheckingSurface settings={settings} />;
  }

  const incoming = status?.incoming.files ?? [];
  const outgoing = status?.outgoing.files ?? [];
  const working = status?.workingTree.files ?? [];
  const riskyFiles = [...incoming, ...outgoing, ...working].filter((file, index, all) => {
    return conflictFiles.has(file.path) && all.findIndex((candidate) => candidate.path === file.path) === index;
  });
  const changedFileCount = new Set([...incoming, ...outgoing, ...working].map((file) => file.path)).size;
  const selectedFileKey = diff ? fileKey(diff.file) : "";
  const reviewItemCount =
    incoming.length + outgoing.length + working.length + riskyFiles.length + (status?.outgoing.commits.length ?? 0);
  const needsSetup = needsSetupSurface(settings, status);

  return (
    <section className="review-surface">
      <div className="review-brief">
        <div>
          <div className="project-title">{status?.projectName ?? projectLabel(settings.projectPath)}</div>
          <div className="project-path">{settings.projectPath}</div>
        </div>
      </div>

      <div className="recommendation-line">
        {status?.errors.length ? <ShieldAlert size={16} /> : <Check size={16} />}
        <span>{status?.recommendation ?? "Run Check now to inspect Overleaf and local changes."}</span>
      </div>

      <div className="status-facts" aria-label="Project status facts">
        <Fact label="Branch" value={status?.branch ?? "Unavailable"} />
        <Fact label="Overleaf" value={remoteLabel(status)} />
        <Fact label="Last checked" value={status?.lastFetchedAt ? formatTime(status.lastFetchedAt) : "Not checked"} />
        <Fact label="Local edits" value={status?.workingTree.clean ? "None" : `${working.length} not prepared`} />
      </div>

      {status?.errors.length ? (
        <div className="notice-list">
          {status.errors.map((error) => (
            <div className="notice-row" key={`${error.code}-${error.message}`}>
              <AlertTriangle size={14} />
              <span>{error.message}</span>
            </div>
          ))}
        </div>
      ) : null}

      {needsSetup ? (
        <SetupSurface
          status={status}
          settings={settings}
          chooseProject={chooseProject}
          checkNow={checkNow}
          openSettings={openSettings}
          compact
        />
      ) : null}

      {reviewItemCount > 0 ? (
        <>
          <div className="review-board">
            <FileSection
              title="Changed on Overleaf"
              files={incoming}
              empty="No incoming Overleaf files"
              onDiff={loadDiff}
              selectedKey={selectedFileKey}
            />
            <FileSection
              title="Prepared local changes"
              files={outgoing}
              empty="No prepared local file changes"
              onDiff={loadDiff}
              selectedKey={selectedFileKey}
            />
            <FileSection
              title="Local edits not prepared"
              files={working}
              empty="No local edits waiting to be prepared"
              onDiff={loadDiff}
              selectedKey={selectedFileKey}
            />
            <FileSection
              title="Overlap needs review"
              files={riskyFiles}
              empty="No overlapping files"
              onDiff={loadDiff}
              selectedKey={selectedFileKey}
              risk
            />
            <CommitSection commits={status?.outgoing.commits ?? []} />
          </div>

          <DiffReviewPanel diff={diff} diffBusy={diffBusy} changedFileCount={changedFileCount} />
        </>
      ) : (
        <ReviewEmptyState status={status} />
      )}
    </section>
  );
}

function ActivitySurface({ activity, showAdvanced }: { activity: ActivityEntry[]; showAdvanced: boolean }) {
  return (
    <section className="utility-surface">
      <div className="surface-title">
        <h1>Activity</h1>
        <p>Check, update, send, review, and error history.</p>
      </div>
      {activity.length === 0 ? (
        <div className="empty-inline">No activity yet.</div>
      ) : (
        <div className="activity-feed">
          {activity.map((entry) => (
            <div className={`activity-row ${entry.level}`} key={entry.id}>
              <div className="activity-time">{formatTime(entry.at)}</div>
              <div className="activity-main">
                <div className="activity-message">
                  <span className="activity-kind">{activityKindLabel(entry.kind)}</span>
                  <span>{entry.message}</span>
                </div>
                {entry.detail && showAdvanced ? <pre className="activity-detail">{entry.detail}</pre> : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CheckingSurface({ settings }: { settings: StoredSettings }) {
  return (
    <section className="review-surface checking-surface">
      <div className="review-brief">
        <div>
          <div className="project-title">{projectLabel(settings.projectPath)}</div>
          <div className="project-path">{settings.projectPath}</div>
        </div>
      </div>
      <div className="checking-panel">
        <Loader2 className="spin" size={18} />
        <div>
          <strong>Checking Overleaf</strong>
          <p>LeafBridge is reading the local folder and Overleaf remote. You can switch projects while this runs.</p>
        </div>
      </div>
    </section>
  );
}

function SettingsSurface({
  settings,
  status,
  activity,
  updateSettings,
  chooseProject,
  refresh
}: {
  settings: StoredSettings;
  status?: ProjectStatus;
  activity: ActivityEntry[];
  updateSettings: (patch: Partial<StoredSettings>) => void;
  chooseProject: () => void;
  refresh: () => void;
}) {
  return (
    <section className="utility-surface">
      <div className="surface-title">
        <h1>Settings</h1>
        <p>Project source, Overleaf remote, and background checking.</p>
      </div>
      <div className="settings-list">
        <SettingRow label="Project folder">
          <div className="setting-inline">
            <input value={settings.projectPath} readOnly placeholder="No folder selected" />
            <button type="button" onClick={chooseProject}>
              Change
            </button>
          </div>
        </SettingRow>
        <SettingRow label="Overleaf remote name">
          <input
            value={settings.remoteName}
            onChange={(event) => updateSettings({ remoteName: event.target.value || "overleaf" })}
            onBlur={refresh}
            aria-label="Overleaf remote name"
          />
        </SettingRow>
        <SettingRow label="Overleaf project URL">
          <input
            value={settings.overleafUrl}
            onChange={(event) => updateSettings({ overleafUrl: event.target.value })}
            placeholder="https://www.overleaf.com/project/..."
            aria-label="Overleaf project URL"
          />
        </SettingRow>
        <SettingRow label="Auto-fetch">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.autoFetch}
              onChange={(event) => updateSettings({ autoFetch: event.target.checked })}
            />
            <span>Check Overleaf in the background</span>
          </label>
        </SettingRow>
        <SettingRow label="Auto-fetch interval">
          <input
            type="number"
            min={1}
            max={120}
            value={settings.autoFetchInterval}
            onChange={(event) => updateSettings({ autoFetchInterval: Number(event.target.value) || 5 })}
            aria-label="Auto-fetch interval minutes"
          />
        </SettingRow>
        <SettingRow label="Technical output">
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={settings.showAdvancedGitOutput}
              onChange={(event) => updateSettings({ showAdvancedGitOutput: event.target.checked })}
            />
            <span>Show command output in Activity</span>
          </label>
        </SettingRow>
      </div>
      <DiagnosticsPanel status={status} settings={settings} activity={activity} />
    </section>
  );
}

function SetupSurface({
  status,
  settings,
  chooseProject,
  checkNow,
  openSettings,
  compact = false
}: {
  status?: ProjectStatus;
  settings: StoredSettings;
  chooseProject: () => void;
  checkNow: () => void;
  openSettings: () => void;
  compact?: boolean;
}) {
  const steps = setupSteps(settings, status);
  return (
    <section className={`setup-surface ${compact ? "compact" : ""}`} aria-label="Overleaf bridge setup">
      <div className="setup-header">
        <div>
          <h1>{compact ? "Setup needs attention" : "Connect an Overleaf project"}</h1>
          <p>LeafBridge checks one local paper folder against one Overleaf Git remote.</p>
        </div>
        {!compact ? (
          <button type="button" className="primary-button" onClick={chooseProject}>
            Choose folder
          </button>
        ) : null}
      </div>

      <div className="setup-steps">
        {steps.map((step) => (
          <div className={`setup-step ${step.state}`} key={step.label}>
            <span className="setup-step-icon">{step.state === "complete" ? <Check size={13} /> : step.state === "current" ? <RefreshCw size={13} /> : <AlertTriangle size={13} />}</span>
            <div>
              <strong>{step.label}</strong>
              <p>{step.detail}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="setup-actions">
        <button type="button" onClick={chooseProject}>
          Change folder
        </button>
        <button type="button" onClick={checkNow} disabled={!settings.projectPath}>
          Check setup
        </button>
        <button type="button" onClick={openSettings}>
          Open Settings
        </button>
      </div>
    </section>
  );
}

function DiagnosticsPanel({
  status,
  settings,
  activity
}: {
  status?: ProjectStatus;
  settings: StoredSettings;
  activity: ActivityEntry[];
}) {
  const latest = activity[0];
  const guidance = diagnosticGuidance(settings, status);
  return (
    <section className="diagnostics-panel" aria-label="Bridge diagnostics">
      <div className="surface-title small">
        <h1>Diagnostics</h1>
        <p>Current bridge detection and latest activity.</p>
      </div>
      <div className="diagnostic-grid">
        <Fact label="Folder" value={settings.projectPath ? projectLabel(settings.projectPath) : "Not selected"} />
        <Fact label="Branch" value={status?.branch ?? "Unavailable"} />
        <Fact label="Overleaf remote" value={(status?.overleafRemote?.name ?? settings.remoteName) || "Missing"} />
        <Fact label="Overleaf branch" value={status?.overleafRemote?.branch || "Unavailable"} />
        <Fact label="Last checked" value={status?.lastFetchedAt ? formatTime(status.lastFetchedAt) : "Not checked"} />
        <Fact label="Bridge state" value={syncHeadline(status)} />
      </div>
      <div className="diagnostic-detail">
        <div>
          <strong>Errors</strong>
          {status?.errors.length ? (
            <ul>
              {status.errors.map((error) => (
                <li key={`${error.code}-${error.message}`}>{error.message}</li>
              ))}
            </ul>
          ) : (
            <p>No setup errors detected.</p>
          )}
          {guidance.length ? (
            <div className="diagnostic-guidance">
              {guidance.map((item) => (
                <div className="guidance-item" key={item.title}>
                  <span>{item.title}</span>
                  <code>{item.detail}</code>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div>
          <strong>Latest activity</strong>
          {latest ? (
            <>
              <p>
                {activityKindLabel(latest.kind)}: {latest.message}
              </p>
              {settings.showAdvancedGitOutput && latest.detail ? <pre className="activity-detail">{latest.detail}</pre> : null}
            </>
          ) : (
            <p>No activity yet.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function Inspector({
  status,
  settings,
  busy,
  canPull,
  canPush,
  canCommit,
  pullTitle,
  pushTitle,
  commitTitle,
  checkNow,
  commitLocal,
  pull,
  push,
  openOverleaf
}: {
  status?: ProjectStatus;
  settings: StoredSettings;
  busy: boolean;
  canPull: boolean;
  canPush: boolean;
  canCommit: boolean;
  pullTitle: string;
  pushTitle: string;
  commitTitle: string;
  checkNow: () => void;
  commitLocal: () => void;
  pull: () => void;
  push: () => void;
  openOverleaf: () => void;
}) {
  return (
    <aside className="inspector" aria-label="Project inspector">
      <section className="inspector-block action-state">
        <h2>Sync</h2>
        <div className="inspector-state">
          <StatusBadge status={status} />
          <strong>{syncHeadline(status)}</strong>
        </div>
        <p>{status?.recommendation ?? "Choose a project and check Overleaf."}</p>
      </section>

      <section className="inspector-block action-stack">
        <button
          type="button"
          className="action-row"
          onClick={checkNow}
          disabled={!settings.projectPath || busy}
          title={settings.projectPath ? "Fetch from Overleaf and refresh status" : "Choose a project folder first"}
        >
          {busy ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          <span>Check now</span>
        </button>
        <button type="button" className="action-row" onClick={commitLocal} disabled={!canCommit || busy} title={commitTitle}>
          <Check size={15} />
          <span>Prepare local update</span>
        </button>
        <button type="button" className="action-row incoming" onClick={pull} disabled={!canPull || busy} title={pullTitle}>
          <ArrowDownToLine size={15} />
          <span>Update from Overleaf</span>
        </button>
        <button type="button" className="action-row outgoing" onClick={push} disabled={!canPush || busy} title={pushTitle}>
          <ArrowUpFromLine size={15} />
          <span>Send to Overleaf</span>
        </button>
        <button
          type="button"
          className="action-row"
          onClick={openOverleaf}
          disabled={!settings.overleafUrl}
          title={settings.overleafUrl ? "Open Overleaf project" : "Add an Overleaf project URL in Settings"}
        >
          <ExternalLink size={15} />
          <span>Open Overleaf</span>
        </button>
      </section>
    </aside>
  );
}

function ReviewEmptyState({ status }: { status?: ProjectStatus }) {
  const hasErrors = Boolean(status?.errors.length);
  return (
    <div className={`review-empty ${hasErrors ? "attention" : ""}`}>
      {hasErrors ? <AlertTriangle size={15} /> : <Check size={15} />}
      <div>
        <strong>{hasErrors ? "No file changes to inspect yet" : "No file changes"}</strong>
        <p>{status?.recommendation ?? "Run Check now to inspect Overleaf and local changes."}</p>
      </div>
    </div>
  );
}

type RenderedDiffLine = {
  kind: "meta" | "hunk" | "context" | "add" | "remove";
  oldLine?: number;
  newLine?: number;
  marker: string;
  content: string;
};

function DiffReviewPanel({
  diff,
  diffBusy,
  changedFileCount
}: {
  diff?: { file: ChangedFile; text: string };
  diffBusy: boolean;
  changedFileCount: number;
}) {
  const parsed = useMemo(() => parseUnifiedDiff(diff?.text ?? ""), [diff?.text]);
  const fileCountLabel = `${changedFileCount} ${changedFileCount === 1 ? "file" : "files"} changed`;

  return (
    <section className="diff-region" aria-label="Diff viewer">
      <div className="diff-review-header">
        <div className="diff-review-summary">
          <strong>{fileCountLabel}</strong>
          {diff?.text && !diffBusy ? (
            <span className="diff-stat">
              <span className="added">+{parsed.additions}</span>
              <span className="removed">-{parsed.deletions}</span>
            </span>
          ) : null}
        </div>
        <span className="diff-review-hint">{diff?.file ? "Selected diff" : "Select a file"}</span>
      </div>

      {diff?.file ? (
        <div className="diff-file-strip">
          <span className="diff-file-path">{diff.file.path}</span>
          <DirectionBadge direction={diff.file.direction} />
          <ChevronDown size={14} />
        </div>
      ) : null}

      <div className={`diff-code ${!diff?.file || diffBusy ? "empty" : ""}`}>
        {diffBusy ? (
          <div className="diff-placeholder">Loading diff...</div>
        ) : diff?.file ? (
          parsed.lines.length > 0 ? (
            parsed.lines.map((line, index) => (
              <div className={`diff-line ${line.kind}`} key={`${line.kind}-${index}-${line.oldLine ?? ""}-${line.newLine ?? ""}`}>
                <span className="line-number">{line.oldLine ?? ""}</span>
                <span className="line-number">{line.newLine ?? ""}</span>
                <span className="line-marker">{line.marker}</span>
                <code>{line.content || " "}</code>
              </div>
            ))
          ) : (
            <div className="diff-placeholder">No textual diff is available for this file.</div>
          )
        ) : (
          <div className="diff-placeholder">Select a changed file to inspect the exact diff.</div>
        )}
      </div>
    </section>
  );
}

function FileSection({
  title,
  files,
  empty,
  onDiff,
  selectedKey,
  risk = false
}: {
  title: string;
  files: ChangedFile[];
  empty: string;
  onDiff: (file: ChangedFile) => void;
  selectedKey: string;
  risk?: boolean;
}) {
  return (
    <section className="file-section">
      <div className="section-heading">
        <span>{title}</span>
        <strong>{files.length}</strong>
      </div>
      {files.length === 0 ? (
        <div className="empty-row">{empty}</div>
      ) : (
        <div className="file-table">
          {files.map((file) => (
            <button
              type="button"
              className={`file-row ${risk ? "risk" : ""} ${selectedKey === fileKey(file) ? "selected" : ""}`}
              key={`${title}-${file.path}-${file.direction}`}
              onClick={() => onDiff(file)}
              title={`Show diff for ${file.path}`}
            >
              <span className="file-path">{file.path}</span>
              <span className="file-status">{file.status}</span>
              <DirectionBadge direction={file.direction} />
              <span className="git-code">{file.code}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function CommitSection({ commits }: { commits: { hash: string; subject: string }[] }) {
  return (
    <section className="file-section">
      <div className="section-heading">
        <span>Prepared updates not sent</span>
        <strong>{commits.length}</strong>
      </div>
      {commits.length === 0 ? (
        <div className="empty-row">No prepared updates waiting to be sent</div>
      ) : (
        <div className="commit-list">
          {commits.map((commit) => (
            <div className="commit-row" key={commit.hash}>
              <code>{commit.hash}</code>
              <span>{commit.subject}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SidebarAction({
  icon,
  label,
  onClick,
  disabled,
  title
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" className="nav-button" onClick={onClick} disabled={disabled} title={title ?? label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ProjectRow({
  path,
  name,
  active,
  pinned,
  onSelect,
  onMenu
}: {
  path: string;
  name: string;
  active: boolean;
  pinned: boolean;
  onSelect: () => void;
  onMenu: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  return (
    <div className={`project-row ${active ? "active" : ""}`} onContextMenu={onMenu}>
      <button type="button" className="project-row-main" title={path} onClick={onSelect}>
        <FolderOpen size={13} />
        <span>{name}</span>
      </button>
      {pinned ? <Pin className="pin-indicator" size={12} /> : null}
      <button type="button" className="project-menu-button" onClick={onMenu} title={`Project actions for ${name}`} aria-label={`Project actions for ${name}`}>
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
}

function ProjectMenu({
  path,
  x,
  y,
  pinned,
  onPin,
  onOpenFinder,
  onRename,
  onArchive,
  onRemove
}: {
  path: string;
  x: number;
  y: number;
  pinned: boolean;
  onPin: () => void;
  onOpenFinder: () => void;
  onRename: () => void;
  onArchive: () => void;
  onRemove: () => void;
}) {
  const style = {
    left: Math.min(x, window.innerWidth - 190),
    top: Math.min(y, window.innerHeight - 178)
  };

  return (
    <div
      className="project-menu"
      style={style}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuAction icon={<Pin size={14} />} label={pinned ? "Unpin project" : "Pin project"} onClick={onPin} />
      <MenuAction icon={<FolderOpen size={14} />} label="Open in Finder" onClick={onOpenFinder} />
      <MenuAction icon={<Pencil size={14} />} label="Rename project" onClick={onRename} />
      <MenuAction icon={<Archive size={14} />} label="Archive" onClick={onArchive} />
      <MenuAction icon={<X size={14} />} label="Remove" onClick={onRemove} danger />
      <div className="project-menu-path" title={path}>
        {path}
      </div>
    </div>
  );
}

function SearchOverlay({
  query,
  projects,
  settings,
  onQueryChange,
  onSelect,
  onClose
}: {
  query: string;
  projects: string[];
  settings: StoredSettings;
  onQueryChange: (query: string) => void;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="search-backdrop" onMouseDown={onClose}>
      <div className="search-popover" role="dialog" aria-label="Search projects" onMouseDown={(event) => event.stopPropagation()}>
        <div className="search-input-row">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search projects"
            aria-label="Search projects"
            autoFocus
          />
        </div>
        <div className="search-results-label">Projects</div>
        <div className="search-results">
          {projects.length === 0 ? (
            <div className="search-empty">No matching projects</div>
          ) : (
            projects.slice(0, 9).map((path, index) => (
              <button type="button" className="search-result" key={path} onClick={() => onSelect(path)}>
                <FolderOpen size={14} />
                <span className="search-result-name">{projectDisplayName(path, settings)}</span>
                <span className="search-result-path">{projectLabel(path)}</span>
                <kbd>#{index + 1}</kbd>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function RenameProjectDialog({
  value,
  path,
  onValueChange,
  onCancel,
  onSave
}: {
  value: string;
  path: string;
  onValueChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <form
        className="rename-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <div>
          <h2>Rename project</h2>
          <p title={path}>{path}</p>
        </div>
        <input value={value} onChange={(event) => onValueChange(event.target.value)} aria-label="Project display name" autoFocus />
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="dialog-primary">
            Rename
          </button>
        </div>
      </form>
    </div>
  );
}

function BridgeActionDialog({
  kind,
  status,
  canProceed,
  busy,
  onCancel,
  onConfirm
}: {
  kind: BridgeActionKind;
  status: ProjectStatus;
  canProceed: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isUpdate = kind === "update";
  const files = isUpdate ? status.incoming.files : status.outgoing.files;
  const commits = isUpdate ? status.incoming.commits : status.outgoing.commits;
  const remote = status.overleafRemote;
  const title = isUpdate ? "Update from Overleaf" : "Send to Overleaf";
  const primary = isUpdate ? "Update local folder" : "Send update";
  const summary = isUpdate
    ? `Bring ${files.length} changed ${files.length === 1 ? "file" : "files"} from Overleaf into this folder.`
    : `Send ${commits.length} prepared local ${commits.length === 1 ? "update" : "updates"} to Overleaf.`;
  const disabledReason = isUpdate
    ? "Updating requires Overleaf changes, no unprepared local edits, and no high conflict risk."
    : "Sending requires a prepared local update and no Overleaf changes waiting to be brought local.";

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <form
        className="bridge-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (canProceed && !busy) onConfirm();
        }}
      >
        <div className="dialog-title-block">
          <h2>{title}</h2>
          <p>{summary}</p>
        </div>

        <div className="bridge-summary-grid">
          <Fact label="Branch" value={status.branch ?? "Unavailable"} />
          <Fact label="Overleaf" value={remote ? `${remote.name} -> ${remote.branch}` : "Unavailable"} />
          <Fact label={isUpdate ? "Overleaf updates" : "Prepared updates"} value={String(commits.length)} />
          <Fact label="Files affected" value={String(files.length)} />
        </div>

        <div className="bridge-section">
          <div className="bridge-section-title">
            <span>{isUpdate ? "Files changed on Overleaf" : "Files prepared locally"}</span>
            <strong>{files.length}</strong>
          </div>
          <div className="bridge-file-list">
            {files.length ? (
              files.map((file) => (
                <div className="bridge-file-row" key={`${file.direction}-${file.path}-${file.code}`}>
                  <span>{file.path}</span>
                  <em>{file.status}</em>
                </div>
              ))
            ) : (
              <div className="bridge-empty">No files to show.</div>
            )}
          </div>
        </div>

        <div className="bridge-section">
          <div className="bridge-section-title">
            <span>{isUpdate ? "Overleaf updates" : "Prepared local updates"}</span>
            <strong>{commits.length}</strong>
          </div>
          <div className="bridge-commit-list">
            {commits.length ? (
              commits.map((commit) => (
                <div className="bridge-commit-row" key={commit.hash}>
                  <code>{commit.hash}</code>
                  <span>{commit.subject}</span>
                </div>
              ))
            ) : (
              <div className="bridge-empty">No update notes to show.</div>
            )}
          </div>
        </div>

        <div className={`bridge-safety ${canProceed ? "" : "blocked"}`}>
          {canProceed ? (
            isUpdate ? (
              <span>LeafBridge will not send local changes, stash, reset, or force anything.</span>
            ) : (
              <span>LeafBridge will not force anything. Overleaf must already be local before sending.</span>
            )
          ) : (
            <span>{disabledReason}</span>
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="dialog-primary" disabled={!canProceed || busy}>
            {busy ? "Working..." : primary}
          </button>
        </div>
      </form>
    </div>
  );
}

function PrepareUpdateDialog({
  status,
  message,
  selection,
  busy,
  onMessageChange,
  onSelectionChange,
  onCancel,
  onPrepare
}: {
  status: ProjectStatus;
  message: string;
  selection: PrepareSelection;
  busy: boolean;
  onMessageChange: (value: string) => void;
  onSelectionChange: (value: PrepareSelection) => void;
  onCancel: () => void;
  onPrepare: () => void;
}) {
  const files = status.workingTree.files;
  const classified = classifyPrepareFiles(files);
  const excludedPaths = new Set(classified.excluded.map((file) => file.path));
  const selectedCount = files.filter((file) => selection[file.path]).length;
  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <form
        className="prepare-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onPrepare();
        }}
      >
        <div className="dialog-title-block">
          <h2>Prepare local update</h2>
          <p>
            Package local edits into a prepared update before sending them to Overleaf. This will not update from Overleaf or send
            anything.
          </p>
        </div>

        <div className="prepare-summary">
          <span>{selectedCount} of {files.length} local {files.length === 1 ? "file" : "files"} selected</span>
          <span>{status.branch ?? "current branch"}</span>
        </div>

        <div className="prepare-file-list" aria-label="Local files to prepare">
          {files.map((file) => (
            <label className={`prepare-file-row ${selection[file.path] ? "selected" : "excluded"}`} key={`${file.path}-${file.code}`}>
              <input
                type="checkbox"
                checked={Boolean(selection[file.path])}
                onChange={(event) => onSelectionChange({ ...selection, [file.path]: event.target.checked })}
              />
              <span className="prepare-file-path">{file.path}</span>
              <span className="prepare-file-code">{file.status}</span>
              {excludedPaths.has(file.path) ? <span className="prepare-file-hint">likely generated</span> : null}
            </label>
          ))}
        </div>

        <label className="prepare-message">
          <span>Update note</span>
          <input
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
            placeholder="Briefly describe the local update"
            aria-label="Prepared update note"
            autoFocus
          />
        </label>

        <div className="dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="dialog-primary" disabled={busy || !message.trim() || selectedCount === 0}>
            {busy ? "Preparing..." : "Prepare update"}
          </button>
        </div>
      </form>
    </div>
  );
}

function MenuAction({
  icon,
  label,
  onClick,
  danger
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button type="button" className={`menu-action ${danger ? "danger" : ""}`} onClick={onClick} role="menuitem">
      {icon}
      <span>{label}</span>
    </button>
  );
}

function NavButton({
  view,
  current,
  setView,
  icon,
  label
}: {
  view: ViewKey;
  current: ViewKey;
  setView: (view: ViewKey) => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button type="button" className={`nav-button ${current === view ? "active" : ""}`} onClick={() => setView(view)}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="setting-row">
      <span>{label}</span>
      {children}
    </label>
  );
}

function DirectionBadge({ direction }: { direction: ChangeDirection }) {
  const label: Record<ChangeDirection, string> = {
    incoming: "Overleaf",
    outgoing: "Local",
    working: "Local edit"
  };
  return <span className={`direction-badge ${direction}`}>{label[direction]}</span>;
}

function StatusBadge({ status }: { status?: ProjectStatus }) {
  if (!status) return <span className="status-badge neutral">Not checked</span>;
  if (status.conflictRisk.level === "high") return <span className="status-badge warning">Needs review</span>;
  if (!status.workingTree.clean) return <span className="status-badge warning">Local edits</span>;
  if (status.incoming.hasChanges) return <span className="status-badge incoming">Overleaf changed</span>;
  if (status.outgoing.hasChanges) return <span className="status-badge outgoing">Ready to send</span>;
  if (status.errors.length) return <span className="status-badge warning">Needs attention</span>;
  return <span className="status-badge synced">Up to date</span>;
}

function syncHeadline(status?: ProjectStatus): string {
  if (!status) return "Not checked";
  if (status.conflictRisk.level === "high") return "Review overlapping files";
  if (!status.workingTree.clean) return "Local edits need preparation";
  if (status.incoming.hasChanges) return "Review Overleaf update";
  if (status.outgoing.hasChanges) return "Ready to send";
  if (status.errors.length) return "Setup needs attention";
  return "No changes waiting";
}

function fileKey(file: ChangedFile): string {
  return `${file.direction}:${file.path}:${file.code}`;
}

function reviewFilesForStatus(status: ProjectStatus): ChangedFile[] {
  const allFiles = [...status.incoming.files, ...status.outgoing.files, ...status.workingTree.files];
  const conflictPaths = new Set(status.conflictRisk.files);
  const prioritized = [
    ...allFiles.filter((file) => conflictPaths.has(file.path)),
    ...status.incoming.files,
    ...status.outgoing.files,
    ...status.workingTree.files
  ];
  const seen = new Set<string>();
  return prioritized.filter((file) => {
    const key = fileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseUnifiedDiff(text: string): { additions: number; deletions: number; lines: RenderedDiffLine[] } {
  const rawLines = text.split(/\r?\n/);
  if (rawLines.at(-1) === "") rawLines.pop();

  let additions = 0;
  let deletions = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const lines = rawLines.map((raw): RenderedDiffLine => {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { kind: "hunk", marker: "@@", content: raw };
    }

    if (inHunk && raw.startsWith("+") && !raw.startsWith("+++")) {
      additions += 1;
      return { kind: "add", newLine: newLine++, marker: "+", content: raw.slice(1) };
    }

    if (inHunk && raw.startsWith("-") && !raw.startsWith("---")) {
      deletions += 1;
      return { kind: "remove", oldLine: oldLine++, marker: "-", content: raw.slice(1) };
    }

    if (inHunk && raw.startsWith(" ")) {
      return { kind: "context", oldLine: oldLine++, newLine: newLine++, marker: "", content: raw.slice(1) };
    }

    return { kind: "meta", marker: "", content: raw };
  });

  return { additions, deletions, lines };
}

function needsSetupSurface(settings: StoredSettings, status?: ProjectStatus): boolean {
  if (!settings.projectPath) return true;
  if (!settings.overleafUrl.trim()) return true;
  if (!status) return true;
  if (!status.isGitRepo) return true;
  if (!status.overleafRemote?.name || !status.overleafRemote.branch) return true;
  return status.errors.some((error) => error.code === "overleaf_remote_missing" || error.code === "remote_branch_missing");
}

function diagnosticGuidance(settings: StoredSettings, status?: ProjectStatus): { title: string; detail: string }[] {
  const guidance: { title: string; detail: string }[] = [];
  const errors = status?.errors ?? [];
  const gitUrl = deriveOverleafGitUrl(settings.overleafUrl);
  if (!settings.projectPath) {
    guidance.push({ title: "Choose folder", detail: "Select the local folder that is connected to the Overleaf project." });
  }
  if (status && !status.isGitRepo) {
    guidance.push({
      title: "Git-backed folder required",
      detail: "Use a folder cloned from Overleaf Git, or connect this paper folder to Overleaf Git outside LeafBridge."
    });
  }
  if (errors.some((error) => error.code === "overleaf_remote_missing")) {
    guidance.push({
      title: "Add Overleaf remote",
      detail: gitUrl
        ? `git remote add ${settings.remoteName || "overleaf"} ${gitUrl}`
        : "Add the Overleaf project URL above to show the exact git remote add command."
    });
  }
  if (errors.some((error) => error.code === "remote_branch_missing")) {
    guidance.push({ title: "Fetch Overleaf branch", detail: `git fetch ${settings.remoteName || "overleaf"}` });
  }
  if (errors.some((error) => error.code === "authentication_failed")) {
    guidance.push({
      title: "Check credentials",
      detail: "Overleaf rejected Git authentication. Sign in through Git credentials or refresh the account token, then run Check now."
    });
  }
  if (!settings.overleafUrl.trim()) {
    guidance.push({ title: "Add Overleaf URL", detail: "Paste the Overleaf web project URL so Open Overleaf and setup guidance work." });
  }
  return guidance;
}

function setupSteps(settings: StoredSettings, status?: ProjectStatus): { label: string; detail: string; state: SetupStepState }[] {
  const hasFolder = Boolean(settings.projectPath);
  const isGitRepo = Boolean(status?.isGitRepo);
  const hasRemote = Boolean(status?.overleafRemote?.name);
  const hasBranch = Boolean(status?.overleafRemote?.branch);
  const hasUrl = Boolean(settings.overleafUrl.trim());
  const hasCheck = Boolean(status?.lastFetchedAt);
  const derivedGitUrl = deriveOverleafGitUrl(settings.overleafUrl);

  return [
    {
      label: "Choose local paper folder",
      detail: hasFolder ? settings.projectPath : "Select the folder that is connected to the Overleaf project.",
      state: hasFolder ? "complete" : "current"
    },
    {
      label: "Verify local folder",
      detail: !hasFolder
        ? "Choose a folder first."
        : isGitRepo
          ? "The selected folder is ready for bridge checks."
          : "The selected folder is not currently detected as a Git-backed project.",
      state: !hasFolder ? "blocked" : isGitRepo ? "complete" : "current"
    },
    {
      label: "Detect Overleaf remote",
      detail: hasRemote
        ? `Using remote '${status?.overleafRemote?.name}'.`
        : derivedGitUrl
          ? `Expected remote '${settings.remoteName || "overleaf"}' can point to ${derivedGitUrl}.`
          : `LeafBridge is looking for a remote named '${settings.remoteName || "overleaf"}'.`,
      state: !isGitRepo ? "blocked" : hasRemote ? "complete" : "current"
    },
    {
      label: "Detect Overleaf branch",
      detail: hasBranch ? `Comparing against '${status?.overleafRemote?.branch}'.` : "Run Check now after the Overleaf remote is available.",
      state: !hasRemote ? "blocked" : hasBranch ? "complete" : "current"
    },
    {
      label: "Add Overleaf project URL",
      detail: hasUrl ? settings.overleafUrl : "Add the web project URL so Open Overleaf works.",
      state: hasUrl ? "complete" : "current"
    },
    {
      label: "Check bridge state",
      detail: hasCheck ? `Last checked ${formatTime(status!.lastFetchedAt!)}.` : "Run Check now to inspect Overleaf and local changes.",
      state: !hasFolder ? "blocked" : hasCheck ? "complete" : "current"
    }
  ];
}

function incomingSignature(status?: ProjectStatus): string {
  if (!status?.incoming.hasChanges) return "";
  return [
    ...status.incoming.commits.map((commit) => `commit:${commit.hash}`),
    ...status.incoming.files.map((file) => `file:${file.code}:${file.path}`)
  ]
    .sort()
    .join("|");
}

function statusCacheKey(projectPath: string, remoteName: string): string {
  return `${projectPath.trim()}::${(remoteName.trim() || "overleaf").toLowerCase()}`;
}

function summarizeOverleafChanges(status: ProjectStatus): string {
  const fileCount = status.incoming.files.length;
  const updateCount = status.incoming.commits.length;
  const files = status.incoming.files.slice(0, 8).map((file) => `- ${file.path} (${file.status})`);
  const more = fileCount > files.length ? [`- ${fileCount - files.length} more files`] : [];
  return [`Overleaf updates: ${updateCount}`, `Files changed: ${fileCount}`, ...files, ...more].join("\n");
}

function loadSettings(): StoredSettings {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(settingsKey) ?? "{}") };
  } catch {
    return defaultSettings;
  }
}

function loadActivity(): ActivityEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(activityKey) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is ActivityEntry => {
        return (
          typeof entry?.id === "string" &&
          typeof entry.at === "string" &&
          typeof entry.kind === "string" &&
          typeof entry.level === "string" &&
          typeof entry.message === "string"
        );
      })
      .slice(0, 200);
  } catch {
    return [];
  }
}

function defaultPrepareMessage(status: ProjectStatus): string {
  const projectName = status.projectName || "paper";
  return `Update ${projectName}`;
}

function activityKindLabel(kind: ActivityKind): string {
  const labels: Record<ActivityKind, string> = {
    fetch: "Check",
    pull: "Update",
    push: "Send",
    commit: "Prepare",
    diff: "Review",
    settings: "Settings",
    error: "Error"
  };
  return labels[kind];
}

function projectLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function projectDisplayName(path: string, settings: StoredSettings): string {
  return settings.projectAliases[path] || projectLabel(path);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function remoteLabel(status?: ProjectStatus): string {
  if (!status?.overleafRemote) return "Missing";
  return `${status.overleafRemote.name} -> ${status.overleafRemote.branch || "branch unavailable"}`;
}

function summarizeStatus(status: ProjectStatus): string {
  return [
    `Branch: ${status.branch ?? "unknown"}`,
    `Overleaf updates: ${status.incoming.commits.length}`,
    `Prepared local updates: ${status.outgoing.commits.length}`,
    `Local edits not prepared: ${status.workingTree.files.length}`,
    `Conflict risk: ${status.conflictRisk.level}`
  ].join("\n");
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
