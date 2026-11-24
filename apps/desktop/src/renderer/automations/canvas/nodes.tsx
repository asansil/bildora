import { memo, use, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Handle,
  NodeResizeControl,
  NodeResizer,
  Position,
  useUpdateNodeInternals,
} from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { ChevronLeft, ChevronRight, Link2, TriangleAlert } from 'lucide-react';
import { BODY_OUTPUT, ERROR_OUTPUT, NOTE_TEXT_MAX } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { StepStateView, ToolView } from '../../../shared/ipc-contract.js';
import { RunStateIcon } from '../../shell/RunStateBadge.js';
import { BlockIcon, familyOf } from './BlockIcon.js';
import {
  CanvasActionsContext,
  InputTonesContext,
  LoopRoundsContext,
  PortHoverContext,
  PortLayoutsContext,
} from './canvas-actions.js';
import type { BlockKind } from './flow-document.js';
import type { HeaderPart } from './block-text.js';
import { LOOP_BODY_PORT_X, LOOP_BODY_PORT_Y, LOOP_EMPTY, LOOP_HEADER } from './loop-frames.js';
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

/** The rounds a loop has run, as its frame shows them in the run view. */
export interface LoopRoundsView {
  /** The round its blocks show, from 1. */
  readonly index: number;
  readonly count: number;
  /** How each round went, in order. */
  readonly results: readonly StepStateView[];
}

export interface LoopNodeData extends Record<string, unknown> {
  readonly kind: 'for' | 'while';
  readonly name: string;
  readonly kindLabel: string;
  /** What it repeats over, as a sentence whose values stand out, such as "Repeat ‹3› times". */
  readonly header?: readonly HeaderPart[];
  /** The same in plain text, for the tooltip. */
  readonly summary?: string;
  /** Whether its frame can be made bigger from its corner, which a run view cannot. */
  readonly resizable: boolean;
  readonly domId: string;
  readonly blockId: string;
  readonly description: string;
  readonly problems: number;
  readonly usedBy: number;
  readonly state?: StepStateView;
  readonly detail?: string;
  readonly rounds?: LoopRoundsView;
}

export type LoopNode = Node<LoopNodeData, 'loop'>;

/** Where a header's text is cut: in which part, and how many of its characters stay. */
interface HeaderCut {
  readonly part: number;
  readonly length: number;
}

let measuring: CanvasRenderingContext2D | null | undefined;

/** The width of a text in a font, as the canvas draws it. */
function textWidth(text: string, font: string): number {
  measuring ??= document.createElement('canvas').getContext('2d');
  if (measuring === null) return 0;
  measuring.font = font;
  return measuring.measureText(text).width;
}

