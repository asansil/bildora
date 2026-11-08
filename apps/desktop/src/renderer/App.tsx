import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Search, X } from 'lucide-react';
import { t } from '../shared/i18n/translate.js';
import type {
  AutomationDraft,
  AutomationListView,
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
import { PANEL_WIDTH_DEFAULT } from '../shared/ipc-contract.js';
import { AutomationsView } from './automations/AutomationsView.js';
import { HistoryView } from './history/HistoryView.js';
import { ImportReview } from './import/ImportReview.js';
import { CommandPalette } from './palette/CommandPalette.js';
import type { Command } from './palette/CommandPalette.js';
import { SettingsView, THEME_LABELS } from './settings/SettingsView.js';
import { BildoraMark } from './shell/BildoraMark.js';
import { CategoryRail, TOOL_PANEL_ID } from './shell/CategoryRail.js';
import { Dialog } from './shell/Dialog.js';
import { MenuBar } from './shell/MenuBar.js';
import type { Menu } from './shell/MenuBar.js';
import { PanelResizer } from './shell/PanelResizer.js';
import { RunStateBadge, RunStateIcon, runStateLabel } from './shell/RunStateBadge.js';
import { ToolDetails } from './tools/ToolDetails.js';
import { ToolForm } from './tools/ToolForm.js';
import { ToolRunner } from './tools/ToolRunner.js';
import { Welcome } from './tools/Welcome.js';
import { groupKey, groupLabel, placeCategory, toggleCategory } from './tools/category-rail.js';
import { countRunning, summarizeRuns } from './tools/run-state.js';
import { WorkspaceNameDialog } from './workspaces/WorkspaceNameDialog.js';
import { WorkspacesView } from './workspaces/WorkspacesView.js';

const api = window.bildora;
const EMPTY_CATALOG: ToolCatalog = { groups: [], problems: [] };

const EMPTY_RECENT: readonly string[] = [];
const NO_WORKSPACES: WorkspaceListView = { activeId: '', workspaces: [], problems: [] };
const NO_AUTOMATIONS: AutomationListView = { automations: [], problems: [] };

type Screen = 'tools' | 'problems' | 'history' | 'settings' | 'workspaces' | 'automations';

type Modal =
  | { readonly kind: 'palette' }
  | { readonly kind: 'about' }
  | { readonly kind: 'add'; readonly proposal: ProposalView }
  | { readonly kind: 'edit'; readonly tool: ToolView }
  | { readonly kind: 'remove'; readonly tool: ToolView }
  | { readonly kind: 'move'; readonly tool: ToolView }
  | { readonly kind: 'create-workspace' }
  | { readonly kind: 'review'; readonly detection: DetectionView };

const TOOL_TAB_PREFIX = 'tool:';

/** The tool in the active tab. Until the work area holds tabs, the shell shows only that one. */
function activeToolOf(layout: WorkspaceLayoutView | undefined): string | undefined {
  const key = layout?.activeTab;
  return key?.startsWith(TOOL_TAB_PREFIX) === true ? key.slice(TOOL_TAB_PREFIX.length) : undefined;
}

function onlyToolTab(id: string): LayoutUpdate {
  return { tabs: [{ kind: 'tool', id }], activeTab: `${TOOL_TAB_PREFIX}${id}` };
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Electron wraps what a handler throws with the name of the channel.
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export function App() {
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [loaded, setLoaded] = useState(false);
  const [runs, setRuns] = useState<readonly RunView[]>([]);
  const [automations, setAutomations] = useState(NO_AUTOMATIONS);
  const [automationRuns, setAutomationRuns] = useState<readonly AutomationRunStateView[]>([]);
  const [selectedAutomation, setSelectedAutomation] = useState<string | undefined>(undefined);
  const [version, setVersion] = useState('');
  const [workspaces, setWorkspaces] = useState(NO_WORKSPACES);
  const [panelWidth, setPanelWidth] = useState(PANEL_WIDTH_DEFAULT);
  const [historyRunLimit, setHistoryRunLimit] = useState(200);
  const [recent, setRecent] = useState(EMPTY_RECENT);
  const [historyTool, setHistoryTool] = useState<string | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>('tools');
  const [openCategory, setOpenCategory] = useState<string | undefined>(undefined);
  const [selectedTool, setSelectedTool] = useState<string | undefined>(undefined);
  const [modal, setModal] = useState<Modal | undefined>(undefined);
  const [banner, setBanner] = useState<string | undefined>(undefined);
  const [dropping, setDropping] = useState(false);
  /** Grows with each switch, so that an answer about the previous Workspace can be told apart. */
  const generation = useRef(0);

  const workspace: WorkspaceView | undefined = workspaces.workspaces.find(
    ({ id }) => id === workspaces.activeId,
  );
  const theme: ShellTheme = workspace?.theme ?? 'system';
  const favorites = workspace?.favorites ?? EMPTY_RECENT;
  const workspaceName = workspace?.name ?? '';

  const applyCatalog = useCallback((next: ToolCatalog): ToolCatalog => {
    setCatalog(next);
    setLoaded(true);
    return next;
  }, []);

  const reload = useCallback((): Promise<ToolCatalog> => {
    const asked = generation.current;
    void api
      .listAutomations()
      .then((next) => {
        if (asked === generation.current) {
          setAutomations(next);
        }
      })
      .catch(() => undefined);
    return api
      .listTools()
      .then((next) => (asked === generation.current ? applyCatalog(next) : next));
  }, [applyCatalog]);

  const report = useCallback((error: unknown) => {
    setBanner(messageOf(error));
  }, []);

  useEffect(() => {
    void reload().catch(report);
    void api.listRuns().then(setRuns).catch(report);
    void api.listAutomationRuns().then(setAutomationRuns).catch(report);
    void api
      .listWorkspaces()
      .then((list) => {
        setWorkspaces(list);
        // The panel stays closed at launch, so only the tool and the width come back.
        const layout = list.workspaces.find(({ id }) => id === list.activeId)?.layout;
        setSelectedTool(activeToolOf(layout));
        setPanelWidth(layout?.panelWidth ?? PANEL_WIDTH_DEFAULT);
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
    const onKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setModal((current) => (current?.kind === 'palette' ? undefined : { kind: 'palette' }));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

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
  const panelGroup = catalog.groups.find((candidate) => groupKey(candidate) === openCategory);
  const tool = allTools.find((candidate) => candidate.id === selectedTool) ?? allTools[0];
  const runningAutomations = automationRuns.filter(({ status }) => status === 'running').length;
  // An automation between steps has no tool running, but it still counts as work going on.
  const running = countRunning(runs) || runningAutomations;
  const recentTools = recent.flatMap((id) => allTools.filter((item) => item.id === id));
  const favoriteTools = favorites.flatMap((id) => allTools.filter((item) => item.id === id));

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

  function chooseTool(id: string): void {
    setSelectedTool(id);
    saveWorkspace({ layout: onlyToolTab(id) });
  }

  /** Enters what `list` says is active, with the view that Workspace was left in. */
  function enterWorkspace(list: WorkspaceListView): Promise<ToolCatalog> {
    generation.current += 1;
    const layout = list.workspaces.find(({ id }) => id === list.activeId)?.layout;
    setWorkspaces(list);
    setSelectedTool(activeToolOf(layout));
    setOpenCategory(layout?.openCategory);
    setPanelWidth(layout?.panelWidth ?? PANEL_WIDTH_DEFAULT);
    setHistoryTool(undefined);
    setSelectedAutomation(undefined);
    setAutomations(NO_AUTOMATIONS);
    setModal(undefined);
    setLoaded(false);
    setCatalog(EMPTY_CATALOG);
    setRecent(EMPTY_RECENT);
    return reload();
  }

  function switchWorkspace(id: string): void {
    if (id === workspaces.activeId) {
      setScreen('tools');
      return;
    }
    generation.current += 1;
    void api
      .switchWorkspace(id)
      .then((list) => {
        setScreen('tools');
        return enterWorkspace(list);
      })
      .catch(report);
  }

  function createWorkspace(name: string): void {
    setModal(undefined);
    generation.current += 1;
    void api
      .createWorkspace(name)
      .then((list) => {
        setScreen('tools');
        return enterWorkspace(list);
      })
      .catch(report);
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

  function showTool(id: string, list: ToolCatalog = catalog): void {
    const owner = list.groups.find((candidate) => candidate.tools.some((item) => item.id === id));
    if (owner !== undefined) {
      const nextOpen = openCategory === undefined ? undefined : groupKey(owner);
      setOpenCategory(nextOpen);
      setSelectedTool(id);
      saveWorkspace({ layout: { ...onlyToolTab(id), openCategory: nextOpen ?? null } });
      setScreen('tools');
    }
  }

  function pressCategory(key: string): void {
    const next = toggleCategory(openCategory, key);
    setOpenCategory(next);
    // Only choosing an item in the panel changes the work area.
    saveWorkspace({ layout: { openCategory: next ?? null } });
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
      showTool(firstId, list);
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
    setSelectedAutomation(undefined);
    void api.removeAutomation(id).then(reload).catch(report);
  }

  function showHistory(toolId?: string): void {
    setHistoryTool(toolId);
    setScreen('history');
  }

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
      run: () => {
        setSelectedAutomation(item.id);
        setScreen('automations');
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
        setScreen('workspaces');
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
        setScreen('settings');
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

  const empty = loaded && allTools.length === 0;

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
          currentTool={tool}
          screen={screen}
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
          onScreen={(next) => {
            if (next === 'history') {
              showHistory();
            } else {
              setScreen(next);
            }
            if (next === 'automations') {
              // The CLI, or a hand-edited file, can change these while the app stays focused.
              void reload().catch(report);
            }
          }}
        />

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
            <ul className="nav-list">
              {panelGroup.tools.map((item) => {
                const { state } = summarizeRuns(runs, item.id);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="row"
                      title={item.name}
                      aria-current={screen === 'tools' && item === tool ? 'true' : undefined}
                      onClick={() => {
                        chooseTool(item.id);
                        setScreen('tools');
                      }}
                    >
                      <span className="truncate">{item.name}</span>
                      {state === 'idle' ? null : (
                        <span className="row-state" title={runStateLabel(state)}>
                          <RunStateIcon state={state} />
                          <span className="visually-hidden">{runStateLabel(state)}</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {favoriteTools.length === 0 ? null : (
              <>
                <h2>{t('nav.favorites')}</h2>
                <ul className="nav-list" data-testid="favorite-tools">
                  {favoriteTools.map((item) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        className="row"
                        title={item.name}
                        onClick={() => {
                          showTool(item.id);
                        }}
                      >
                        <span className="truncate">{item.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {recentTools.length === 0 ? null : (
              <>
                <h2>{t('nav.recent')}</h2>
                <ul className="nav-list" data-testid="recent-tools">
                  {recentTools.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="row"
                        title={item.name}
                        onClick={() => {
                          showTool(item.id);
                        }}
                      >
                        <span className="truncate">{item.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        )}
        {panelGroup === undefined ? null : (
          <PanelResizer
            width={panelWidth}
            onResize={setPanelWidth}
            onCommit={(width) => {
              saveWorkspace({ layout: { panelWidth: width } });
            }}
          />
        )}

        <main className="work-area">
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
          {screen === 'settings' ? (
            <SettingsView
              key={historyRunLimit}
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
            />
          ) : null}
          {screen === 'workspaces' ? (
            <WorkspacesView
              list={workspaces}
              onSwitch={switchWorkspace}
              onRename={renameWorkspace}
              onRemove={removeWorkspace}
            />
          ) : null}
          {screen === 'automations' ? (
            <AutomationsView
              key={workspaces.activeId}
              list={automations}
              runs={automationRuns}
              workspaceId={workspaces.activeId}
              tools={allTools}
              selected={selectedAutomation}
              revision={catalog}
              onSelect={setSelectedAutomation}
              onSave={saveAutomation}
              onRun={runAutomation}
              onRemove={removeAutomation}
              onShowTool={showTool}
              onError={report}
            />
          ) : null}
          {screen === 'history' ? (
            <HistoryView
              tools={allTools}
              toolId={historyTool}
              revision={runs}
              onToolId={setHistoryTool}
              onError={report}
            />
          ) : null}
          {screen === 'problems' ? (
            <section className="problems">
              <h1>{t('problems.title')}</h1>
              <p className="muted">{t('problems.body')}</p>
              <dl className="facts">
                {catalog.problems.map((problem) => (
                  <div key={`${problem.scope}/${problem.folder}`}>
                    <dt>{problem.folder}</dt>
                    <dd>{problem.message}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {screen === 'tools' && empty ? <Welcome onAdd={addTool} onImport={importFolder} /> : null}
          {screen === 'tools' && tool?.level === 1 ? (
            <ToolRunner
              key={tool.key}
              tool={tool}
              runs={runs}
              favorite={favorites.includes(tool.id)}
              onToggleFavorite={() => {
                toggleFavorite(tool.id);
              }}
              onMove={() => {
                setModal({ kind: 'move', tool });
              }}
              onRun={(request) => {
                launch(tool, request);
              }}
              onStop={(runId) => {
                void api.cancelRun(runId).catch(report);
              }}
              onEdit={() => {
                setModal({ kind: 'edit', tool });
              }}
              onRemove={() => {
                setModal({ kind: 'remove', tool });
              }}
              onCheckAgain={() => {
                void reload().catch(report);
              }}
              onHistory={() => {
                showHistory(tool.id);
              }}
              onError={report}
            />
          ) : null}
          {screen === 'tools' && tool !== undefined && tool.level !== 1 ? (
            <ToolDetails
              tool={tool}
              runs={runs}
              favorite={favorites.includes(tool.id)}
              onToggleFavorite={() => {
                toggleFavorite(tool.id);
              }}
              onMove={() => {
                setModal({ kind: 'move', tool });
              }}
              onLaunch={() => {
                launch(tool);
              }}
              onStop={(runId) => {
                void api.cancelRun(runId).catch(report);
              }}
              onEdit={() => {
                setModal({ kind: 'edit', tool });
              }}
              onRemove={() => {
                setModal({ kind: 'remove', tool });
              }}
              onCheckAgain={() => {
                void reload().catch(report);
              }}
            />
          ) : null}
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

      {modal?.kind === 'palette' ? (
        <CommandPalette
          commands={commands}
          onClose={() => {
            setModal(undefined);
          }}
        />
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
                showTool(id, list);
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
              className="primary"
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
