import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { History, Search, Workflow, X } from 'lucide-react';
import { t } from '../shared/i18n/translate.js';
import type {
  AutomationDraft,
  AutomationListView,
  AutomationCanvasView,
  AutomationPanelsView,
  AutomationRunStateView,
  DetectionView,
  LayoutUpdate,
  ProposalView,
  RegisterTools,
  RegistrationView,
  RunRequest,
  RunView,
  ShellPreferences,
  ShellTheme,
  ToolCatalog,
  ToolScopeChoice,
  ToolView,
  WorkspaceLayoutView,
  WorkspaceListView,
  WorkspaceUpdate,
  WorkspaceView,
} from '../shared/ipc-contract.js';
import { PANEL_WIDTH_DEFAULT, PANEL_WIDTH_MAX, PANEL_WIDTH_MIN } from '../shared/ipc-contract.js';
import { AutomationTab } from './automations/AutomationTab.js';
import { AutomationsPanel } from './automations/AutomationsPanel.js';
import { LIBRARY_DRAG_TYPE } from './automations/canvas/Canvas.js';
import { HistoryView } from './history/HistoryView.js';
import { ImportReview } from './import/ImportReview.js';
import { CommandPalette } from './palette/CommandPalette.js';
import type { Command } from './palette/CommandPalette.js';
import { SettingsView, THEME_LABELS } from './settings/SettingsView.js';
import { BildoraMark } from './shell/BildoraMark.js';
import {
  AUTOMATIONS_PANEL,
  CategoryRail,
  HISTORY_OWNER,
  TOOL_PANEL_ID,
} from './shell/CategoryRail.js';
import type { RailDialog } from './shell/CategoryRail.js';
import { Dialog } from './shell/Dialog.js';
import { MenuBar } from './shell/MenuBar.js';
import type { Menu } from './shell/MenuBar.js';
import { PanelResizer } from './shell/PanelResizer.js';
import { ProgramIcon } from './shell/ProgramIcon.js';
import { RunStateBadge, RunStateIcon, runStateLabel } from './shell/RunStateBadge.js';
import { StartScreen } from './tabs/StartScreen.js';
import { TabBar, tabId, tabPanelId } from './tabs/TabBar.js';
import type { TabAction, TabView } from './tabs/TabBar.js';
import {
  HISTORY_TAB,
  NO_TABS,
  activate,
  activeTab,
  close,
  fromLayout,
  keysToClose,
  move,
  open,
  openDraft,
  pin,
  prune,
  rename,
  step,
  tabKey,
  toLayout,
} from './tabs/tabs.js';
import type { Tab, TabRef, TabState } from './tabs/tabs.js';
import { ToolDetails } from './tools/ToolDetails.js';
import { ToolForm } from './tools/ToolForm.js';
import { ToolRunner } from './tools/ToolRunner.js';
import { Welcome } from './tools/Welcome.js';
import { groupKey, groupLabel, placeCategory, toggleCategory } from './tools/category-rail.js';
import { countRunning, summarizeRuns } from './tools/run-state.js';
import type { ToolState } from './tools/run-state.js';
import { WorkspaceNameDialog } from './workspaces/WorkspaceNameDialog.js';
import { WorkspacesView } from './workspaces/WorkspacesView.js';

const api = window.bildora;
const EMPTY_CATALOG: ToolCatalog = { groups: [], problems: [] };

const EMPTY_RECENT: readonly string[] = [];
const NO_WORKSPACES: WorkspaceListView = { activeId: '', workspaces: [], problems: [] };
const NO_AUTOMATIONS: AutomationListView = { automations: [], problems: [] };
const NO_KEYS: ReadonlySet<string> = new Set();

type Modal =
  | { readonly kind: 'palette' }
  | { readonly kind: 'about' }
  | { readonly kind: 'add'; readonly proposal: ProposalView }
  | { readonly kind: 'edit'; readonly tool: ToolView }
  | { readonly kind: 'remove'; readonly tool: ToolView }
  | { readonly kind: 'move'; readonly tool: ToolView }
  | { readonly kind: 'create-workspace' }
  | { readonly kind: 'review'; readonly detection: DetectionView }
  | { readonly kind: RailDialog };

/** Why closing a tab has to ask first. */
type CloseQuestion = 'running' | 'unsaved';

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Electron wraps what a handler throws with the name of the channel.
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

const NO_PANELS: AutomationPanelsView = {};
const NO_CANVAS_OPTIONS: AutomationCanvasView = {};

function layoutOf(list: WorkspaceListView): WorkspaceLayoutView | undefined {
  return list.workspaces.find(({ id }) => id === list.activeId)?.layout;
}

