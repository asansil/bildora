import { memo, use, useContext, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { Handle, NodeResizer, Position, useUpdateNodeInternals } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { Link2, TriangleAlert } from 'lucide-react';
import { ERROR_OUTPUT, NOTE_TEXT_MAX } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { StepStateView, ToolView } from '../../../shared/ipc-contract.js';
import { RunStateIcon } from '../../shell/RunStateBadge.js';
import { BlockIcon, familyOf } from './BlockIcon.js';
import {
  CanvasActionsContext,
  InputTonesContext,
  PortHoverContext,
  PortLayoutsContext,
} from './canvas-actions.js';
import type { BlockKind } from './flow-document.js';
import { INPUT_PORT, layoutKey } from './port-sides.js';
import type { PortLayout, PortPlace, Side } from './port-sides.js';

export interface OutputView {
  readonly id: string;
  readonly label: string;
}

export interface BlockNodeData extends Record<string, unknown> {
  readonly kind: BlockKind;
  readonly name: string;
  readonly kindLabel: string;
  readonly outputs: readonly OutputView[];
  /** The element's id, which the canvas names as its focused block. */
  readonly domId: string;
  /** The block's id in the file, as links name it. */
  readonly blockId: string;
  /** What a screen reader says: the block, then where its outputs lead. */
  readonly description: string;
  /** A Run tool block's tool, whose program icon the block shows. */
  readonly tool?: ToolView;
  readonly problems: number;
  /** How many other blocks link to this one's values. */
  readonly usedBy: number;
  /** Set when the run passes through the block, which is then drawn dimmed. */
  readonly disabled: boolean;
  /** Set in the run view. */
  readonly state?: StepStateView;
  /** A line under the name in the run view, such as a progress message or a failure. */
  readonly detail?: string;
}

export type BlockNode = Node<BlockNodeData, 'block'>;

const POSITIONS: Readonly<Record<Side, Position>> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

/** Where a port sits along its side, as xyflow places a handle. */
function along(place: PortPlace): CSSProperties {
  const at = `${String(place.offset * 100)}%`;
  return place.side === 'left' || place.side === 'right' ? { top: at } : { left: at };
}

const RESTING: Readonly<Record<string, PortPlace>> = {
  [INPUT_PORT]: { side: 'left', offset: 0.5 },
  [ERROR_OUTPUT]: { side: 'bottom', offset: 0.5 },
};

function placeOf(layout: PortLayout | undefined, port: string): PortPlace {
  return layout?.get(port) ?? RESTING[port] ?? { side: 'right', offset: 0.5 };
}

/**
 * Outputs on whichever side faces where they lead. Each has a shape by kind (a square, a diamond
 * for Error) and, where a block has several to choose from, a label outside the block.
 */
function Outputs({
  outputs,
  labelled,
  layout,
}: {
  outputs: readonly OutputView[];
  labelled: boolean;
  layout: PortLayout | undefined;
}) {
  return (
    <>
      {outputs.map((output) => {
        const place = placeOf(layout, output.id);
        const error = output.id === ERROR_OUTPUT;
        const kind = error ? 'error' : labelled ? 'branch' : 'out';
        return (
          <Handle
            key={output.id}
            id={output.id}
            type="source"
            position={POSITIONS[place.side]}
            className={`handle handle--${kind}`}
            style={along(place)}
            aria-label={t('canvas.outputHandle', { output: output.label })}
            // The canvas shows its own tooltip for a port, not the block's.
            title=""
            data-output={output.id}
            data-side={place.side}
          >
            {labelled && !error ? (
              <span className={`handle-label handle-label--${place.side}`}>{output.label}</span>
            ) : null}
          </Handle>
        );
      })}
    </>
  );
}

/** How many other blocks follow this one's values. Pressing it finds them on the canvas. */
function UsedBy({ id, count }: { readonly id: string; readonly count: number }) {
  const actions = useContext(CanvasActionsContext);
  const label = count === 1 ? t('canvas.usedByOne') : t('canvas.usedBy', { count });
  return (
    <button
      type="button"
      className="block-used-by nodrag"
      title={label}
      aria-label={label}
      data-testid="block-used-by"
      tabIndex={-1}
      disabled={actions === undefined}
      onClick={(event) => {
        event.stopPropagation();
        actions?.showUses(id);
      }}
    >
      <Link2 className="icon" aria-hidden="true" />
      <span>{count}</span>
    </button>
  );
}

export const BlockNodeView = memo(function BlockNodeView({
  id,
  data,
  selected,
}: NodeProps<BlockNode>) {
  // Labels name the outputs a block chooses between; Next and Error read by their shape.
  const labelled = data.outputs.filter((output) => output.id !== ERROR_OUTPUT).length > 1;
  const layout = use(PortLayoutsContext).get(data.blockId);
  const tone = use(InputTonesContext).get(data.blockId);
  const portHover = use(PortHoverContext);
  const peer = portHover.peers.has(data.blockId);
  const key = layoutKey(layout);
  const updateNodeInternals = useUpdateNodeInternals();
  // xyflow measures handles once; moved ones must be measured again for connections to follow.
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, key, updateNodeInternals]);
  const classes = [
    'block',
    `block--${data.kind}`,
    `family-${familyOf(data.kind)}`,
    selected ? 'is-selected' : '',
    peer ? 'is-port-peer' : '',
    data.disabled ? 'is-disabled' : '',
    data.state === undefined ? '' : `is-${data.state}`,
  ].join(' ');
  const input = placeOf(layout, INPUT_PORT);
  // Over one of its ports the canvas shows the port's tooltip, so the block's own stays away.
  const title =
    portHover.owner === data.blockId
      ? undefined
      : [data.name, data.kindLabel, data.disabled ? t('canvas.disabledBlock') : '', data.detail]
          .filter(Boolean)
          .join('\n');
  return (
    <div
      id={data.domId}
      role="group"
      aria-label={data.description}
      className={classes}
      title={title}
      data-testid="canvas-block"
      data-kind={data.kind}
      data-state={data.state}
    >
      {data.kind === 'start' ? null : (
        <Handle
          id={INPUT_PORT}
          type="target"
          position={POSITIONS[input.side]}
          className="handle handle--in"
          style={along(input)}
          title=""
          data-side={input.side}
          data-tone={tone}
        />
      )}
      {data.state === undefined || data.state === 'disabled' ? null : (
        <span className="block-state">
          <RunStateIcon state={data.state} />
        </span>
      )}
      <span className="block-tile" aria-hidden="true">
        <BlockIcon kind={data.kind} tool={data.tool} className="block-logo" />
      </span>
      <span className="block-name truncate">{data.name}</span>
      {data.detail === undefined ? null : (
        <span className="block-detail truncate">{data.detail}</span>
      )}
      {data.usedBy > 0 ? <UsedBy id={data.blockId} count={data.usedBy} /> : null}
      {data.problems > 0 ? (
        <span className="block-problem" title={t('canvas.blockProblems', { count: data.problems })}>
          <TriangleAlert className="icon" aria-hidden="true" />
        </span>
      ) : null}
      <Outputs outputs={data.outputs} labelled={labelled} layout={layout} />
    </div>
  );
});

