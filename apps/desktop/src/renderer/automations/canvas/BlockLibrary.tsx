import { Clock, GitBranch, GitFork, Hand, ListTree, StickyNote, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t } from '../../../shared/i18n/translate.js';
import type { ToolView } from '../../../shared/ipc-contract.js';
import { kindLabel } from './block-text.js';
import { LIBRARY_DRAG_TYPE } from './Canvas.js';
import type { NewBlock } from './flow-document.js';

const CONTROLS: readonly { readonly choice: NewBlock; readonly icon: LucideIcon }[] = [
  { choice: { kind: 'wait-for-time' }, icon: Clock },
  { choice: { kind: 'wait-for-manual-action' }, icon: Hand },
  { choice: { kind: 'if' }, icon: GitBranch },
  { choice: { kind: 'switch' }, icon: ListTree },
  { choice: { kind: 'parallel' }, icon: GitFork },
];

export interface BlockLibraryProps {
  readonly tools: readonly ToolView[];
  readonly logos: ReadonlyMap<string, string>;
  /** Adds a block after the selected one, or beside the flow when none is selected. */
  readonly onAdd: (choice: NewBlock) => void;
  readonly onAddNote: () => void;
}

function Item({
  choice,
  label,
  icon: Icon,
  logo,
  onAdd,
}: {
  readonly choice: NewBlock;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly logo?: string | undefined;
  readonly onAdd: (choice: NewBlock) => void;
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
        {logo === undefined ? (
          <Icon className="icon" aria-hidden="true" />
        ) : (
          <img src={logo} alt="" draggable={false} />
        )}
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
}

/** What can be added: the Workspace's tools, then the blocks that steer the flow. */
export function BlockLibrary({ tools, logos, onAdd, onAddNote }: BlockLibraryProps) {
  return (
    <nav
      className="flow-side flow-library"
      aria-label={t('canvas.library')}
      data-testid="block-library"
    >
      <h2>{t('canvas.libraryTools')}</h2>
      {tools.length === 0 ? (
        <p className="muted">{t('canvas.noTools')}</p>
      ) : (
        <ul className="library-list">
          {tools.map((tool) => (
            <Item
              key={tool.key}
              choice={{ kind: 'run', tool: tool.id }}
              label={tool.name}
              icon={Wrench}
              logo={logos.get(tool.id)}
              onAdd={onAdd}
            />
          ))}
        </ul>
      )}
      <h2>{t('canvas.libraryControl')}</h2>
      <ul className="library-list">
        {CONTROLS.map(({ choice, icon }) => (
          <Item
            key={choice.kind}
            choice={choice}
            label={kindLabel(choice.kind)}
            icon={icon}
            onAdd={onAdd}
          />
        ))}
      </ul>
      <h2>{t('canvas.libraryNotes')}</h2>
      <ul className="library-list">
        <li>
          <button type="button" className="library-item" onClick={onAddNote}>
            <StickyNote className="icon" aria-hidden="true" />
            <span className="truncate">{t('canvas.kindNote')}</span>
          </button>
        </li>
      </ul>
      <p className="field-hint">{t('canvas.libraryHint')}</p>
    </nav>
  );
}