export function App() {
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [loaded, setLoaded] = useState(false);
  const [runs, setRuns] = useState<readonly RunView[]>([]);
  const [automations, setAutomations] = useState(NO_AUTOMATIONS);
  const [automationsLoaded, setAutomationsLoaded] = useState(false);
  const [automationRuns, setAutomationRuns] = useState<readonly AutomationRunStateView[]>([]);
  const [version, setVersion] = useState('');
  const [workspaces, setWorkspaces] = useState(NO_WORKSPACES);
  const [panelWidth, setPanelWidth] = useState(PANEL_WIDTH_DEFAULT);
  const [automationPanels, setAutomationPanels] = useState<AutomationPanelsView>(NO_PANELS);
  const [canvasOptions, setCanvasOptions] = useState<AutomationCanvasView>(NO_CANVAS_OPTIONS);
  const [historyRunLimit, setHistoryRunLimit] = useState(200);
  const [recent, setRecent] = useState(EMPTY_RECENT);
  const [tabs, setTabs] = useState<TabState>(NO_TABS);
  const [historyFilter, setHistoryFilter] = useState<string | undefined>(undefined);
  /** Tabs whose automation has edits that are not saved. */
  const [unsaved, setUnsaved] = useState<ReadonlySet<string>>(NO_KEYS);
  /** Tabs waiting to close, the first of which is asking the user. */
  const [closing, setClosing] = useState<readonly string[]>([]);
  const [openCategory, setOpenCategory] = useState<string | undefined>(undefined);
  const [modal, setModal] = useState<Modal | undefined>(undefined);
  const [banner, setBanner] = useState<string | undefined>(undefined);
  const [dropping, setDropping] = useState(false);
  /** Grows with each switch, so that an answer about the previous Workspace can be told apart. */
  const generation = useRef(0);
  /** The tabs as last changed, so that changes in a row build on each other. */
  const tabsNow = useRef<TabState>(NO_TABS);
  const drafts = useRef(0);

  const workspace: WorkspaceView | undefined = workspaces.workspaces.find(
    ({ id }) => id === workspaces.activeId,
  );
  const theme: ShellTheme = workspace?.theme ?? 'system';
  const favorites = workspace?.favorites ?? EMPTY_RECENT;
  const scriptAnswers = workspace?.layout.scriptAnswers ?? EMPTY_RECENT;
  const workspaceName = workspace?.name ?? '';

  const applyCatalog = useCallback((next: ToolCatalog): ToolCatalog => {
    setCatalog(next);
    setLoaded(true);
    return next;
  }, []);

  const reload = useCallback((): Promise<ToolCatalog> => {
    const asked = generation.current;
    // Both lists arrive together, so a tab is never dropped for an item that is still loading.
    return Promise.all([api.listAutomations().catch(() => undefined), api.listTools()]).then(
      ([list, next]) => {
        if (asked !== generation.current) {
          return next;
        }
        if (list !== undefined) {
          setAutomations(list);
          setAutomationsLoaded(true);
        }
        return applyCatalog(next);
      },
    );
  }, [applyCatalog]);

  const report = useCallback((error: unknown) => {
    setBanner(messageOf(error));
  }, []);

  /** Shows the tabs a Workspace stored, without writing them back. */
  function restoreTabs(layout: WorkspaceLayoutView | undefined): void {
    const restored = fromLayout(layout);
    tabsNow.current = restored;
    setTabs(restored);
    setHistoryFilter(layout?.historyFilter);
    setUnsaved(NO_KEYS);
    setClosing([]);
  }

  useEffect(() => {
    void reload().catch(report);
    void api.listRuns().then(setRuns).catch(report);
    void api.listAutomationRuns().then(setAutomationRuns).catch(report);
    void api
      .listWorkspaces()
      .then((list) => {
        setWorkspaces(list);
        // The panel stays closed at launch, so only the tabs and the width come back.
        const layout = layoutOf(list);
        const restored = fromLayout(layout);
        tabsNow.current = restored;
        setTabs(restored);
        setHistoryFilter(layout?.historyFilter);
        setPanelWidth(layout?.panelWidth ?? PANEL_WIDTH_DEFAULT);
        setAutomationPanels(layout?.automationPanels ?? NO_PANELS);
        setCanvasOptions(layout?.automationCanvas ?? NO_CANVAS_OPTIONS);
      })
      .catch(report);
    void api
      .shellInfo()
      .then(({ version: value, historyProblem }) => {
        setVersion(value);
        if (historyProblem !== undefined) {
          setBanner(t('history.unavailable', { detail: historyProblem }));
        }
      })
      .catch(report);
    void api
      .getPreferences()
      .then((preferences) => {
        setHistoryRunLimit(preferences.historyRunLimit);
      })
      .catch(report);
    const stopListening = api.onRunsChanged(setRuns);
    const stopFollowingAutomations = api.onAutomationsChanged(setAutomationRuns);
    // A program may have been installed or moved while the user was elsewhere.
    const onFocus = (): void => {
      void reload().catch(report);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      stopListening();
      stopFollowingAutomations();
      window.removeEventListener('focus', onFocus);
    };
  }, [reload, report]);

  useEffect(() => {
    let current = true;
    void api
      .recentTools()
      .then((ids) => {
        if (current) {
          setRecent(ids);
        }
      })
      .catch(report);
    return () => {
      current = false;
    };
  }, [runs, workspaces.activeId, report]);

  const allTools = useMemo(() => catalog.groups.flatMap((group) => group.tools), [catalog]);
  /** Category logos by tool, which Run tool blocks show. */
  const toolLogos = useMemo(
    () =>
      new Map(
        catalog.groups.flatMap(({ logo, tools: grouped }) =>
          logo === undefined ? [] : grouped.map((tool): [string, string] => [tool.id, logo]),
        ),
      ),
    [catalog],
  );
  const panelGroup = catalog.groups.find((candidate) => groupKey(candidate) === openCategory);
  const automationsPanelOpen = openCategory === AUTOMATIONS_PANEL;
  const runningAutomations = automationRuns.filter(({ status }) => status === 'running').length;
  // An automation between steps has no tool running, but it still counts as work going on.
  const running = countRunning(runs) || runningAutomations;
  const recentTools = recent.flatMap((id) => allTools.filter((item) => item.id === id));
  const favoriteTools = favorites.flatMap((id) => allTools.filter((item) => item.id === id));
  const current = activeTab(tabs);
  const historyShown = tabs.activeKey === tabKey(HISTORY_TAB);
  // History stays mounted behind other tabs, so coming back to it reads the runs again, which
  // may include some the command line made meanwhile.
  const historyRevision = useMemo(() => ({ runs, historyShown }), [runs, historyShown]);

  function toolOf(tab: TabRef): ToolView | undefined {
    return tab.kind === 'tool' ? allTools.find((item) => item.id === tab.id) : undefined;
  }

  function automationRunOf(id: string | undefined): AutomationRunStateView | undefined {
    return automationRuns.find(
      (run) => run.workspaceId === workspaces.activeId && run.automationId === id,
    );
  }

  function ownerOf(tab: Tab | undefined): string | undefined {
    if (tab === undefined) {
      return undefined;
    }
    if (tab.kind === 'automation') {
      return AUTOMATIONS_PANEL;
    }
    if (tab.kind === 'history') {
      return HISTORY_OWNER;
    }
    const group = catalog.groups.find((candidate) =>
      candidate.tools.some((item) => item.id === tab.id),
    );
    return group === undefined ? undefined : groupKey(group);
  }

  function saveWorkspace(changes: WorkspaceUpdate): void {
    const asked = generation.current;
    void api
      .updateWorkspace(changes)
      .then((updated) => {
        if (asked === generation.current) {
          setWorkspaces((list) => ({
            ...list,
            workspaces: list.workspaces.map((item) => (item.id === updated.id ? updated : item)),
          }));
        }
      })
      .catch(report);
  }

  /** Changes the tabs and stores them in the Workspace, with any other layout change. */
  function changeTabs(update: (state: TabState) => TabState, extra: LayoutUpdate = {}): void {
    const before = tabsNow.current;
    const next = update(before);
    if (next === before && Object.keys(extra).length === 0) {
      return;
    }
    tabsNow.current = next;
    setTabs(next);
    saveWorkspace({ layout: { ...toLayout(next), ...extra } });
  }

  // Tabs whose tool or automation is gone close without a word, once both lists are known.
  useEffect(() => {
    if (!loaded || !automationsLoaded) {
      return;
    }
    const before = tabsNow.current;
    const next = prune(before, (tab) =>
      tab.kind === 'tool'
        ? allTools.some((item) => item.id === tab.id)
        : automations.automations.some((item) => item.id === tab.id),
    );
    if (next.tabs.length !== before.tabs.length) {
      tabsNow.current = next;
      setTabs(next);
      const asked = generation.current;
      void api
        .updateWorkspace({ layout: toLayout(next) })
        .then((updated) => {
          if (asked === generation.current) {
            setWorkspaces((list) => ({
              ...list,
              workspaces: list.workspaces.map((item) => (item.id === updated.id ? updated : item)),
            }));
          }
        })
        .catch(report);
    }
  }, [loaded, automationsLoaded, allTools, automations, tabs, report]);

  function openTab(ref: TabRef, pinned: boolean): void {
    changeTabs((state) => open(state, ref, { pin: pinned }));
  }

  /** Using an item in a preview tab keeps it. */
  function pinTab(key: string): void {
    if (tabsNow.current.tabs.find((tab) => tab.key === key)?.preview === true) {
      changeTabs((state) => pin(state, key));
    }
  }

  /** Enters what `list` says is active, with the tabs that Workspace was left with. */
  function enterWorkspace(list: WorkspaceListView): Promise<ToolCatalog> {
    generation.current += 1;
    const layout = layoutOf(list);
    setWorkspaces(list);
    restoreTabs(layout);
    setOpenCategory(layout?.openCategory);
    setPanelWidth(layout?.panelWidth ?? PANEL_WIDTH_DEFAULT);
    setAutomationPanels(layout?.automationPanels ?? NO_PANELS);
    setCanvasOptions(layout?.automationCanvas ?? NO_CANVAS_OPTIONS);
    setAutomations(NO_AUTOMATIONS);
    setAutomationsLoaded(false);
    setModal(undefined);
    setLoaded(false);
    setCatalog(EMPTY_CATALOG);
    setRecent(EMPTY_RECENT);
    return reload();
  }

  function switchWorkspace(id: string): void {
    if (id === workspaces.activeId) {
      setModal(undefined);
      return;
    }
    generation.current += 1;
    void api.switchWorkspace(id).then(enterWorkspace).catch(report);
  }

  function createWorkspace(name: string): void {
    setModal(undefined);
    generation.current += 1;
    void api.createWorkspace(name).then(enterWorkspace).catch(report);
  }

  function renameWorkspace(id: string, name: string): void {
    void api.renameWorkspace(id, name).then(setWorkspaces).catch(report);
  }

  function removeWorkspace(id: string): void {
    void api
      .removeWorkspace(id)
      .then(async (list) => {
        if (list.activeId === workspaces.activeId) {
          setWorkspaces(list);
        } else {
          await enterWorkspace(list);
          // Deleting the open Workspace moves to another, but the user is still managing them.
          setModal({ kind: 'workspaces' });
        }
      })
      .catch(report);
  }

  function toggleFavorite(id: string): void {
    saveWorkspace({
      favorites: favorites.includes(id)
        ? favorites.filter((item) => item !== id)
        : [...favorites, id],
    });
  }

  /**
   * Opens a tool's tab. A panel that is open follows to the tool's category, so the tool can be
   * found where it lives.
   */
  function showTool(id: string, pinned = true, list: ToolCatalog = catalog): void {
    const owner = list.groups.find((candidate) => candidate.tools.some((item) => item.id === id));
    if (owner === undefined) {
      return;
    }
    const nextOpen = openCategory === undefined ? undefined : groupKey(owner);
    setOpenCategory(nextOpen);
    changeTabs((state) => open(state, { kind: 'tool', id }, { pin: pinned }), {
      openCategory: nextOpen ?? null,
    });
  }

  function pressCategory(key: string): void {
    const next = toggleCategory(openCategory, key);
    setOpenCategory(next);
    // Only choosing an item in the panel changes the work area.
    saveWorkspace({ layout: { openCategory: next ?? null } });
    if (next === AUTOMATIONS_PANEL) {
      // The CLI, or a hand-edited file, can change these while the app stays focused.
      void reload().catch(report);
    }
  }

  function placeRailCategory(dragged: string, target: string): void {
    const stored = workspace?.layout.categoryOrder ?? [];
    const categoryOrder = placeCategory(catalog.groups, stored, dragged, target);
    void api
      .saveLayout({ categoryOrder: [...categoryOrder] })
      .then(() => api.listWorkspaces())
      .then(setWorkspaces)
      .then(reload)
      .catch(report);
  }

  function openCategoryMenu(category: string): void {
    void api
      .openCategoryMenu(category)
      .then(async (changed) => {
        if (changed) {
          // The menu can reorder the rail, which main stores in the Workspace.
          setWorkspaces(await api.listWorkspaces());
          await reload();
        }
      })
      .catch(report);
  }

  async function finishRegistration({ registeredIds, failures }: RegistrationView): Promise<void> {
    const list = await reload();
    const [firstId] = registeredIds;
    if (firstId !== undefined) {
      showTool(firstId, true, list);
    }
    const [firstFailure] = failures;
    setBanner(
      firstFailure === undefined
        ? undefined
        : t('import.failures', { count: failures.length, detail: firstFailure.message }),
    );
  }

  /** Adds reviewed programs and manifests. Both report the same way, so one result covers them. */
  async function registerAll(
    programs: RegisterTools['programs'],
    manifests: readonly string[],
    scope: ToolScopeChoice,
  ): Promise<RegistrationView> {
    const fromPrograms: RegistrationView =
      programs.length === 0
        ? { registeredIds: [], failures: [] }
        : await api.registerTools({ programs, scope });
    const fromManifests: RegistrationView =
      manifests.length === 0
        ? { registeredIds: [], failures: [] }
        : await api.importManifests(manifests, scope);
    return {
      registeredIds: [...fromManifests.registeredIds, ...fromPrograms.registeredIds],
      failures: [...fromPrograms.failures, ...fromManifests.failures],
    };
  }

  function register(
    programs: RegisterTools['programs'],
    manifests: readonly string[],
    scope: ToolScopeChoice,
  ): void {
    setModal(undefined);
    void registerAll(programs, manifests, scope).then(finishRegistration).catch(report);
  }

  function reviewDetection(detection: DetectionView | undefined): void {
    if (detection !== undefined) {
      setModal({ kind: 'review', detection });
    }
  }

  function addTool(): void {
    void api
      .pickFiles()
      .then((detection) => {
        const [only, ...others] = detection?.proposals ?? [];
        const plain = detection?.manifests.length === 0 && detection.refused.length === 0;
        if (only !== undefined && others.length === 0 && plain) {
          setModal({ kind: 'add', proposal: only });
        } else {
          reviewDetection(detection);
        }
      })
      .catch(report);
  }

  function importFolder(): void {
    void api.pickFolder(true).then(reviewDetection).catch(report);
  }

  function launch(target: ToolView, request?: RunRequest): void {
    pinTab(tabKey({ kind: 'tool', id: target.id }));
    void api.startRun(target.id, request).catch(report);
  }

  async function saveAutomation(draft: AutomationDraft) {
    const saved = await api.saveAutomation(draft);
    await reload();
    return saved;
  }

  function runAutomation(id: string): void {
    void api.startAutomation(id).catch(report);
  }

  function removeAutomation(id: string): void {
    changeTabs((state) => close(state, tabKey({ kind: 'automation', id })));
    void api.removeAutomation(id).then(reload).catch(report);
  }

  function newAutomation(): void {
    drafts.current += 1;
    const id = `new-${String(drafts.current)}`;
    changeTabs((state) => openDraft(state, id));
  }

  function markUnsaved(key: string, dirty: boolean): void {
    setUnsaved((keys) => {
      if (keys.has(key) === dirty) {
        return keys;
      }
      const next = new Set(keys);
      if (dirty) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }

  function showHistory(toolId?: string): void {
    setHistoryFilter(toolId);
    changeTabs((state) => open(state, HISTORY_TAB, { pin: true }), {
      historyFilter: toolId ?? null,
    });
  }

  function questionFor(key: string, state: TabState): CloseQuestion | undefined {
    const tab = state.tabs.find((item) => item.key === key);
    if (tab === undefined) {
      return undefined;
    }
    if (unsaved.has(key)) {
      return 'unsaved';
    }
    const tool = toolOf(tab);
    if (tool !== undefined && summarizeRuns(runs, tool.key).running.length > 0) {
      return 'running';
    }
    if (tab.kind === 'automation' && automationRunOf(tab.id)?.status === 'running') {
      return 'running';
    }
    return undefined;
  }

  /** Closes tabs in order, stopping to ask about the first one that is running or unsaved. */
  function closeTabs(keys: readonly string[]): void {
    const asking = keys.findIndex((key) => questionFor(key, tabsNow.current) !== undefined);
    const quiet = asking === -1 ? keys : keys.slice(0, asking);
    if (quiet.length > 0) {
      changeTabs((state) => quiet.reduce(close, state));
    }
    setClosing(asking === -1 ? [] : keys.slice(asking));
  }

  function answerClose(answer: 'stop' | 'keep' | 'discard' | 'cancel'): void {
    const [key, ...rest] = closing;
    if (key === undefined || answer === 'cancel') {
      setClosing([]);
      return;
    }
    const tab = tabsNow.current.tabs.find((item) => item.key === key);
    if (answer === 'stop' && tab !== undefined) {
      const tool = toolOf(tab);
      if (tool !== undefined) {
        for (const run of summarizeRuns(runs, tool.key).running) {
          void api.cancelRun(run.runId).catch(report);
        }
      }
      const automationRun = tab.kind === 'automation' ? automationRunOf(tab.id) : undefined;
      if (automationRun?.status === 'running') {
        void api.cancelAutomation(automationRun.runId).catch(report);
      }
    }
    markUnsaved(key, false);
    changeTabs((state) => close(state, key));
    closeTabs(rest);
  }

  function tabAction(action: TabAction, key: string): void {
    if (action === 'pin') {
      pinTab(key);
      return;
    }
    if (action === 'others') {
      changeTabs((state) => activate(state, key));
    }
    closeTabs(keysToClose(tabsNow.current, action, key));
  }

  // The shortcuts read what is current through a ref, so the listener is added only once.
  const onShortcut = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    onShortcut.current = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'k' && !event.shiftKey) {
        event.preventDefault();
        setModal((open_) => (open_?.kind === 'palette' ? undefined : { kind: 'palette' }));
        return;
      }
      if (modal !== undefined || closing.length > 0) {
        return;
      }
      if (key === 'tab' || key === 'pagedown' || key === 'pageup') {
        event.preventDefault();
        const back = key === 'pageup' || (key === 'tab' && event.shiftKey);
        changeTabs((state) => step(state, back ? -1 : 1));
      } else if (key === 'w' && !event.shiftKey) {
        event.preventDefault();
        const active = tabsNow.current.activeKey;
        if (active !== undefined) {
          closeTabs([active]);
        }
      }
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      onShortcut.current(event);
    };
    window.addEventListener('keydown', listener);
    return () => {
      window.removeEventListener('keydown', listener);
    };
  }, []);

  function changeTheme(next: ShellTheme): void {
    // A radio button must answer at once, before main has stored the change.
    setWorkspaces((list) => ({
      ...list,
      workspaces: list.workspaces.map((item) =>
        item.id === list.activeId ? { ...item, theme: next } : item,
      ),
    }));
    saveWorkspace({ theme: next });
  }

  function changeHistoryRunLimit(next: ShellPreferences['historyRunLimit']): void {
    setHistoryRunLimit(next);
    void api.setPreferences({ historyRunLimit: next }).catch(report);
  }

  function clearHistory(): void {
    void api
      .clearHistory()
      .then(() => api.recentTools())
      .then(setRecent)
      .catch(report);
  }

  function onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer.types.includes('Files')) {
      setDropping(true);
    }
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault();
    setDropping(false);
    const paths = [...event.dataTransfer.files].map((file) => api.pathForFile(file));
    if (paths.length > 0) {
      void api.detectPaths(paths).then(reviewDetection).catch(report);
    }
  }

  const menus: readonly Menu[] = [
    {
      label: t('menu.file'),
      items: [
        { label: t('menu.addTool'), run: addTool },
        { label: t('menu.importFolder'), run: importFolder },
        { label: t('menu.exit'), run: () => void api.quit() },
      ],
    },
    {
      label: t('menu.edit'),
      items: [
        { label: t('menu.undo'), shortcut: 'Ctrl+Z', run: () => void api.edit('undo') },
        { label: t('menu.redo'), shortcut: 'Ctrl+Y', run: () => void api.edit('redo') },
        { label: t('menu.cut'), shortcut: 'Ctrl+X', run: () => void api.edit('cut') },
        { label: t('menu.copy'), shortcut: 'Ctrl+C', run: () => void api.edit('copy') },
        { label: t('menu.paste'), shortcut: 'Ctrl+V', run: () => void api.edit('paste') },
        { label: t('menu.selectAll'), shortcut: 'Ctrl+A', run: () => void api.edit('selectAll') },
      ],
    },
    {
      label: t('menu.view'),
      items: THEME_LABELS.map(({ value, label }) => ({
        label: t('palette.theme', { theme: t(label) }),
        run: () => {
          changeTheme(value);
        },
      })),
    },
    {
      label: t('menu.tools'),
      items: [
        {
          label: t('menu.findTool'),
          shortcut: t('search.shortcut'),
          run: () => {
            setModal({ kind: 'palette' });
          },
        },
        { label: t('menu.addTool'), run: addTool },
        { label: t('menu.importFolder'), run: importFolder },
      ],
    },
    {
      label: t('menu.help'),
      items: [
        {
          label: t('menu.about'),
          run: () => {
            setModal({ kind: 'about' });
          },
        },
      ],
    },
  ];

  const commands: readonly Command[] = [
    ...allTools.map((item): Command => ({
      id: `tool-${item.id}`,
      label: item.name,
      detail: item.category ?? t('nav.uncategorized'),
      icon: <ProgramIcon tool={item} />,
      run: () => {
        showTool(item.id);
        if (item.level === 0 && item.runtime.status === 'ready') {
          launch(item);
        }
      },
    })),
    ...automations.automations.map((item): Command => ({
      id: `automation-${item.id}`,
      label: item.name,
      detail: t('nav.automations'),
      icon: <Workflow className="icon" aria-hidden="true" />,
      run: () => {
        openTab({ kind: 'automation', id: item.id }, true);
        if (item.problems.length === 0) {
          runAutomation(item.id);
        }
      },
    })),
    ...workspaces.workspaces
      .filter(({ id }) => id !== workspaces.activeId)
      .map((item): Command => ({
        id: `workspace-${item.id}`,
        label: t('palette.switchWorkspace', { name: item.name }),
        detail: t('nav.workspaces'),
        run: () => {
          switchWorkspace(item.id);
        },
      })),
    {
      id: 'create-workspace',
      label: t('palette.createWorkspace'),
      detail: t('nav.workspaces'),
      run: () => {
        setModal({ kind: 'create-workspace' });
      },
    },
    {
      id: 'manage-workspaces',
      label: t('palette.manageWorkspaces'),
      detail: t('nav.workspaces'),
      run: () => {
        setModal({ kind: 'workspaces' });
      },
    },
    { id: 'add', label: t('menu.addTool'), detail: t('palette.action'), run: addTool },
    {
      id: 'import',
      label: t('menu.importFolder'),
      detail: t('palette.action'),
      run: importFolder,
    },
    {
      id: 'history',
      label: t('nav.history'),
      detail: t('palette.action'),
      run: () => {
        showHistory();
      },
    },
    {
      id: 'settings',
      label: t('menu.settings'),
      detail: t('palette.action'),
      run: () => {
        setModal({ kind: 'settings' });
      },
    },
    ...THEME_LABELS.map(({ value, label }): Command => ({
      id: `theme-${value}`,
      label: t('palette.theme', { theme: t(label) }),
      detail: t('palette.action'),
      run: () => {
        changeTheme(value);
      },
    })),
  ];

  /** How a tab reads in the bar, or nothing for one whose item is not loaded or is gone. */
  function viewOf(tab: Tab): TabView | undefined {
    if (tab.kind === 'history') {
      const icon = <History className="icon" aria-hidden="true" />;
      return { key: tab.key, label: t('nav.history'), icon, state: 'idle', preview: tab.preview };
    }
    if (tab.kind === 'automation') {
      const automation = automations.automations.find((item) => item.id === tab.id);
      if (automation === undefined && !tab.draft) {
        return undefined;
      }
      const state: ToolState = automationRunOf(tab.id)?.status ?? 'idle';
      return {
        key: tab.key,
        label: automation?.name ?? t('tabs.newAutomation'),
        icon: <Workflow className="icon" aria-hidden="true" />,
        state,
        preview: tab.preview,
      };
    }
    const tool = toolOf(tab);
    return tool === undefined
      ? undefined
      : {
          key: tab.key,
          label: tool.name,
          icon: <ProgramIcon tool={tool} />,
          state: summarizeRuns(runs, tool.key).state,
          preview: tab.preview,
        };
  }

  function renderTab(tab: Tab) {
    if (tab.kind === 'history') {
      return (
        <HistoryView
          tools={allTools}
          toolId={historyFilter}
          revision={historyRevision}
          onToolId={(toolId) => {
            setHistoryFilter(toolId);
            saveWorkspace({ layout: { historyFilter: toolId ?? null } });
          }}
          onError={report}
        />
      );
    }
    if (tab.kind === 'automation') {
      const automation = automations.automations.find((item) => item.id === tab.id);
      if (automation === undefined && !tab.draft) {
        return null;
      }
      return (
        <AutomationTab
          automation={automation}
          run={automationRunOf(tab.id)}
          tools={allTools}
          logos={toolLogos}
          active={tab.key === tabs.activeKey}
          revision={catalog}
          panels={automationPanels}
          onPanels={(panels, commit) => {
            setAutomationPanels(panels);
            if (commit) saveWorkspace({ layout: { automationPanels: panels } });
          }}
          canvasOptions={canvasOptions}
          onCanvasOptions={(options) => {
            setCanvasOptions(options);
            saveWorkspace({ layout: { automationCanvas: options } });
          }}
          onSave={saveAutomation}
          onSaved={(id) => {
            markUnsaved(tab.key, false);
            changeTabs((state) => rename(state, tab.key, { kind: 'automation', id }));
          }}
          onRun={(id) => api.startAutomation(id)}
          onRemove={() => {
            if (automation !== undefined) {
              removeAutomation(automation.id);
            }
          }}
          onShowTool={(id) => {
            showTool(id);
          }}
          onDirty={(dirty) => {
            markUnsaved(tab.key, dirty);
          }}
          onUsed={() => {
            pinTab(tab.key);
          }}
          onError={report}
        />
      );
    }
    const tool = toolOf(tab);
    if (tool === undefined) {
      return null;
    }
    const common = {
      tool,
      runs,
      favorite: favorites.includes(tool.id),
      onToggleFavorite: () => {
        toggleFavorite(tool.id);
      },
      onMove: () => {
        setModal({ kind: 'move', tool });
      },
      onStop: (runId: string) => {
        void api.cancelRun(runId).catch(report);
      },
      onEdit: () => {
        setModal({ kind: 'edit', tool });
      },
      onRemove: () => {
        setModal({ kind: 'remove', tool });
      },
      onCheckAgain: () => {
        void reload().catch(report);
      },
    };
    return tool.level === 1 ? (
      <ToolRunner
        key={tool.key}
        {...common}
        onRun={(request) => {
          launch(tool, request);
        }}
        onHistory={() => {
          showHistory(tool.id);
        }}
        onUsed={() => {
          pinTab(tab.key);
        }}
        answerWithScript={scriptAnswers.includes(tool.id)}
        onAnswerWithScriptChange={(answer) => {
          const others = scriptAnswers.filter((id) => id !== tool.id);
          saveWorkspace({ layout: { scriptAnswers: answer ? [...others, tool.id] : others } });
        }}
        onError={report}
      />
    ) : (
      <ToolDetails
        key={tool.key}
        {...common}
        onLaunch={() => {
          launch(tool);
        }}
      />
    );
  }

  const tabViews = tabs.tabs.flatMap((tab) => viewOf(tab) ?? []);
  const owner = ownerOf(current);
  const currentTool = current === undefined ? undefined : toolOf(current);
  const currentAutomation = current?.kind === 'automation' ? current.id : undefined;
  const empty = loaded && allTools.length === 0;
  const asking = closing[0];
  const askingTab = tabs.tabs.find((tab) => tab.key === asking);
  const question = asking === undefined ? undefined : questionFor(asking, tabs);
  const askingName = askingTab === undefined ? '' : (viewOf(askingTab)?.label ?? '');

  // A run can end while its question is open, and then the tab has nothing left to ask about.
  const resumeClosing = useRef<() => void>(() => undefined);
  useEffect(() => {
    resumeClosing.current = () => {
      if (closing.length > 0 && question === undefined) {
        closeTabs(closing);
      }
    };
  });
  useEffect(() => {
    resumeClosing.current();
  }, [closing, question]);

  function panelRow(item: ToolView, live: boolean) {
    const { state } = summarizeRuns(runs, item.key);
    const showsState = live && state !== 'idle';
    // Only the category list shows states, so one id per tool is enough.
    const stateId = `tool-state-${item.key.replace(/[^\w-]/g, '_')}`;
    return (
      <li key={item.key}>
        <button
          type="button"
          className="row"
          title={item.name}
          // Named by the tool alone, with its state said apart, as tabs do.
          aria-describedby={showsState ? stateId : undefined}
          aria-current={item.id === currentTool?.id ? 'true' : undefined}
          // A tool dragged from here onto an automation's canvas becomes a block there.
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(
              LIBRARY_DRAG_TYPE,
              JSON.stringify({ kind: 'run', tool: item.id }),
            );
            event.dataTransfer.effectAllowed = 'copy';
          }}
          onClick={() => {
            showTool(item.id, !live);
          }}
          onDoubleClick={() => {
            showTool(item.id, true);
          }}
        >
          <ProgramIcon tool={item} />
          <span className="truncate">{item.name}</span>
          {showsState ? (
            <span className="row-state" title={runStateLabel(state)}>
              <RunStateIcon state={state} />
            </span>
          ) : null}
        </button>
        {showsState ? (
          <span id={stateId} className="visually-hidden">
            {runStateLabel(state)}
          </span>
        ) : null}
      </li>
    );
  }

  return (
    <div
      className="shell"
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (event.relatedTarget === null) {
          setDropping(false);
        }
      }}
      onDrop={onDrop}
    >
      <header className="top-bar">
        <BildoraMark />
        <span className="brand">{t('app.name')}</span>
        <MenuBar menus={menus} />
        <button
          type="button"
          className="search"
          onClick={() => {
            setModal({ kind: 'palette' });
          }}
        >
          <Search className="icon" aria-hidden="true" />
          <span>{t('search.placeholder')}</span>
          <kbd>{t('search.shortcut')}</kbd>
        </button>
      </header>

      <div className="body">
        <CategoryRail
          groups={catalog.groups}
          openCategory={openCategory}
          owner={owner}
          problemCount={catalog.problems.length}
          workspaces={workspaces.workspaces}
          activeWorkspace={workspaces.activeId}
          onToggleCategory={pressCategory}
          onCategoryMenu={openCategoryMenu}
          onPlaceCategory={placeRailCategory}
          onSwitchWorkspace={switchWorkspace}
          onCreateWorkspace={() => {
            setModal({ kind: 'create-workspace' });
          }}
          onHistory={() => {
            showHistory(historyFilter);
          }}
          onDialog={(kind) => {
            setModal({ kind });
          }}
        />

        {automationsPanelOpen ? (
          <AutomationsPanel
            id={TOOL_PANEL_ID}
            list={automations}
            runs={automationRuns}
            workspaceId={workspaces.activeId}
            width={panelWidth}
            current={currentAutomation}
            onOpen={(id, pinned) => {
              openTab({ kind: 'automation', id }, pinned);
            }}
            onNew={newAutomation}
          />
        ) : null}
        {panelGroup === undefined ? null : (
          <aside
            className="context-panel"
            id={TOOL_PANEL_ID}
            aria-label={t('nav.tools')}
            style={{ width: panelWidth }}
          >
            <h2>
              <span className="truncate">{groupLabel(panelGroup)}</span>
              <span className="row-count">{panelGroup.tools.length}</span>
            </h2>
            <ul className="nav-list">{panelGroup.tools.map((item) => panelRow(item, true))}</ul>
            {favoriteTools.length === 0 ? null : (
              <>
                <h2>{t('nav.favorites')}</h2>
                <ul className="nav-list" data-testid="favorite-tools">
                  {favoriteTools.map((item) => panelRow(item, false))}
                </ul>
              </>
            )}
            {recentTools.length === 0 ? null : (
              <>
                <h2>{t('nav.recent')}</h2>
                <ul className="nav-list" data-testid="recent-tools">
                  {recentTools.map((item) => panelRow(item, false))}
                </ul>
              </>
            )}
          </aside>
        )}
        {panelGroup === undefined && !automationsPanelOpen ? null : (
          <PanelResizer
            value={panelWidth}
            min={PANEL_WIDTH_MIN}
            max={PANEL_WIDTH_MAX}
            initial={PANEL_WIDTH_DEFAULT}
            label={t('nav.resizePanel')}
            onResize={setPanelWidth}
            onCommit={(width) => {
              saveWorkspace({ layout: { panelWidth: width } });
            }}
          />
        )}

        <main className="work-area">
          {tabViews.length === 0 ? null : (
            <TabBar
              tabs={tabViews}
              activeKey={tabs.activeKey}
              onActivate={(key) => {
                changeTabs((state) => activate(state, key));
              }}
              onPin={pinTab}
              onMove={(from, to) => {
                changeTabs((state) => move(state, from, to));
              }}
              onAction={tabAction}
            />
          )}
          <div className="tab-panels" key={workspaces.activeId}>
            {banner === undefined ? null : (
              <div className="notice notice-failed banner" role="alert">
                <p>{banner}</p>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t('banner.dismiss')}
                  onClick={() => {
                    setBanner(undefined);
                  }}
                >
                  <X className="icon" aria-hidden="true" />
                </button>
              </div>
            )}
            {tabs.tabs.map((tab) => (
              <div
                key={tab.key}
                id={tabPanelId(tab.key)}
                role="tabpanel"
                aria-labelledby={tabId(tab.key)}
                className="tab-panel"
                hidden={tab.key !== tabs.activeKey}
              >
                {renderTab(tab)}
              </div>
            ))}
            {tabViews.length > 0 ? null : empty ? (
              <Welcome onAdd={addTool} onImport={importFolder} />
            ) : loaded ? (
              <StartScreen
                recent={recentTools}
                onOpen={(id) => {
                  showTool(id);
                }}
              />
            ) : null}
          </div>
        </main>
      </div>

      <footer className="status-bar">
        <span className="truncate" data-testid="status-workspace">
          {t('status.workspace', { name: workspaceName })}
        </span>
        {running === 0 ? (
          <span data-testid="status">{t('status.ready')}</span>
        ) : (
          <span data-testid="status">
            <RunStateBadge state="running" label={t('status.tasksRunning', { count: running })} />
          </span>
        )}
        <span className="status-end">{version === '' ? '' : t('status.version', { version })}</span>
      </footer>

      {dropping ? (
        <div className="drop-overlay" aria-hidden="true">
          {t('import.dropHint')}
        </div>
      ) : null}

      {question === 'running' ? (
        <Dialog
          title={t('tabs.runningTitle', { name: askingName })}
          onClose={() => {
            answerClose('cancel');
          }}
        >
          <p>{t('tabs.runningBody')}</p>
          <div className="dialog-actions">
            <button
              type="button"
              autoFocus
              onClick={() => {
                answerClose('cancel');
              }}
            >
              {t('form.cancel')}
            </button>
            <button
              type="button"
              onClick={() => {
                answerClose('keep');
              }}
            >
              {t('tabs.keep')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                answerClose('stop');
              }}
            >
              {t('tabs.stop')}
            </button>
          </div>
        </Dialog>
      ) : null}
      {question === 'unsaved' ? (
        <Dialog
          title={t('tabs.unsavedTitle', { name: askingName })}
          onClose={() => {
            answerClose('cancel');
          }}
        >
          <p>{t('tabs.unsavedBody')}</p>
          <div className="dialog-actions">
            <button
              type="button"
              autoFocus
              onClick={() => {
                answerClose('cancel');
              }}
            >
              {t('form.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                answerClose('discard');
              }}
            >
              {t('tabs.discard')}
            </button>
          </div>
        </Dialog>
      ) : null}

      {modal?.kind === 'palette' ? (
        <CommandPalette
          commands={commands}
          onClose={() => {
            setModal(undefined);
          }}
        />
      ) : null}
      {modal?.kind === 'settings' ? (
        <SettingsView
          workspaceName={workspaceName}
          theme={theme}
          historyRunLimit={historyRunLimit}
          onTheme={changeTheme}
          onHistoryRunLimit={changeHistoryRunLimit}
          onClearHistory={clearHistory}
          onPathVariablesChanged={() => {
            void reload().catch(report);
          }}
          onError={report}
          onClose={() => {
            setModal(undefined);
          }}
        />
      ) : null}
      {modal?.kind === 'workspaces' ? (
        <WorkspacesView
          list={workspaces}
          onSwitch={switchWorkspace}
          onRename={renameWorkspace}
          onRemove={removeWorkspace}
          onClose={() => {
            setModal(undefined);
          }}
        />
      ) : null}
      {modal?.kind === 'problems' ? (
        <Dialog
          title={t('problems.title')}
          className="dialog-wide"
          onClose={() => {
            setModal(undefined);
          }}
        >
          <p className="muted">{t('problems.body')}</p>
          <dl className="facts">
            {catalog.problems.map((problem) => (
              <div key={`${problem.scope}/${problem.folder}`}>
                <dt>{problem.folder}</dt>
                <dd>{problem.message}</dd>
              </div>
            ))}
          </dl>
          <div className="dialog-actions">
            <button
              type="button"
              className="primary"
              autoFocus
              onClick={() => {
                setModal(undefined);
              }}
            >
              {t('dialog.close')}
            </button>
          </div>
        </Dialog>
      ) : null}
      {modal?.kind === 'about' ? (
        <Dialog
          title={t('about.title')}
          onClose={() => {
            setModal(undefined);
          }}
        >
          <p>{t('about.body', { version })}</p>
          <div className="dialog-actions">
            <button
              type="button"
              className="primary"
              autoFocus
              onClick={() => {
                setModal(undefined);
              }}
            >
              {t('about.close')}
            </button>
          </div>
        </Dialog>
      ) : null}
      {modal?.kind === 'add' ? (
        <ToolForm
          mode="add"
          program={modal.proposal.path}
          workspaceName={workspaceName}
          initial={{
            name: modal.proposal.name,
            ...(modal.proposal.category === undefined ? {} : { category: modal.proposal.category }),
            ...(modal.proposal.interpreter === undefined
              ? {}
              : { interpreter: modal.proposal.interpreter }),
          }}
          onSubmit={(details, scope) => {
            register([{ ...details, program: modal.proposal.path }], [], scope);
          }}
          onClose={() => {
            setModal(undefined);
          }}
        />
      ) : null}
      {modal?.kind === 'edit' ? (
        <ToolForm
          mode="edit"
          program={modal.tool.program}
          workspaceName={workspaceName}
          initial={{
            name: modal.tool.name,
            ...(modal.tool.category === undefined ? {} : { category: modal.tool.category }),
            ...(modal.tool.description === undefined
              ? {}
              : { description: modal.tool.description }),
            ...(modal.tool.interpreter === undefined
              ? {}
              : { interpreter: modal.tool.interpreter }),
          }}
          onSubmit={(details) => {
            const { id } = modal.tool;
            setModal(undefined);
            void api
              .updateTool(id, details)
              .then(reload)
              .then((list) => {
                showTool(id, true, list);
              })
              .catch(report);
          }}
          onClose={() => {
            setModal(undefined);
          }}
        />
      ) : null}
      {modal?.kind === 'remove' ? (
        <Dialog
          title={t('remove.title', { name: modal.tool.name })}
          onClose={() => {
            setModal(undefined);
          }}
        >
          <p>{t(modal.tool.scope === 'global' ? 'remove.bodyGlobal' : 'remove.body')}</p>
          <div className="dialog-actions">
            <button
              type="button"
              autoFocus
              onClick={() => {
                setModal(undefined);
              }}
            >
              {t('form.cancel')}
            </button>
            <button
              type="button"
              className="danger filled"
              onClick={() => {
                const { id } = modal.tool;
                setModal(undefined);
                void api.removeTool(id).then(reload).catch(report);
              }}
            >
              {t('remove.confirm')}
            </button>
          </div>
        </Dialog>
      ) : null}
      {modal?.kind === 'move' ? (
        <Dialog
          title={t(modal.tool.scope === 'global' ? 'move.toWorkspaceTitle' : 'move.toGlobalTitle', {
            name: modal.tool.name,
          })}
          onClose={() => {
            setModal(undefined);
          }}
        >
          <p>{t(modal.tool.scope === 'global' ? 'move.toWorkspaceBody' : 'move.toGlobalBody')}</p>
          <div className="dialog-actions">
            <button
              type="button"
              autoFocus
              onClick={() => {
                setModal(undefined);
              }}
            >
              {t('form.cancel')}
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                const { id, scope } = modal.tool;
                setModal(undefined);
                void api
                  .setToolScope(id, scope === 'global' ? 'workspace' : 'global')
                  .then(reload)
                  .catch(report);
              }}
            >
              {t('move.confirm')}
            </button>
          </div>
        </Dialog>
      ) : null}
      {modal?.kind === 'create-workspace' ? (
        <WorkspaceNameDialog
          title={t('workspace.createTitle')}
          confirm={t('workspace.createConfirm')}
          onSubmit={createWorkspace}
          onClose={() => {
            setModal(undefined);
          }}
        />
      ) : null}
      {modal?.kind === 'review' ? (
        <ImportReview
          detection={modal.detection}
          workspaceName={workspaceName}
          onConfirm={register}
          onClose={() => {
            setModal(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