/** The room an element takes beside its text: padding, border and margin. */
function chrome(style: CSSStyleDeclaration): number {
  return [
    style.paddingLeft,
    style.paddingRight,
    style.borderLeftWidth,
    style.borderRightWidth,
    style.marginLeft,
    style.marginRight,
  ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
}

/**
 * Where parts that do not fit in `room` are cut, so that the "…" ends the part it cuts, in that
 * part's own style. Undefined when everything fits.
 */
function headerCut(container: HTMLElement, parts: readonly HeaderPart[]): HeaderCut | undefined {
  const room = container.clientWidth;
  const children = [...container.children] as HTMLElement[];
  let used = 0;
  for (const [index, part] of parts.entries()) {
    const element = children[index];
    if (element === undefined) return undefined;
    const style = getComputedStyle(element);
    const font = style.font;
    const extra = chrome(style);
    const width = textWidth(part.text, font) + extra;
    if (used + width <= room + 0.5) {
      used += width;
      continue;
    }
    const left = room - used - extra - textWidth('…', font);
    let fits = 0;
    let high = part.text.length;
    while (fits < high) {
      const middle = Math.ceil((fits + high) / 2);
      if (textWidth(part.text.slice(0, middle), font) <= left) fits = middle;
      else high = middle - 1;
    }
    return { part: index, length: fits };
  }
  return undefined;
}

/**
 * What a loop goes through, its values as chips. When it does not fit, it is cut with "…" at the
 * end of the part it cuts, so the "…" is a chip's only when a chip is cut.
 */
function HeaderText({ parts }: { readonly parts: readonly HeaderPart[] }) {
  const box = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState<HeaderCut | undefined>(undefined);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  // Measured with every part drawn whole, then drawn cut.
  const [measured, setMeasured] = useState<{ parts: readonly HeaderPart[]; width: number }>();
  useLayoutEffect(() => {
    if (measured?.parts === parts && measured.width === width) return;
    const element = box.current;
    if (element === null) return;
    setCut(headerCut(element, parts));
    setMeasured({ parts, width });
  }, [parts, width, measured]);
  const shown = measured?.parts === parts && measured.width === width ? cut : undefined;
  return (
    <span className="loop-kind" data-testid="loop-header" ref={box}>
      {parts.flatMap((part, index) => {
        if (shown !== undefined && index > shown.part) return [];
        const text =
          shown?.part === index ? `${part.text.slice(0, shown.length).trimEnd()}…` : part.text;
        return [
          <span key={index} className={part.chip === true ? 'loop-chip' : 'loop-words'}>
            {text}
          </span>,
        ];
      })}
    </span>
  );
}

/** A selected frame grows from any of its corners. */
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

/** More rounds than this show only the selector, since a dot each would not fit. */
const ROUND_DOTS_MAX = 40;

/** "‹ Round 3 / 12 ›", with a dot per round that jumps to it. */
function RoundSelector({
  loop,
  rounds,
}: {
  readonly loop: string;
  readonly rounds: LoopRoundsView;
}) {
  const choose = use(LoopRoundsContext);
  const { index, count, results } = rounds;
  const pick = (round: number): void => {
    choose?.(loop, Math.min(Math.max(round, 1), count));
  };
  return (
    <span className="loop-rounds nodrag" data-testid="loop-rounds">
      <button
        type="button"
        className="loop-round-step"
        aria-label={t('canvas.roundPrevious')}
        title={t('canvas.roundPrevious')}
        disabled={index <= 1}
        onClick={(event) => {
          event.stopPropagation();
          pick(index - 1);
        }}
      >
        <ChevronLeft className="icon" aria-hidden="true" />
      </button>
      <span className="loop-round-text" data-testid="loop-round">
        {t('canvas.round', { index, count })}
      </span>
      <button
        type="button"
        className="loop-round-step"
        aria-label={t('canvas.roundNext')}
        title={t('canvas.roundNext')}
        disabled={index >= count}
        onClick={(event) => {
          event.stopPropagation();
          pick(index + 1);
        }}
      >
        <ChevronRight className="icon" aria-hidden="true" />
      </button>
      {count > ROUND_DOTS_MAX ? null : (
        <span className="loop-round-dots">
          {results.map((result, position) => {
            const label = t('canvas.roundDot', { index: position + 1, state: result });
            return (
              <button
                // Rounds never move, so their number names them.
                key={String(position + 1)}
                type="button"
                className={`loop-round-dot is-${result}${position + 1 === index ? ' is-current' : ''}`}
                aria-label={label}
                title={label}
                data-testid="loop-round-dot"
                data-state={result}
                onClick={(event) => {
                  event.stopPropagation();
                  pick(position + 1);
                }}
              />
            );
          })}
        </span>
      )}
    </span>
  );
}

const LOOP_OUTPUTS: readonly OutputView[] = [
  { id: 'next', label: '' },
  { id: ERROR_OUTPUT, label: '' },
];

/**
 * A loop: a frame around the blocks it repeats, moved by its header. Outside it has the input, Next
 * and Error like any block; inside its left edge, the body port starts the blocks it repeats.
 */
export const LoopNodeView = memo(function LoopNodeView({
  id,
  data,
  selected,
}: NodeProps<LoopNode>) {
  const layout = use(PortLayoutsContext).get(data.blockId);
  const tone = use(InputTonesContext).get(data.blockId);
  const portHover = use(PortHoverContext);
  const peer = portHover.peers.has(data.blockId);
  const key = layoutKey(layout);
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, key, updateNodeInternals]);
  const input = placeOf(layout, INPUT_PORT);
  const classes = [
    'loop',
    `block--${data.kind}`,
    'family-loop',
    selected ? 'is-selected' : '',
    peer ? 'is-port-peer' : '',
    data.state === undefined ? '' : `is-${data.state}`,
  ].join(' ');
  const title =
    portHover.owner === data.blockId
      ? undefined
      : [data.name, data.kindLabel, data.summary, data.detail].filter(Boolean).join('\n');
  return (
    <div
      id={data.domId}
      role="group"
      aria-label={data.description}
      className={classes}
      data-testid="canvas-loop"
      data-kind={data.kind}
      data-state={data.state}
    >
      {data.resizable && selected
        ? CORNERS.map((corner) => (
            <NodeResizeControl
              key={corner}
              position={corner}
              minWidth={LOOP_EMPTY.width}
              minHeight={LOOP_EMPTY.height}
              className="loop-corner nodrag"
            />
          ))
        : null}
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
      <div className="loop-header" title={title}>
        {data.state === undefined ? null : (
          <span className="block-state">
            <RunStateIcon state={data.state} />
          </span>
        )}
        <span className="block-tile" aria-hidden="true">
          <BlockIcon kind={data.kind} className="block-logo" />
        </span>
        <span className="loop-name truncate" data-testid="loop-name">
          {data.name}
        </span>
        {data.header === undefined ? (
          <span className="loop-kind truncate" data-testid="loop-header">
            {data.kindLabel}
          </span>
        ) : (
          <HeaderText parts={data.header} />
        )}
        {data.rounds === undefined ? null : (
          <RoundSelector loop={data.blockId} rounds={data.rounds} />
        )}
        {data.usedBy > 0 ? <UsedBy id={data.blockId} count={data.usedBy} /> : null}
        {data.problems > 0 ? (
          <span
            className="block-problem"
            title={t('canvas.blockProblems', { count: data.problems })}
          >
            <TriangleAlert className="icon" aria-hidden="true" />
          </span>
        ) : null}
      </div>
      {data.detail === undefined ? null : (
        <span className="loop-detail truncate">{data.detail}</span>
      )}
      <Handle
        id={BODY_OUTPUT}
        type="source"
        position={Position.Bottom}
        className="handle handle--out handle--body"
        style={{
          left: LOOP_BODY_PORT_X,
          top: LOOP_HEADER + LOOP_BODY_PORT_Y,
          bottom: 'auto',
          transform: 'translate(-50%, -50%)',
        }}
        aria-label={t('canvas.outputHandle', { output: t('canvas.outputBody') })}
        title=""
        data-output={BODY_OUTPUT}
        data-side="bottom"
      />
      <Outputs outputs={LOOP_OUTPUTS} labelled={false} layout={layout} />
    </div>
  );
});

export type CanvasNode = BlockNode | NoteNode | FrameNode | LoopNode;

export const nodeTypes = {
  block: BlockNodeView,
  note: NoteNodeView,
  frame: FrameNodeView,
  loop: LoopNodeView,
};
