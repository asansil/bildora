import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { Folder, Search, Settings, TriangleAlert, X } from 'lucide-react';
import { t } from '../shared/i18n/translate.js';
import type {
  DetectionView,
  ProposalView,
  RegisterTools,
  RegistrationView,
  RunView,
  ShellTheme,
  ToolCatalog,
  ToolGroupView,
  ToolView,
} from '../shared/ipc-contract.js';
import { ImportReview } from './import/ImportReview.js';
import { CommandPalette } from './palette/CommandPalette.js';
import type { Command } from './palette/CommandPalette.js';
import { SettingsView, THEME_LABELS } from './settings/SettingsView.js';
import { BildoraMark } from './shell/BildoraMark.js';
import { Dialog } from './shell/Dialog.js';
import { MenuBar } from './shell/MenuBar.js';
import type { Menu } from './shell/MenuBar.js';
import { RunStateBadge, RunStateIcon, runStateLabel } from './shell/RunStateBadge.js';
import { ToolDetails } from './tools/ToolDetails.js';
import { ToolForm } from './tools/ToolForm.js';
import { Welcome } from './tools/Welcome.js';
import { countRunning, summarizeRuns } from './tools/run-state.js';

const api = window.bildora;
const EMPTY_CATALOG: ToolCatalog = { groups: [], problems: [] };

type Screen = 'tools' | 'problems' | 'settings';

type Modal =
  | { readonly kind: 'palette' }
  | { readonly kind: 'about' }
  | { readonly kind: 'add'; readonly proposal: ProposalView }
  | { readonly kind: 'edit'; readonly tool: ToolView }
  | { readonly kind: 'remove'; readonly tool: ToolView }
  | { readonly kind: 'review'; readonly detection: DetectionView };

function groupKey(group: ToolGroupView): string {
  return group.category ?? '';
}

