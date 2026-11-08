import { useState } from 'react';
import { Folder, History, Settings, TriangleAlert, Workflow } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { ToolGroupView } from '../../shared/ipc-contract.js';
import type { WorkspaceView } from '../../shared/ipc-contract.js';
import { categoryInitial, groupKey, groupLabel } from '../tools/category-rail.js';
import { WorkspaceSelector } from './WorkspaceSelector.js';

export const TOOL_PANEL_ID = 'tool-panel';

export type RailDialog = 'problems' | 'settings' | 'workspaces';

/**
 * The Automations panel, which opens and closes like a category. A category key is its name, and
 * the forms cannot type the NUL character, so only a hand-written manifest could clash with it.
 */
export const AUTOMATIONS_PANEL = '\u0000automations';
export const HISTORY_OWNER = '\u0000history';

const DRAG_TYPE = 'application/x-bildora-category';

interface CategoryGlyphProps {
  readonly group: ToolGroupView;
}

/** The logo the user chose, or the default one. An image that cannot be drawn counts as none. */
function CategoryGlyph({ group }: CategoryGlyphProps) {
  const { category, logo } = group;
  const [failedLogo, setFailedLogo] = useState<string | undefined>(undefined);

  if (category === undefined) {
    return <Folder className="icon" aria-hidden="true" />;
  }
  if (logo !== undefined && logo !== failedLogo) {
    return (
      <img
        className="rail-logo"
        src={logo}
        alt=""
        draggable={false}
        onError={() => {
          setFailedLogo(logo);
        }}
      />
    );
  }
  return (
    <span className="rail-initial" aria-hidden="true">
      {categoryInitial(category)}
    </span>
  );
}

interface CategoryRailProps {
  readonly groups: readonly ToolGroupView[];
  /** The panel that is open: a category key, or `AUTOMATIONS_PANEL`. */
  readonly openCategory: string | undefined;
  /** What owns the active tab: a category key, `AUTOMATIONS_PANEL` or `HISTORY_OWNER`. */
  readonly owner: string | undefined;
  readonly problemCount: number;
  readonly workspaces: readonly WorkspaceView[];
  readonly activeWorkspace: string | undefined;
  readonly onToggleCategory: (key: string) => void;
  readonly onCategoryMenu: (category: string) => void;
  /** A category was dragged onto another. */
  readonly onPlaceCategory: (dragged: string, target: string) => void;
  readonly onHistory: () => void;
  /** Settings, Problems and Manage Workspaces open over the work area and never move the mark. */
  readonly onDialog: (dialog: RailDialog) => void;
  readonly onSwitchWorkspace: (id: string) => void;
  readonly onCreateWorkspace: () => void;
}

/** The always visible column of icons. */
export function CategoryRail({
  groups,
  openCategory,
  owner,
  problemCount,
  workspaces,
  activeWorkspace,
  onToggleCategory,
  onCategoryMenu,
  onPlaceCategory,
  onHistory,
  onDialog,
  onSwitchWorkspace,
  onCreateWorkspace,
}: CategoryRailProps) {
  return (
    <nav className="sidebar" aria-label={t('nav.categories')}>
      <ul className="nav-list">
        {groups.map((group) => {
          const key = groupKey(group);
          const label = groupLabel(group);
          const { category } = group;
          const open = key === openCategory;
          const current = key === owner;
          return (
            <li key={key}>
              <button
                type="button"
                className="rail-button"
                title={label}
                aria-expanded={open}
                aria-controls={open ? TOOL_PANEL_ID : undefined}
                aria-current={current ? 'true' : undefined}
                draggable={category !== undefined}
                onDragStart={(event) => {
                  if (category !== undefined) {
                    event.dataTransfer.setData(DRAG_TYPE, category);
                    event.dataTransfer.effectAllowed = 'move';
                  }
                }}
                onDragOver={(event) => {
                  if (category !== undefined && event.dataTransfer.types.includes(DRAG_TYPE)) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }
                }}
                onDrop={(event) => {
                  const dragged = event.dataTransfer.getData(DRAG_TYPE);
                  if (category !== undefined && dragged !== '') {
                    event.preventDefault();
                    event.stopPropagation();
                    onPlaceCategory(dragged, category);
                  }
                }}
                onClick={() => {
                  onToggleCategory(key);
                }}
                onContextMenu={
                  category === undefined
                    ? undefined
                    : (event) => {
                        event.preventDefault();
                        onCategoryMenu(category);
                      }
                }
              >
                <CategoryGlyph group={group} />
                <span className="visually-hidden">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <ul className="nav-list nav-bottom">
        {problemCount === 0 ? null : (
          <li>
            <button
              type="button"
              className="rail-button"
              title={t('nav.problems')}
              aria-haspopup="dialog"
              onClick={() => {
                onDialog('problems');
              }}
            >
              <TriangleAlert className="icon state-warning" aria-hidden="true" />
              <span className="visually-hidden">{t('nav.problems')}</span>
              <span className="rail-badge">{problemCount}</span>
            </button>
          </li>
        )}
        <li>
          <WorkspaceSelector
            workspaces={workspaces}
            activeId={activeWorkspace}
            onSwitch={onSwitchWorkspace}
            onCreate={onCreateWorkspace}
            onManage={() => {
              onDialog('workspaces');
            }}
          />
        </li>
        <li>
          <button
            type="button"
            className="rail-button"
            title={t('nav.automations')}
            aria-expanded={openCategory === AUTOMATIONS_PANEL}
            aria-controls={openCategory === AUTOMATIONS_PANEL ? TOOL_PANEL_ID : undefined}
            aria-current={owner === AUTOMATIONS_PANEL ? 'true' : undefined}
            onClick={() => {
              onToggleCategory(AUTOMATIONS_PANEL);
            }}
          >
            <Workflow className="icon" aria-hidden="true" />
            <span className="visually-hidden">{t('nav.automations')}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="rail-button"
            title={t('nav.history')}
            aria-current={owner === HISTORY_OWNER ? 'true' : undefined}
            onClick={onHistory}
          >
            <History className="icon" aria-hidden="true" />
            <span className="visually-hidden">{t('nav.history')}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className="rail-button"
            title={t('nav.settings')}
            aria-haspopup="dialog"
            onClick={() => {
              onDialog('settings');
            }}
          >
            <Settings className="icon" aria-hidden="true" />
            <span className="visually-hidden">{t('nav.settings')}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
