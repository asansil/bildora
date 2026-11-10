import { useId, useState } from 'react';
import { ChevronLeft, Clock, GitBranch, GitFork, Hand, ListTree, StickyNote } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../../shared/i18n/translate.js';
import type { ToolView } from '../../../shared/ipc-contract.js';
import { ProgramIcon } from '../../shell/ProgramIcon.js';
import { kindLabel } from './block-text.js';
import { LIBRARY_DRAG_TYPE } from './Canvas.js';
import { matches } from './KeyboardDialogs.js';
import type { AddChoice } from './KeyboardDialogs.js';

const CONTROLS: readonly { readonly choice: AddChoice; readonly icon: LucideIcon }[] = [
  { choice: { kind: 'wait-for-time' }, icon: Clock },
  { choice: { kind: 'wait-for-manual-action' }, icon: Hand },
  { choice: { kind: 'if' }, icon: GitBranch },
  { choice: { kind: 'switch' }, icon: ListTree },
  { choice: { kind: 'parallel' }, icon: GitFork },
];

/** The icon the library draws for a block that steers the flow. */
export function controlIcon(kind: AddChoice['kind']): LucideIcon | undefined {
  return CONTROLS.find(({ choice }) => choice.kind === kind)?.icon;
}

export interface BlockLibraryProps {
  readonly tools: readonly ToolView[];
  /** Adds a block after the selected one, or a note beside it. */
  readonly onAdd: (choice: AddChoice) => void;
  /** Folds the panel down to a strip. */
  readonly onCollapse: () => void;
}

function Item({
  choice,
  label,
  icon,
  onAdd,
}: {
  readonly choice: AddChoice;
  readonly label: string;
  readonly icon: ReactNode;
  readonly onAdd: (choice: AddChoice) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="library-item"
        draggable
        data-testid="library-item"
        onDragStart={(event) => {
          event.dataTransfer.setData(LIBRARY_DRAG_TYPE, JSON.stringify(choice));
          event.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => {
          onAdd(choice);
        }}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
}

/** What can be added: the Workspace's tools, then the blocks that steer the flow, then notes. */
export function BlockLibrary({ tools, onAdd, onCollapse }: BlockLibraryProps) {
  const searchId = useId();
  const [filter, setFilter] = useState('');
  const shownTools = tools.filter(({ name }) => matches(name, filter));
  const shownControls = CONTROLS.filter(({ choice }) =>
    matches(choice.kind === 'run' || choice.kind === 'note' ? '' : kindLabel(choice.kind), filter),
  );
  const showNote = matches(t('canvas.kindNote'), filter);
  const nothing = shownTools.length === 0 && shownControls.length === 0 && !showNote;
  return (
    <nav
      className="flow-side flow-library"
      aria-label={t('canvas.library')}
      data-testid="block-library"
    >
      <div className="flow-side-head">
        <div className="field library-search">
          <label className="visually-hidden" htmlFor={searchId}>
            {t('canvas.findBlock')}
          </label>
          <input
            id={searchId}
            type="search"
            placeholder={t('canvas.findBlock')}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('canvas.hideLibrary')}
          title={t('canvas.hideLibrary')}
          aria-expanded="true"
          onClick={onCollapse}
        >
          <ChevronLeft className="icon" aria-hidden="true" />
        </button>
      </div>
      {nothing ? <p className="muted">{t('canvas.libraryNoMatch')}</p> : null}
      {shownTools.length > 0 || (filter === '' && tools.length === 0) ? (
        <h2>{t('canvas.libraryTools')}</h2>
      ) : null}
      {tools.length === 0 && filter === '' ? (
        <p className="muted">{t('canvas.noTools')}</p>
      ) : shownTools.length === 0 ? null : (
        <ul className="library-list">
          {shownTools.map((tool) => (
            <Item
              key={tool.key}
              choice={{ kind: 'run', tool: tool.id }}
              label={tool.name}
              icon={<ProgramIcon tool={tool} />}
              onAdd={onAdd}
            />
          ))}
        </ul>
      )}
      {shownControls.length === 0 ? null : (
        <>
          <h2>{t('canvas.libraryControl')}</h2>
          <ul className="library-list">
            {shownControls.map(({ choice, icon: Icon }) => (
              <Item
                key={choice.kind}
                choice={choice}
                label={
                  choice.kind === 'run' || choice.kind === 'note' ? '' : kindLabel(choice.kind)
                }
                icon={<Icon className="icon" aria-hidden="true" />}
                onAdd={onAdd}
              />
            ))}
          </ul>
        </>
      )}
      {showNote ? (
        <>
          <h2>{t('canvas.libraryNotes')}</h2>
          <ul className="library-list">
            <Item
              choice={{ kind: 'note' }}
              label={t('canvas.kindNote')}
              icon={<StickyNote className="icon" aria-hidden="true" />}
              onAdd={onAdd}
            />
          </ul>
        </>
      ) : null}
      <p className="field-hint">{t('canvas.libraryHint')}</p>
    </nav>
  );
}
