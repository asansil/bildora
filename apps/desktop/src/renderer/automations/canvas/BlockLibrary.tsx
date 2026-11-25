import { useId, useState } from 'react';
import { ChevronLeft, StickyNote } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../../shared/i18n/translate.js';
import type { ToolView } from '../../../shared/ipc-contract.js';
import { BlockSwatch } from './BlockIcon.js';
import { kindLabel } from './block-text.js';
import { LIBRARY_DRAG_TYPE } from './Canvas.js';
import { matches } from './KeyboardDialogs.js';
import type { AddChoice } from './KeyboardDialogs.js';

/** The blocks that steer the flow, in the order the library lists them. */
export const CONTROL_KINDS = [
  'wait-for-time',
  'wait-for-manual-action',
  'if',
  'switch',
  'parallel',
  'join',
  'for',
  'while',
] as const;

/** Another automation a Run automation block can call. */
export interface CallableAutomation {
  readonly id: string;
  readonly name: string;
}

const CONTROLS = CONTROL_KINDS.map((kind) => ({ choice: { kind } satisfies AddChoice }));

export interface BlockLibraryProps {
  readonly tools: readonly ToolView[];
  /** The other automations of the Workspace, which a Run automation block can call. */
  readonly automations: readonly CallableAutomation[];
  /** Whether some Parallel has no Join yet, so that a Join can be added. */
  readonly canJoin: boolean;
  /** Adds a block after the selected one, or a note beside it. */
  readonly onAdd: (choice: AddChoice) => void;
  /** Folds the panel down to a strip. */
  readonly onCollapse: () => void;
}

function Item({
  choice,
  label,
  icon,
  disabled,
  onAdd,
}: {
  readonly choice: AddChoice;
  readonly label: string;
  readonly icon: ReactNode;
  /** Why it cannot be added now, when it cannot. */
  readonly disabled?: string | undefined;
  readonly onAdd: (choice: AddChoice) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="library-item"
        disabled={disabled !== undefined}
        title={disabled}
        draggable={disabled === undefined}
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
export function BlockLibrary({
  tools,
  automations,
  canJoin,
  onAdd,
  onCollapse,
}: BlockLibraryProps) {
  const searchId = useId();
  const [filter, setFilter] = useState('');
  const shownTools = tools.filter(({ name }) => matches(name, filter));
  const shownControls = CONTROLS.filter(({ choice }) => matches(kindLabel(choice.kind), filter));
  const shownAutomations = automations.filter(({ name }) => matches(name, filter));
  const showNote = matches(t('canvas.kindNote'), filter);
  const nothing =
    shownTools.length === 0 &&
    shownControls.length === 0 &&
    shownAutomations.length === 0 &&
    !showNote;
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
              icon={<BlockSwatch kind="run" tool={tool} />}
              onAdd={onAdd}
            />
          ))}
        </ul>
      )}
      {shownControls.length === 0 ? null : (
        <>
          <h2>{t('canvas.libraryControl')}</h2>
          <ul className="library-list">
            {shownControls.map(({ choice }) => (
              <Item
                key={choice.kind}
                choice={choice}
                label={kindLabel(choice.kind)}
                icon={<BlockSwatch kind={choice.kind} />}
                disabled={
                  choice.kind === 'join' && !canJoin ? t('canvas.joinNeedsParallel') : undefined
                }
                onAdd={onAdd}
              />
            ))}
          </ul>
        </>
      )}
      {shownAutomations.length === 0 ? null : (
        <>
          <h2>{t('canvas.libraryAutomations')}</h2>
          <ul className="library-list">
            {shownAutomations.map((automation) => (
              <Item
                key={automation.id}
                choice={{
                  kind: 'run-automation',
                  automation: automation.id,
                  automationName: automation.name,
                }}
                label={automation.name}
                icon={<BlockSwatch kind="run-automation" />}
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
              icon={
                <span
                  className="block-swatch block-swatch--small block-swatch--note"
                  aria-hidden="true"
                >
                  <StickyNote className="icon" />
                </span>
              }
              onAdd={onAdd}
            />
          </ul>
        </>
      ) : null}
      <p className="field-hint">{t('canvas.libraryHint')}</p>
    </nav>
  );
}
