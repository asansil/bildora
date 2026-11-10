import { useMemo } from 'react';
import type { AutomationBlock } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import { kindLabel } from './block-text.js';
import type { FlowDocument } from './flow-document.js';
import { outgoing } from './keyboard.js';

export interface OutlineProps {
  readonly document: FlowDocument;
  readonly names: ReadonlyMap<string, string>;
  /** Focuses a block on the canvas. */
  readonly onPick: (id: string) => void;
}

/**
 * The flow as a list, for screen readers and for anyone who would rather read than look: every
 * block with where its outputs lead, inside the group that frames it.
 */
export function Outline({ document, names, onPick }: OutlineProps) {
  // Built from the structure alone, so dragging a block does not rebuild it.
  const { blocks, connections, groups } = document;
  const tree = useMemo(() => {
    const structure = { ...document, blocks, connections, groups };
    const nameOf = (id: string): string => names.get(id) ?? id;
    const item = (block: AutomationBlock) => (
      <li key={block.id}>
        <button
          type="button"
          onClick={() => {
            onPick(block.id);
          }}
        >
          {nameOf(block.id)}
          <span className="muted"> · {kindLabel(block.type)}</span>
        </button>
        <ul className="outline-links">
          {outgoing(structure, block.id, nameOf).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </li>
    );
    const grouped = new Set(groups.flatMap((group) => group.blocks));
    return (
      <ul className="outline-list">
        {groups.map((group) => (
          <li key={group.id}>
            <span className="outline-group">{group.name}</span>
            <ul className="outline-list">
              {group.blocks.flatMap((id) => {
                const block = blocks.find((candidate) => candidate.id === id);
                return block === undefined ? [] : [item(block)];
              })}
            </ul>
          </li>
        ))}
        {blocks.filter(({ id }) => !grouped.has(id)).map(item)}
      </ul>
    );
    // `document` stands for its own structure here; positions are left out on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, connections, groups, names, onPick]);
  return (
    <nav className="outline" aria-label={t('canvas.outline')} data-testid="outline">
      {tree}
    </nav>
  );
}
