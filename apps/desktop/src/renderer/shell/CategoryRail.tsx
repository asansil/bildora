import { useState } from 'react';
import { Folder, Settings, TriangleAlert } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { ToolGroupView, ToolView } from '../../shared/ipc-contract.js';
import { categoryInitial, groupKey, groupLabel } from '../tools/category-rail.js';

export const TOOL_PANEL_ID = 'tool-panel';

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
  /** The category whose panel is open. */
  readonly openCategory: string | undefined;
  /** The tool in the work area, if the work area is showing one. */
  readonly currentTool: ToolView | undefined;
  readonly screen: 'tools' | 'problems' | 'settings';
  readonly problemCount: number;
  readonly onToggleCategory: (key: string) => void;
  readonly onCategoryMenu: (category: string) => void;
  readonly onScreen: (screen: 'problems' | 'settings') => void;
}

/** The always visible column of icons. */
export function CategoryRail({
  groups,
  openCategory,
  currentTool,
  screen,
  problemCount,
  onToggleCategory,
  onCategoryMenu,
  onScreen,
}: CategoryRailProps) {
  return (
    <nav className="sidebar" aria-label={t('nav.categories')}>
      <ul className="nav-list">
        {groups.map((group) => {
          const key = groupKey(group);
          const label = groupLabel(group);
          const { category } = group;
          const open = key === openCategory;
          const current =
            screen === 'tools' && currentTool !== undefined && group.tools.includes(currentTool);
          return (
            <li key={key}>
              <button
                type="button"
                className="rail-button"
                title={label}
                aria-expanded={open}
                aria-controls={open ? TOOL_PANEL_ID : undefined}
                aria-current={current ? 'true' : undefined}
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
              aria-current={screen === 'problems' ? 'true' : undefined}
              onClick={() => {
                onScreen('problems');
              }}
            >
              <TriangleAlert className="icon state-warning" aria-hidden="true" />
              <span className="visually-hidden">{t('nav.problems')}</span>
              <span className="rail-badge">{problemCount}</span>
            </button>
          </li>
        )}
        <li>
          <button
            type="button"
            className="rail-button"
            title={t('nav.settings')}
            aria-current={screen === 'settings' ? 'true' : undefined}
            onClick={() => {
              onScreen('settings');
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