export interface NoteNodeData extends Record<string, unknown> {
  readonly text: string;
  readonly placeholder: string;
  readonly readOnly: boolean;
}

export type NoteNode = Node<NoteNodeData, 'note'>;

/**
 * Text on the canvas. A double-click writes it in place; the settings panel holds the same text,
 * so the keyboard reaches it too.
 */
export const NoteNodeView = memo(function NoteNodeView({
  id,
  data,
  selected,
}: NodeProps<NoteNode>) {
  const actions = useContext(CanvasActionsContext);
  const editing = actions !== undefined && actions.editingNote === id;
  return (
    <div className={`note${selected ? ' is-selected' : ''}`} data-testid="canvas-note">
      {data.readOnly ? null : <NodeResizer isVisible={selected} minWidth={120} minHeight={48} />}
      {editing ? (
        <textarea
          className="note-input nodrag nowheel nopan"
          data-testid="note-input"
          aria-label={t('canvas.noteText')}
          autoFocus
          defaultValue={data.text}
          maxLength={NOTE_TEXT_MAX}
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          onBlur={(event) => {
            actions.finishNote(id, event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            // Keys typed here belong to the text, not to the canvas around it.
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <p className={data.text === '' ? 'note-text is-empty' : 'note-text'}>
          {data.text === '' ? data.placeholder : data.text}
        </p>
      )}
    </div>
  );
});

export interface FrameNodeData extends Record<string, unknown> {
  readonly name: string;
}

export type FrameNode = Node<FrameNodeData, 'frame'>;

/** A group: a light frame behind its blocks, moved by its header. */
export const FrameNodeView = memo(function FrameNodeView({ data, selected }: NodeProps<FrameNode>) {
  return (
    <div className={`frame${selected ? ' is-selected' : ''}`} data-testid="canvas-group">
      <div className="frame-header">
        <span className="truncate">{data.name}</span>
      </div>
    </div>
  );
});

export type CanvasNode = BlockNode | NoteNode | FrameNode;

export const nodeTypes = { block: BlockNodeView, note: NoteNodeView, frame: FrameNodeView };