function groupLabel(group: ToolGroupView): string {
  return group.category ?? t('nav.uncategorized');
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
  const [version, setVersion] = useState('');
  const [theme, setTheme] = useState<ShellTheme>('system');
  const [screen, setScreen] = useState<Screen>('tools');
  const [selectedGroup, setSelectedGroup] = useState<string | undefined>(undefined);
  const [selectedTool, setSelectedTool] = useState<string | undefined>(undefined);
  const [modal, setModal] = useState<Modal | undefined>(undefined);
  const [banner, setBanner] = useState<string | undefined>(undefined);
  const [dropping, setDropping] = useState(false);

  const applyCatalog = useCallback((next: ToolCatalog): ToolCatalog => {
    setCatalog(next);
    setLoaded(true);
    return next;
  }, []);

  const reload = useCallback(
    (): Promise<ToolCatalog> => api.listTools().then(applyCatalog),
    [applyCatalog],
  );

  const report = useCallback((error: unknown) => {
    setBanner(messageOf(error));
  }, []);

  useEffect(() => {
    void api.listTools().then(applyCatalog).catch(report);
    void api.listRuns().then(setRuns).catch(report);
    void api
      .shellInfo()
      .then(({ version: value }) => {
        setVersion(value);
      })
      .catch(report);
    void api
      .getPreferences()
      .then((preferences) => {
        setTheme(preferences.theme);
      })
      .catch(report);
    const stopListening = api.onRunsChanged(setRuns);
    // A program may have been installed or moved while the user was elsewhere.
    const onFocus = (): void => {
      void api.listTools().then(applyCatalog).catch(report);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      stopListening();
      window.removeEventListener('focus', onFocus);
    };
  }, [applyCatalog, report]);

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

  const allTools = useMemo(() => catalog.groups.flatMap((group) => group.tools), [catalog]);
  const group =
    catalog.groups.find((candidate) => groupKey(candidate) === selectedGroup) ?? catalog.groups[0];
  const tool = group?.tools.find((candidate) => candidate.id === selectedTool) ?? group?.tools[0];
  const running = countRunning(runs);

  function showTool(id: string, list: ToolCatalog = catalog): void {
    const owner = list.groups.find((candidate) => candidate.tools.some((item) => item.id === id));
    if (owner !== undefined) {
      setSelectedGroup(groupKey(owner));
      setSelectedTool(id);
      setScreen('tools');
    }
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

  function register(programs: RegisterTools['programs']): void {
    setModal(undefined);
    void api.registerTools({ programs }).then(finishRegistration).catch(report);
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
        if (only !== undefined && others.length === 0) {
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

  function launch(target: ToolView): void {
    void api.startRun(target.id).catch(report);
  }

  function changeTheme(next: ShellTheme): void {
    setTheme(next);
    void api.setPreferences({ theme: next }).catch(report);
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
    { id: 'add', label: t('menu.addTool'), detail: t('palette.action'), run: addTool },
    {
      id: 'import',
      label: t('menu.importFolder'),
      detail: t('palette.action'),
      run: importFolder,
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

  const empty = loaded && allTools.length === 0 && catalog.problems.length === 0;

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
        <nav className="sidebar" aria-label={t('nav.categories')}>
          <ul className="nav-list">
            {catalog.groups.map((item) => {
              const current = screen === 'tools' && item === group;
              return (
                <li key={groupKey(item)}>
                  <button
                    type="button"
                    className="row"
                    aria-current={current ? 'true' : undefined}
                    title={groupLabel(item)}
                    onClick={() => {
                      setSelectedGroup(groupKey(item));
                      setSelectedTool(undefined);
                      setScreen('tools');
                    }}
                  >
                    <Folder className="icon muted" aria-hidden="true" />
                    <span className="truncate">{groupLabel(item)}</span>
                    <span className="row-count">{item.tools.length}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <ul className="nav-list nav-bottom">
            {catalog.problems.length === 0 ? null : (
              <li>
                <button
                  type="button"
                  className="row"
                  aria-current={screen === 'problems' ? 'true' : undefined}
                  onClick={() => {
                    setScreen('problems');
                  }}
                >
                  <TriangleAlert className="icon state-warning" aria-hidden="true" />
                  <span className="truncate">{t('nav.problems')}</span>
                  <span className="row-count">{catalog.problems.length}</span>
                </button>
              </li>
            )}
            <li>
              <button
                type="button"
                className="row"
                aria-current={screen === 'settings' ? 'true' : undefined}
                onClick={() => {
                  setScreen('settings');
                }}
              >
                <Settings className="icon muted" aria-hidden="true" />
                <span className="truncate">{t('nav.settings')}</span>
              </button>
            </li>
          </ul>
        </nav>

        {screen === 'tools' && group !== undefined ? (
          <aside className="context-panel" aria-label={t('nav.tools')}>
            <h2>{groupLabel(group)}</h2>
            <ul className="nav-list">
              {group.tools.map((item) => {
                const { state } = summarizeRuns(runs, item.id);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="row"
                      title={item.name}
                      aria-current={item === tool ? 'true' : undefined}
                      onClick={() => {
                        setSelectedTool(item.id);
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
          </aside>
        ) : null}

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
          {screen === 'settings' ? <SettingsView theme={theme} onTheme={changeTheme} /> : null}
          {screen === 'problems' ? (
            <section className="problems">
              <h1>{t('problems.title')}</h1>
              <p className="muted">{t('problems.body')}</p>
              <dl className="facts">
                {catalog.problems.map((problem) => (
                  <div key={problem.folder}>
                    <dt>{problem.folder}</dt>
                    <dd>{problem.message}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
          {screen === 'tools' && empty ? <Welcome onAdd={addTool} onImport={importFolder} /> : null}
          {screen === 'tools' && tool !== undefined ? (
            <ToolDetails
              tool={tool}
              runs={runs}
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
          initial={{
            name: modal.proposal.name,
            ...(modal.proposal.category === undefined ? {} : { category: modal.proposal.category }),
            ...(modal.proposal.interpreter === undefined
              ? {}
              : { interpreter: modal.proposal.interpreter }),
          }}
          onSubmit={(details) => {
            register([{ ...details, program: modal.proposal.path }]);
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
          <p>{t('remove.body')}</p>
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
      {modal?.kind === 'review' ? (
        <ImportReview
          detection={modal.detection}
          onConfirm={register}
          onClose={() => {
            setModal(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
