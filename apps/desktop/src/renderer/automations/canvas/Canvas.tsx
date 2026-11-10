import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import {
  Background,
  ControlButton,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  PanOnScrollMode,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import type {
  Connection,
  Edge,
  EdgeChange,
  EdgeMarker,
  FinalConnectionState,
  HandleType,
  IsValidConnection,
  NodeChange,
  OnConnectStart,
  OnNodeDrag,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { CornerDownRight, Grid3x3 } from 'lucide-react';
import './canvas.css';
import { ERROR_OUTPUT, connectionOutput, outputsOf, validTargets } from '@bildora/protocol';
import type { AutomationConnection, AutomationGroup, AutomationPosition } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type {
  AutomationCanvasView,
  StepRunView,
  TakenPathView,
} from '../../../shared/ipc-contract.js';
import { kindLabel, outputLabel } from './block-text.js';
import {
  NOTE_SIZE,
  blockOf,
  clipCorner,
  connect,
  copyItems,
  disconnect,
  extractBlock,
  moveItems,
  pasteItems,
  removeItems,
  sizeOf,
  spliceEnds,
  spliceInto,
  updateNote,
} from './flow-document.js';
import type { ConnectionRef, FlowClip } from './flow-document.js';
import { ContextMenu } from '../../shell/ContextMenu.js';
import type { ContextMenuItem } from '../../shell/ContextMenu.js';
import { CanvasActionsContext, RightAnglesContext } from './canvas-actions.js';
import type { CanvasActions } from './canvas-actions.js';
import { edgeTypes } from './edges.js';
import { AddDialog, ConnectDialog } from './KeyboardDialogs.js';
import type { AddChoice, LibraryChoice } from './KeyboardDialogs.js';
import { describeBlock, domId, isDirection, nearestInDirection, neighbourOf } from './keyboard.js';
import type { FlowDocument, NewBlock } from './flow-document.js';
import { nodeTypes } from './nodes.js';
import type { BlockNodeData, CanvasNode } from './nodes.js';

/** From this many blocks on, only what is on screen is drawn, which keeps panning smooth. */
const CULL_FROM = 150;
/** A flow opens at a readable zoom on its Start block; a long one fitted to the screen is too small. */
const OPENING_ZOOM = 1;
/** Room a group's frame leaves around its blocks, and the height of its name. */
const FRAME_PADDING = 16;
const FRAME_HEADER = 28;
/** The background's grid, which blocks snap to when asked. */
const GRID = 16;
/** How far an arrow key moves a selected block. */
const NUDGE = GRID;
const NO_OPTIONS: AutomationCanvasView = {};
export const LIBRARY_DRAG_TYPE = 'application/x-bildora-block';
/** What Ctrl+C copied, kept outside any one canvas so it pastes into another automation too. */
let clipboard: FlowClip | undefined;

/** An arrowhead in a color of the theme, so a connection reads in the direction it runs. */
function arrow(color: string): EdgeMarker {
  return {
    type: MarkerType.ArrowClosed,
    color,
    width: 20,
    height: 20,
    markerUnits: 'userSpaceOnUse',
  };
}
const ARROW = arrow('var(--bildora-border-strong)');
const ARROW_TAKEN = arrow('var(--bildora-text)');
const ARROW_ERROR = arrow('var(--bildora-status-failed)');
const ARROW_SELECTED = arrow('var(--bildora-accent)');

type MenuAction = 'add' | 'connect' | 'write' | 'delete';

export interface CanvasRun {
  readonly steps: readonly StepRunView[];
  readonly paths: readonly TakenPathView[];
}

export interface CanvasProps {
  readonly document: FlowDocument;
  readonly names: ReadonlyMap<string, string>;
  /** Category logos by tool id. */
  readonly logos: ReadonlyMap<string, string>;
  readonly problemCounts: ReadonlyMap<string, number>;
  readonly selected: ReadonlySet<string>;
  /** False while the tab is hidden, when the canvas has no size to measure. */
  readonly active: boolean;
  /** Set in the run view, which shows block states and changes nothing. */
  readonly run?: CanvasRun;
  /**
   * Brings a block into view, such as the one a problem is about, or one just added. Changes each
   * time it is asked. `center` moves the view even when the block is already in sight.
   */
  readonly reveal?: { readonly id: string; readonly count: number; readonly center?: boolean };
  readonly onChange: (change: (document: FlowDocument) => FlowDocument, key?: string) => void;
  readonly onSelect: (ids: ReadonlySet<string>) => void;
  /**
   * Adds a block or a note where it was dropped, or where the canvas was right-clicked. A block
   * dropped onto a connection goes into it, through `into`.
   */
  readonly onAddAt: (choice: AddChoice, at: AutomationPosition, into?: ConnectionRef) => void;
  /** What A offers to add after the focused block. */
  readonly library: readonly LibraryChoice[];
  /** In the run view, a double-click on a block goes back to editing it. */
  readonly onOpenBlock?: (id: string) => void;
  /** Adds a block after another, and gives the new block's id. */
  readonly onAddAfter: (anchor: string, choice: NewBlock) => string | undefined;
  /** Moves keyboard focus to a block, as the blocks list asks. Changes each time it is asked. */
  readonly focusRequest?: { readonly id: string; readonly count: number };
  /** Snap to grid and right-angle connections, shared by every automation tab. */
  readonly options?: AutomationCanvasView;
  readonly onOptions?: (options: AutomationCanvasView) => void;
  readonly children?: ReactNode;
}

function edgeId(from: string, output: string, to: string): string {
  return `${from}\u0000${output}\u0000${to}`;
}

/** How many frames a block held still over the canvas looks again for a connection under it. */
const RETRY_FRAMES = 10;

function connectionOf(id: string): ConnectionRef {
  const [from = '', output = '', to = ''] = id.split('\u0000');
  return { from, output, to };
}

/** The connection drawn under a point of the screen, if any, whatever lies above it. */
function edgeUnder(
  x: number,
  y: number,
  within: HTMLElement | null,
  allowed: (id: string) => boolean = () => true,
): string | undefined {
  for (const element of window.document.elementsFromPoint(x, y)) {
    const edge = element.closest('.react-flow__edge');
    const id = edge?.getAttribute('data-id');
    if (id === null || id === undefined || within?.contains(edge ?? null) !== true) continue;
    if (allowed(id)) return id;
  }
  return undefined;
}

/** The block drawn under a point of the screen, if any. */
function blockUnder(x: number, y: number, within: HTMLElement | null): string | undefined {
  for (const element of window.document.elementsFromPoint(x, y)) {
    const node = element.closest('.react-flow__node-block');
    const id = node?.getAttribute('data-id');
    if (id !== null && id !== undefined && within?.contains(node ?? null) === true) return id;
  }
  return undefined;
}

/** True when a key goes to a text field, which keeps its own keys. */
function isTyping(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
  );
}

/** Where a pointer or touch event happened on the screen. */
function pointOf(event: MouseEvent | TouchEvent): { x: number; y: number } | undefined {
  const point = 'changedTouches' in event ? event.changedTouches[0] : event;
  return point === undefined ? undefined : { x: point.clientX, y: point.clientY };
}

/** What a Shift drag of a block works on: the flow with the block already taken out of it. */
interface Extraction {
  readonly document: FlowDocument;
  readonly node: string;
  /** The flow without the block. */
  readonly base: FlowDocument;
}

/** The connections drawn while a block is Shift-dragged: the flow as it would be if let go now. */
interface Preview {
  readonly key: string;
  readonly connections: readonly AutomationConnection[];
  /** The connections the block would be joined by, by edge id. */
  readonly pending: ReadonlySet<string>;
  /** The connection it would go into, still drawn faintly so the pointer can stay on it. */
  readonly replaced?: string;
}

function stepDetail(step: StepRunView | undefined): string | undefined {
  if (step === undefined) return undefined;
  if (step.failure !== undefined) return step.failure.message;
  if (step.state === 'skipped') return t('automation.skipped');
  if (step.state === 'running' && step.message !== undefined) return t('automation.waitingForYou');
  if (step.resumesAt !== undefined) {
    return t('automation.resumesAt', { time: new Date(step.resumesAt).toLocaleTimeString('en') });
  }
  if (step.state === 'running' && step.attempt !== undefined && step.attempt > 1) {
    return t('automation.attempt', { number: step.attempt });
  }
  if (step.progress?.message !== undefined) return step.progress.message;
  return step.progress?.percent === undefined ? undefined : `${String(step.progress.percent)}%`;
}

function marked(
  nodes: readonly CanvasNode[],
  selected: ReadonlySet<string>,
  targets: ReadonlySet<string> | undefined,
  focused: string | undefined,
): CanvasNode[] {
  return nodes.map((node): CanvasNode => {
    const isSelected = selected.has(node.id);
    const className = [
      // Shift on the empty canvas draws a selection box, but on a block it drags the block in or
      // out of the flow. xyflow starts no box from an element marked `nokey`.
      node.type === 'block' ? 'nokey' : '',
      targets?.has(node.id) === true ? 'is-target' : '',
      focused === node.id ? 'is-focused' : '',
    ]
      .join(' ')
      .trim();
    if (node.selected === isSelected && (node.className ?? '') === className) return node;
    return { ...node, selected: isSelected, className };
  });
}

/** Fresh nodes, keeping where a block being dragged now is. */
function stillDragged(built: readonly CanvasNode[], current: readonly CanvasNode[]): CanvasNode[] {
  const dragged = new Map(
    current.filter(({ dragging }) => dragging === true).map((node) => [node.id, node]),
  );
  if (dragged.size === 0) return [...built];
  return built.map((node) => {
    const moving = dragged.get(node.id);
    return moving === undefined ? node : { ...node, position: moving.position, dragging: true };
  });
}

/** Each group's frame around its blocks, wherever those blocks are now, dragged ones included. */
function framed(nodes: readonly CanvasNode[], groups: readonly AutomationGroup[]): CanvasNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node): CanvasNode => {
    if (node.type !== 'frame') return node;
    const members = (groups.find(({ id }) => id === node.id)?.blocks ?? []).flatMap((id) => {
      const member = byId.get(id);
      return member === undefined ? [] : [member];
    });
    if (members.length === 0) return node;
    const left = Math.min(...members.map(({ position }) => position.x));
    const top = Math.min(...members.map(({ position }) => position.y));
    const right = Math.max(...members.map(({ position, width }) => position.x + (width ?? 0)));
    const bottom = Math.max(...members.map(({ position, height }) => position.y + (height ?? 0)));
    const position = { x: left - FRAME_PADDING, y: top - FRAME_PADDING - FRAME_HEADER };
    const width = right - left + FRAME_PADDING * 2;
    const height = bottom - top + FRAME_PADDING * 2 + FRAME_HEADER;
    if (
      node.position.x === position.x &&
      node.position.y === position.y &&
      node.width === width &&
      node.height === height
    ) {
      return node;
    }
    return { ...node, position, width, height };
  });
}

/**
 * The flow as blocks and connections. What it shows comes from the document, which changes only
 * through `onChange`; a drag moves blocks here and reaches the document when it ends.
 */
export function Canvas({
  document,
  names,
  logos,
  problemCounts,
  selected,
  active,
  run,
  reveal,
  onChange,
  onSelect,
  onAddAt,
  library,
  onOpenBlock,
  onAddAfter,
  focusRequest,
  options = NO_OPTIONS,
  onOptions,
  children,
}: CanvasProps) {
  const prefix = useId();
  const [focused, setFocused] = useState<string | undefined>(undefined);
  /** After Enter, arrow keys move the focused block instead of moving between blocks. */
  const [moving, setMoving] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'add' | 'connect'; id: string } | undefined>(
    undefined,
  );
  const [announcement, setAnnouncement] = useState('');
  /** The note being written on the canvas. */
  const [editingNote, setEditingNote] = useState<string | undefined>(undefined);
  /** A block's or a note's menu, open at the pointer. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | undefined>(undefined);
  /** Where a right-click on the empty canvas asked to add something. */
  const [addAt, setAddAt] = useState<AutomationPosition | undefined>(undefined);
  const flow = useReactFlow<CanvasNode>();
  const readOnly = run !== undefined;
  const snapToGrid = options.snapToGrid === true && !readOnly;
  const rightAngles = options.rightAngles === true;
  /** A point on the canvas, on the grid when blocks snap to it. */
  const placed = (at: AutomationPosition): AutomationPosition =>
    snapToGrid ? { x: Math.round(at.x / GRID) * GRID, y: Math.round(at.y / GRID) * GRID } : at;
  const [targets, setTargets] = useState<ReadonlySet<string> | undefined>(undefined);
  /** The connection a dragged block would go into if it were dropped now. */
  const [spliceEdge, setSpliceEdge] = useState<string | undefined>(undefined);
  /** While a block is Shift-dragged, the connections as they would be if it were let go now. */
  const [preview, setPreview] = useState<Preview | undefined>(undefined);
  /**
   * While Shift is held on a dragged block: which block, and the connection it would go into,
   * with the answer for the last connection checked. Read when the drag ends.
   */
  const splice = useRef<{ node: string; edge: string | undefined; fits: boolean } | undefined>(
    undefined,
  );
  const extraction = useRef<Extraction | undefined>(undefined);
  /** The connection whose end is being dragged to another block, and whether it found one. */
  const reconnecting = useRef<{ edge: Edge; done: boolean } | undefined>(undefined);
  /** Where the pointer last was over the canvas, for what Shift+Space adds. */
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const opened = useRef(false);
  const container = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    const states = new Map(run?.steps.map((step) => [step.id, step]));
    return new Map(
      document.blocks.map((block): [string, BlockNodeData] => {
        const step = states.get(block.id);
        const logo = block.type === 'run' ? logos.get(block.tool) : undefined;
        const detail = stepDetail(step);
        return [
          block.id,
          {
            kind: block.type,
            name: names.get(block.id) ?? block.id,
            // Start's name already says what it is, so its second line says when it runs.
            kindLabel: block.type === 'start' ? t('canvas.startKind') : kindLabel(block.type),
            outputs: outputsOf(block).map((id) => ({ id, label: outputLabel(id) })),
            domId: domId(prefix, block.id),
            description: describeBlock(document, block.id, (id) => names.get(id) ?? id),
            problems: readOnly ? 0 : (problemCounts.get(block.id) ?? 0),
            ...(logo === undefined ? {} : { logo }),
            ...(run === undefined ? {} : { state: step?.state ?? 'idle' }),
            ...(detail === undefined ? {} : { detail }),
          },
        ];
      }),
    );
    // `document` stands for its blocks and connections here; positions are left out on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.blocks, document.connections, names, logos, problemCounts, run, readOnly, prefix]);

  const built = useMemo(() => {
    // Frames first, so they sit behind the blocks they hold.
    const frames = document.groups.map((group): CanvasNode => ({
      id: group.id,
      type: 'frame',
      position: { x: 0, y: 0 },
      data: { name: group.name },
      dragHandle: '.frame-header',
      zIndex: -1,
      deletable: !readOnly,
    }));
    const blocks = document.blocks.map((block): CanvasNode => {
      const size = sizeOf(block);
      const position = document.positions[block.id];
      return {
        id: block.id,
        type: 'block',
        position: position ?? { x: 0, y: 0 },
        // A block waiting to be laid out would show piled up on the others until it is.
        hidden: position === undefined,
        width: size.width,
        height: size.height,
        data: data.get(block.id) as BlockNodeData,
        deletable: block.type !== 'start' && !readOnly,
      };
    });
    const notes = document.notes.map((note): CanvasNode => ({
      id: note.id,
      type: 'note',
      position: { x: note.x, y: note.y },
      width: note.width ?? NOTE_SIZE.width,
      height: note.height ?? NOTE_SIZE.height,
      data: { text: note.text, placeholder: t('canvas.notePlaceholder'), readOnly },
      deletable: !readOnly,
    }));
    return framed([...frames, ...blocks, ...notes], document.groups);
  }, [document.blocks, document.positions, document.notes, document.groups, data, readOnly]);
  // Blocks move here while dragged, and start again from the document whenever it changes, but
  // for a block still being dragged, which a check finishing meanwhile must not snap back.
  // Selection and the targets of a connection being drawn only mark the blocks as they are.
  const [nodes, setNodes] = useState<CanvasNode[]>(() => marked(built, selected, targets, focused));
  const [from, setFrom] = useState({ built, selected, targets, focused });
  if (
    from.built !== built ||
    from.selected !== selected ||
    from.targets !== targets ||
    from.focused !== focused
  ) {
    setFrom({ built, selected, targets, focused });
    setNodes(
      marked(from.built === built ? nodes : stillDragged(built, nodes), selected, targets, focused),
    );
  }

  const taken = useMemo(
    () => new Set(run?.paths.map(({ from, output, to }) => edgeId(from, output, to))),
    [run],
  );
  const edgesFor = useCallback(
    (connections: readonly AutomationConnection[]) =>
      connections.map((connection): Edge => {
        const output = connectionOutput(connection);
        const id = edgeId(connection.from, output, connection.to);
        const classes = [
          output === ERROR_OUTPUT ? 'edge--error' : '',
          taken.has(id) ? 'edge--taken' : '',
        ].join(' ');
        return {
          id,
          type: 'flow',
          markerEnd: taken.has(id) ? ARROW_TAKEN : output === ERROR_OUTPUT ? ARROW_ERROR : ARROW,
          source: connection.from,
          sourceHandle: output,
          target: connection.to,
          targetHandle: 'in',
          className: classes.trim(),
          deletable: !readOnly,
          ariaLabel: t('canvas.connectionLabel', {
            from: names.get(connection.from) ?? connection.from,
            output: outputLabel(output),
            to: names.get(connection.to) ?? connection.to,
          }),
        };
      }),
    [names, taken, readOnly],
  );
  const builtEdges = useMemo(
    () => edgesFor(document.connections),
    [edgesFor, document.connections],
  );
  const [edges, setEdges] = useState<Edge[]>(builtEdges);
  const [edgesFrom, setEdgesFrom] = useState(builtEdges);
  if (edgesFrom !== builtEdges) {
    setEdgesFrom(builtEdges);
    setEdges(builtEdges);
  }

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      let next = applyNodeChanges(changes, nodes);
      // Dragging a frame by its name moves the blocks it holds.
      for (const change of changes) {
        if (change.type !== 'position' || change.position === undefined) continue;
        const before = nodes.find(({ id }) => id === change.id);
        const group = document.groups.find(({ id }) => id === change.id);
        if (before === undefined || group === undefined) continue;
        const dx = change.position.x - before.position.x;
        const dy = change.position.y - before.position.y;
        next = next.map((node) =>
          group.blocks.includes(node.id)
            ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }
            : node,
        );
      }
      next = framed(next, document.groups);
      setNodes(next);

      // A drag or a resize reaches the document once it ends.
      const moved: Record<string, AutomationPosition> = {};
      const resized: { id: string; width: number; height: number }[] = [];
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false) {
          const group = document.groups.find(({ id }) => id === change.id);
          for (const id of group?.blocks ?? [change.id]) {
            const node = next.find((item) => item.id === id);
            if (node !== undefined && node.type !== 'frame') moved[id] = node.position;
          }
        }
        if (change.type === 'dimensions' && change.resizing === false && change.dimensions) {
          resized.push({ id: change.id, ...change.dimensions });
        }
      }
      // With Shift, a block comes out of the flow, and goes into the connection it was let go
      // over, as part of the same move.
      const shifted =
        splice.current !== undefined && moved[splice.current.node] !== undefined
          ? splice.current
          : undefined;
      if (Object.keys(moved).length > 0 || resized.length > 0) {
        onChange((current) => {
          let updated = moveItems(current, moved);
          if (shifted !== undefined) {
            updated = extractBlock(updated, shifted.node);
            const ends = spliceEnds(updated, shifted.node);
            if (shifted.edge !== undefined && shifted.fits && ends !== undefined) {
              const into = connectionOf(shifted.edge);
              updated = spliceInto(updated, into, ends.first, ends.tail) ?? updated;
            }
          }
          for (const { id, width, height } of resized) {
            const note = updated.notes.find((item) => item.id === id);
            const node = next.find((item) => item.id === id);
            if (note === undefined || node === undefined) continue;
            updated = updateNote(updated, {
              ...note,
              x: node.position.x,
              y: node.position.y,
              width: Math.round(width),
              height: Math.round(height),
            });
          }
          return updated;
        });
      }
      if (changes.some((change) => change.type === 'select')) {
        const chosen = new Set(selected);
        for (const change of changes) {
          if (change.type !== 'select') continue;
          if (change.selected) chosen.add(change.id);
          else chosen.delete(change.id);
        }
        onSelect(chosen);
      }
    },
    [nodes, document.groups, onChange, onSelect, selected],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);
  // A selected connection's arrowhead takes the selection color with its line, as does the one a
  // block from the library would go into. While a block is Shift-dragged, the flow is drawn as it
  // would be if the block were let go now, with the connections that would join it in the accent.
  const drawnEdges = useMemo(() => {
    const marked = (edge: Edge, mark: string, arrow?: EdgeMarker): Edge => ({
      ...edge,
      ...(arrow === undefined ? {} : { markerEnd: arrow }),
      className: `${edge.className ?? ''} ${mark}`.trim(),
    });
    if (preview !== undefined) {
      return edgesFor(preview.connections).map((edge) =>
        preview.pending.has(edge.id)
          ? marked(edge, 'edge--pending', ARROW_SELECTED)
          : edge.id === preview.replaced
            ? marked(edge, 'edge--replaced')
            : edge,
      );
    }
    return edges.map((edge) =>
      edge.id === spliceEdge
        ? marked(edge, 'edge--splice', ARROW_SELECTED)
        : edge.selected === true
          ? { ...edge, markerEnd: ARROW_SELECTED }
          : edge,
    );
  }, [edges, spliceEdge, preview, edgesFor]);

  /** The flow without a block, worked out once per drag. */
  const extractionOf = useCallback(
    (id: string): Extraction => {
      const known = extraction.current;
      if (known?.document === document && known.node === id) return known;
      extraction.current = { document, node: id, base: extractBlock(document, id) };
      return extraction.current;
    },
    [document],
  );

  /**
   * With Shift held, a dragged block comes out of the flow, and the connection under the pointer
   * is offered when the block can go into it. Without Shift, a drag only moves.
   */
  const follow = useCallback(
    (nodeId: string, x: number, y: number): boolean => {
      const { base } = extractionOf(nodeId);
      const ends = spliceEnds(base, nodeId);
      if (ends === undefined) {
        splice.current = undefined;
        setPreview(undefined);
        return true;
      }
      // The connections that would join the block are drawn at it, so they are never a target.
      const edge = edgeUnder(x, y, container.current, (id) => {
        const { from, to } = connectionOf(id);
        return ![from, to].some((end) => end === ends.first || end === ends.tail);
      });
      if (edge === undefined) {
        splice.current = { node: nodeId, edge: undefined, fits: false };
      } else if (splice.current?.edge !== edge || splice.current.node !== nodeId) {
        const fits = spliceInto(base, connectionOf(edge), ends.first, ends.tail) !== undefined;
        splice.current = { node: nodeId, edge, fits };
      }
      const into = splice.current.fits ? splice.current.edge : undefined;
      const key = `${nodeId}\u0000${into ?? ''}`;
      if (preview?.key === key) return edge !== undefined;
      const spliced =
        into === undefined
          ? undefined
          : spliceInto(base, connectionOf(into), ends.first, ends.tail);
      if (spliced === undefined || into === undefined) {
        // A block on its own changes nothing until it is over a connection it fits.
        setPreview(
          base === document
            ? undefined
            : { key, connections: base.connections, pending: new Set<string>() },
        );
        return edge !== undefined;
      }
      const joined = spliced.connections.filter((item) => !base.connections.includes(item));
      const replaced = base.connections.find(
        (item) => edgeId(item.from, connectionOutput(item), item.to) === into,
      );
      setPreview({
        key,
        connections:
          replaced === undefined ? spliced.connections : [...spliced.connections, replaced],
        pending: new Set(joined.map((item) => edgeId(item.from, connectionOutput(item), item.to))),
        replaced: into,
      });
      return true;
    },
    [extractionOf, document, preview],
  );
  const followNow = useRef(follow);
  useEffect(() => {
    followNow.current = follow;
  }, [follow]);
  /** A further look for the connection under a block held still, while one is drawn again. */
  const retry = useRef(0);

  const onNodeDrag: OnNodeDrag<CanvasNode> = useCallback(
    (event, node, dragged) => {
      cancelAnimationFrame(retry.current);
      const point = 'touches' in event ? event.touches[0] : event;
      if (!event.shiftKey || node.type !== 'block' || dragged.length !== 1 || point === undefined) {
        splice.current = undefined;
        setPreview(undefined);
        return;
      }
      const { clientX: x, clientY: y } = point;
      if (follow(node.id, x, y)) return;
      // A connection being drawn again is missing for a frame or two, so a block let go right
      // then would miss it. The next frames look again, with the pointer where it was.
      let tries = 0;
      const again = (): void => {
        tries += 1;
        if (followNow.current(node.id, x, y) || tries >= RETRY_FRAMES) return;
        retry.current = requestAnimationFrame(again);
      };
      retry.current = requestAnimationFrame(again);
    },
    [follow],
  );

  const onNodeDragStop = useCallback(() => {
    cancelAnimationFrame(retry.current);
    splice.current = undefined;
    extraction.current = undefined;
    setPreview(undefined);
  }, []);

  const announce = useCallback((message: string) => {
    // Clearing first makes the same message speak again.
    setAnnouncement('');
    requestAnimationFrame(() => {
      setAnnouncement(message);
    });
  }, []);

  const nameOf = useCallback((id: string) => names.get(id) ?? id, [names]);

  /**
   * Deletes what is selected, or else the focused block, and keeps focus on the canvas. A selected
   * connection counts as a choice, so Delete then never falls back to the focused block.
   */
  function deleteChosen(): void {
    const ids = new Set(selected);
    const cut = new Set(edges.filter((edge) => edge.selected === true).map(({ id }) => id));
    if (ids.size === 0 && cut.size === 0 && focused !== undefined) ids.add(focused);
    deleteItems(ids, cut);
  }

  /** Deletes blocks, notes and groups by id, and connections by edge id. */
  function deleteItems(ids: ReadonlySet<string>, cut: ReadonlySet<string>): void {
    if (ids.size === 0 && cut.size === 0) return;
    const kept = removeItems(document, ids);
    const after = {
      ...kept,
      connections: kept.connections.filter(
        (connection) =>
          !cut.has(edgeId(connection.from, connectionOutput(connection), connection.to)),
      ),
    };
    if (
      after.blocks.length === document.blocks.length &&
      cut.size === 0 &&
      after.notes.length === document.notes.length &&
      after.groups.length === document.groups.length
    ) {
      announce(t('canvas.startStays'));
      return;
    }
    onChange(() => after);
    onSelect(new Set());
    const gone = [...ids].filter((id) => blockOf(after, id) === undefined && blockOf(document, id));
    if (focused !== undefined && gone.includes(focused)) {
      const next = neighbourOf(document, after, focused);
      setFocused(next);
      setMoving(false);
      if (next !== undefined) reveal_(next);
    }
    announce(
      gone.length > 0
        ? t('canvas.deleted', { names: gone.map(nameOf).join(', ') })
        : t('canvas.deletedConnections', { count: cut.size }),
    );
  }

  const deleteConnection = useCallback(
    (id: string) => {
      if (readOnly) return;
      onChange((current) => ({
        ...current,
        connections: current.connections.filter(
          (connection) =>
            edgeId(connection.from, connectionOutput(connection), connection.to) !== id,
        ),
      }));
      announce(t('canvas.deletedConnections', { count: 1 }));
    },
    [readOnly, onChange, announce],
  );

  const finishNote = useCallback(
    (id: string, text: string | undefined) => {
      setEditingNote(undefined);
      if (text === undefined) return;
      onChange((current) => {
        const note = current.notes.find((item) => item.id === id);
        return note === undefined || note.text === text
          ? current
          : updateNote(current, { ...note, text });
      }, `note:${id}`);
    },
    [onChange],
  );

  const actions = useMemo(
    (): CanvasActions | undefined => (readOnly ? undefined : { editingNote, finishNote }),
    [readOnly, editingNote, finishNote],
  );

  /** Opens a block's or a note's menu, chosen first so the menu acts on what it shows. */
  function openMenu(id: string, x: number, y: number): void {
    onSelect(new Set([id]));
    if (blockOf(document, id) !== undefined) setFocused(id);
    setMoving(false);
    setMenu({ id, x, y });
  }

  function menuItems(id: string): ContextMenuItem<MenuAction>[] {
    const block = blockOf(document, id);
    if (block === undefined) {
      const note = document.notes.some((item) => item.id === id);
      return [
        ...(note ? [{ action: 'write' as const, label: t('canvas.menuWrite') }] : []),
        { action: 'delete', label: t('canvas.menuDelete'), danger: true },
      ];
    }
    return [
      { action: 'add', label: t('canvas.menuAdd') },
      ...(outputsOf(block).length > 0
        ? [{ action: 'connect' as const, label: t('canvas.menuConnect') }]
        : []),
      ...(block.type === 'start'
        ? []
        : [{ action: 'delete' as const, label: t('canvas.menuDelete'), danger: true }]),
    ];
  }

  function onMenu(action: MenuAction): void {
    if (menu === undefined) return;
    const { id } = menu;
    setMenu(undefined);
    container.current?.focus();
    switch (action) {
      case 'add':
        setDialog({ kind: 'add', id });
        return;
      case 'connect':
        setDialog({ kind: 'connect', id });
        return;
      case 'write':
        setEditingNote(id);
        return;
      case 'delete':
        deleteItems(new Set([id]), new Set());
        return;
    }
  }

  /** The flow as it is, or without the connection whose end is being dragged elsewhere. */
  const withoutMoving = useCallback((): FlowDocument => {
    const moving = reconnecting.current?.edge;
    if (moving === undefined) return document;
    const { from, output, to } = connectionOf(moving.id);
    return disconnect(document, from, output, to);
  }, [document]);

  const onConnectStart: OnConnectStart = useCallback(
    (_event, { nodeId, handleId, handleType }) => {
      if (nodeId === null || handleType !== 'source' || handleId === null) return;
      setTargets(new Set(validTargets(withoutMoving(), nodeId, handleId)));
    },
    [withoutMoving],
  );

  /** A connection let go on a block's body, not its input, joins that block all the same. */
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      setTargets(undefined);
      if (reconnecting.current !== undefined || state.isValid === true) return;
      const from = state.fromNode?.id;
      const output = state.fromHandle?.id;
      const point = pointOf(event);
      if (state.fromHandle?.type !== 'source' || from === undefined || !output || !point) return;
      const to = blockUnder(point.x, point.y, container.current);
      if (to === undefined || !validTargets(document, from, output).includes(to)) return;
      onChange((current) => connect(current, from, output, to));
    },
    [document, onChange],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      const output = connection.sourceHandle ?? 'next';
      return (
        targets?.has(connection.target) ??
        validTargets(withoutMoving(), connection.source, output).includes(connection.target)
      );
    },
    [targets, withoutMoving],
  );

  // Either end of a connection can be dragged to another block. Let go on nothing, it is removed.
  const onReconnectStart = useCallback((_event: unknown, edge: Edge) => {
    reconnecting.current = { edge, done: false };
  }, []);

  const onReconnect = useCallback(
    (old: Edge, next: Connection) => {
      if (reconnecting.current !== undefined) reconnecting.current.done = true;
      const before = connectionOf(old.id);
      const output = next.sourceHandle ?? 'next';
      onChange((current) =>
        connect(
          disconnect(current, before.from, before.output, before.to),
          next.source,
          output,
          next.target,
        ),
      );
    },
    [onChange],
  );

  const onReconnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, edge: Edge, fixed: HandleType) => {
      const done = reconnecting.current?.done === true;
      reconnecting.current = undefined;
      setTargets(undefined);
      if (done) return;
      const { from, output, to } = connectionOf(edge.id);
      const point = pointOf(event);
      const over =
        point === undefined ? undefined : blockUnder(point.x, point.y, container.current);
      const without = disconnect(document, from, output, to);
      // On a block's body: the input end goes to that block, the output end leaves through its Next.
      const moved =
        over === undefined
          ? undefined
          : fixed === 'source'
            ? validTargets(without, from, output).includes(over)
              ? connect(without, from, output, over)
              : undefined
            : validTargets(without, over, 'next').includes(to)
              ? connect(without, over, 'next', to)
              : undefined;
      onChange(() => moved ?? without);
      if (moved === undefined) announce(t('canvas.deletedConnections', { count: 1 }));
    },
    [document, onChange, announce],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const output = connection.sourceHandle ?? 'next';
      onChange((current) => connect(current, connection.source, output, connection.target));
    },
    [onChange],
  );

  // Where a flow opens: its Start block at a readable size, once the tab can be measured.
  useEffect(() => {
    if (!active || opened.current) return undefined;
    const frame = requestAnimationFrame(() => {
      const start = document.blocks.find(({ type }) => type === 'start');
      const at = start === undefined ? undefined : document.positions[start.id];
      if (start === undefined || at === undefined) return;
      const bounds = flow.getNodesBounds([start.id]);
      const width = container.current?.getBoundingClientRect().width ?? 0;
      if (width === 0) return;
      opened.current = true;
      // Start sits a little in from the left edge, so the flow reads on from there.
      const offset = Math.max(0, width / 2 - 96) / OPENING_ZOOM;
      void flow.setCenter(bounds.x + offset, bounds.y + bounds.height / 2, { zoom: OPENING_ZOOM });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active, document.blocks, document.positions, flow]);

  /** Brings a block into sight, moving the view only when it is not already there. */
  const reveal_ = useCallback(
    (id: string, center = false) => {
      requestAnimationFrame(() => {
        const bounds = flow.getNodesBounds([id]);
        const area = container.current?.getBoundingClientRect();
        if (area === undefined || bounds.width === 0) return;
        const corner = flow.screenToFlowPosition({ x: area.left, y: area.top });
        const far = flow.screenToFlowPosition({ x: area.right, y: area.bottom });
        const inSight =
          bounds.x >= corner.x &&
          bounds.y >= corner.y &&
          bounds.x + bounds.width <= far.x &&
          bounds.y + bounds.height <= far.y;
        if (inSight && !center) return;
        void flow.setCenter(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
          zoom: Math.max(flow.getZoom(), 0.75),
        });
      });
    },
    [flow],
  );

  // The blocks list moves focus here, onto the block it names.
  const [focusAsked, setFocusAsked] = useState(focusRequest);
  if (focusAsked !== focusRequest) {
    setFocusAsked(focusRequest);
    if (focusRequest !== undefined) {
      setFocused(focusRequest.id);
      setMoving(false);
    }
  }
  useEffect(() => {
    if (focusRequest === undefined) return;
    container.current?.focus();
    reveal_(focusRequest.id, true);
  }, [focusRequest, reveal_]);

  /** Copies what is selected, or else the focused block. */
  function copyChosen(): void {
    const ids = selected.size > 0 ? selected : new Set(focused === undefined ? [] : [focused]);
    const clip = copyItems(document, ids);
    if (clip === undefined) return;
    clipboard = clip;
    announce(t('canvas.copied', { count: clip.blocks.length + clip.notes.length }));
  }

  /**
   * Pastes what was copied where the pointer is, or a grid step past the original when the pointer
   * is off the canvas, and selects the copy.
   */
  function pasteClip(): void {
    if (clipboard === undefined) return;
    const corner = clipCorner(clipboard);
    const at =
      pointer.current === undefined
        ? { x: corner.x + NUDGE, y: corner.y + NUDGE }
        : flow.screenToFlowPosition(pointer.current);
    const pasted = pasteItems(document, clipboard, placed(at));
    if (pasted === undefined) {
      announce(t('canvas.pasteTooMany'));
      return;
    }
    onChange(() => pasted.document);
    onSelect(new Set(pasted.ids));
    announce(t('canvas.pasted', { count: pasted.ids.length }));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.metaKey || isTyping(event.target)) return;
    // These also come from the frame around selected blocks, which takes focus after a selection
    // box, so they are not limited to the canvas itself.
    if (event.ctrlKey) {
      const letter = event.key.toLowerCase();
      if (event.shiftKey || (letter !== 'c' && letter !== 'v')) return;
      event.preventDefault();
      if (letter === 'c') copyChosen();
      else if (!readOnly) pasteClip();
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !readOnly) {
      event.preventDefault();
      deleteChosen();
      return;
    }
    if (event.target !== container.current) return;
    // Shift+Space asks what to add, where the pointer is.
    if (event.shiftKey && event.key === ' ' && !readOnly) {
      event.preventDefault();
      const area = container.current.getBoundingClientRect();
      const at = pointer.current ?? {
        x: area.left + area.width / 2,
        y: area.top + area.height / 2,
      };
      setAddAt(placed(flow.screenToFlowPosition(at)));
      return;
    }
    const key = event.key;
    const current =
      focused !== undefined && blockOf(document, focused) !== undefined ? focused : undefined;
    if (isDirection(key)) {
      event.preventDefault();
      if (current === undefined) {
        const start = document.blocks.find(({ type }) => type === 'start');
        if (start !== undefined) {
          setFocused(start.id);
          reveal_(start.id);
        }
        return;
      }
      if (moving && !readOnly) {
        const step = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        }[key];
        // From where the block is in the document now, so keys pressed faster than the canvas
        // draws each add their step.
        onChange((flowDocument) => {
          const at = flowDocument.positions[current];
          if (at === undefined) return flowDocument;
          return moveItems(flowDocument, {
            [current]: { x: at.x + (step[0] ?? 0) * NUDGE, y: at.y + (step[1] ?? 0) * NUDGE },
          });
        }, `move:${current}`);
        return;
      }
      const next = nearestInDirection(document, current, key);
      if (next !== undefined) {
        setFocused(next);
        reveal_(next);
      }
      return;
    }
    if (key === 'Enter' && current !== undefined) {
      event.preventDefault();
      onSelect(new Set([current]));
      if (!readOnly) {
        setMoving(true);
        announce(t('canvas.moveHint', { name: nameOf(current) }));
      }
      return;
    }
    if (key === 'Escape' && moving) {
      event.preventDefault();
      setMoving(false);
      announce(t('canvas.moveDone', { name: current === undefined ? '' : nameOf(current) }));
      return;
    }
    if (readOnly) return;
    if ((key === 'ContextMenu' || (event.shiftKey && key === 'F10')) && current !== undefined) {
      event.preventDefault();
      const box = window.document.getElementById(domId(prefix, current))?.getBoundingClientRect();
      if (box !== undefined) openMenu(current, box.left, box.bottom);
      return;
    }
    if ((key === 'a' || key === 'A') && current !== undefined) {
      event.preventDefault();
      setDialog({ kind: 'add', id: current });
      return;
    }
    if ((key === 'c' || key === 'C') && current !== undefined) {
      event.preventDefault();
      setDialog({ kind: 'connect', id: current });
      return;
    }
  }

  useEffect(() => {
    if (reveal !== undefined) reveal_(reveal.id, reveal.center === true);
  }, [reveal, reveal_]);

  function dragOver(event: DragEvent): void {
    if (readOnly || !event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    // With Shift, a new block goes into the connection it is let go over. What is dragged cannot
    // be read until the drop, so any connection under it is offered.
    setSpliceEdge(
      event.shiftKey ? edgeUnder(event.clientX, event.clientY, container.current) : undefined,
    );
  }

  function dragLeave(event: DragEvent): void {
    if (!(
      event.relatedTarget instanceof Node && container.current?.contains(event.relatedTarget)
    )) {
      setSpliceEdge(undefined);
    }
  }

  function drop(event: DragEvent): void {
    const text = event.dataTransfer.getData(LIBRARY_DRAG_TYPE);
    const edge = event.shiftKey
      ? edgeUnder(event.clientX, event.clientY, container.current)
      : undefined;
    setSpliceEdge(undefined);
    if (readOnly || text === '') return;
    event.preventDefault();
    const choice = JSON.parse(text) as AddChoice;
    const at = placed(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    if (edge === undefined) onAddAt(choice, at);
    else onAddAt(choice, at, connectionOf(edge));
  }

  const focusedNode = focused === undefined ? undefined : data.get(focused);
  const dialogBlock = dialog === undefined ? undefined : blockOf(document, dialog.id);

  return (
    <div
      ref={container}
      tabIndex={0}
      role="application"
      aria-roledescription={t('canvas.roleDescription')}
      aria-label={t('canvas.label')}
      aria-describedby={`${prefix}-help`}
      aria-activedescendant={focusedNode?.domId}
      className={readOnly ? 'flow-canvas is-readonly' : 'flow-canvas'}
      data-testid="canvas"
      data-focused={focused}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
      onMouseMove={(event) => {
        pointer.current = { x: event.clientX, y: event.clientY };
      }}
      onMouseLeave={() => {
        pointer.current = undefined;
      }}
      onKeyDown={onKeyDown}
    >
      <p id={`${prefix}-help`} className="visually-hidden">
        {t(readOnly ? 'canvas.keysRun' : 'canvas.keys')}
      </p>
      <div className="visually-hidden" role="status" aria-live="polite" data-testid="announcer">
        {announcement}
      </div>
      <RightAnglesContext value={rightAngles}>
        <CanvasActionsContext value={actions}>
          <ReactFlow
            nodes={nodes}
            edges={drawnEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            edgesReconnectable={!readOnly}
            // A chosen connection is drawn above the blocks, so its output end can be taken too.
            elevateEdgesOnSelect
            reconnectRadius={12}
            onReconnectStart={onReconnectStart}
            onReconnect={onReconnect}
            onReconnectEnd={onReconnectEnd}
            // The left button draws a selection box, and the middle one pans.
            selectionOnDrag={!readOnly}
            selectionMode={SelectionMode.Partial}
            panOnDrag={readOnly ? true : [1]}
            // The wheel and a touchpad move the view, and Ctrl+wheel or a pinch zooms it.
            panOnScroll
            panOnScrollMode={PanOnScrollMode.Free}
            zoomOnScroll={false}
            zoomOnPinch
            zoomActivationKeyCode="Control"
            onNodeClick={(_event, node) => {
              setFocused(node.id);
              setMoving(false);
            }}
            onNodeDoubleClick={(_event, node) => {
              if (readOnly) {
                if (node.type === 'block') onOpenBlock?.(node.id);
              } else if (node.type === 'note') {
                setEditingNote(node.id);
              }
            }}
            onPaneClick={() => {
              // A click on the empty canvas lets go of everything, keyboard focus included.
              onSelect(new Set());
              setFocused(undefined);
              setMoving(false);
            }}
            onEdgeClick={() => {
              setFocused(undefined);
              setMoving(false);
            }}
            onEdgeDoubleClick={(_event, edge) => {
              deleteConnection(edge.id);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              if (readOnly) return;
              setAddAt(placed(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })));
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              if (readOnly || node.type === 'frame') return;
              openMenu(node.id, event.clientX, event.clientY);
            }}
            zoomOnDoubleClick={false}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            isValidConnection={isValidConnection}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elevateNodesOnSelect={false}
            nodesFocusable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            onlyRenderVisibleElements={document.blocks.length >= CULL_FROM}
            minZoom={0.05}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            snapToGrid={snapToGrid}
            snapGrid={[GRID, GRID]}
          >
            <Background gap={GRID} />
            <MiniMap pannable zoomable ariaLabel={t('canvas.overview')} />
            <Controls showInteractive={false}>
              {readOnly ? null : (
                <ControlButton
                  title={t('canvas.snapToGrid')}
                  aria-label={t('canvas.snapToGrid')}
                  aria-pressed={snapToGrid}
                  className={snapToGrid ? 'is-on' : undefined}
                  onClick={() => onOptions?.({ ...options, snapToGrid: !snapToGrid })}
                >
                  <Grid3x3 aria-hidden="true" />
                </ControlButton>
              )}
              <ControlButton
                title={t('canvas.rightAngles')}
                aria-label={t('canvas.rightAngles')}
                aria-pressed={rightAngles}
                className={rightAngles ? 'is-on' : undefined}
                onClick={() => onOptions?.({ ...options, rightAngles: !rightAngles })}
              >
                <CornerDownRight aria-hidden="true" />
              </ControlButton>
            </Controls>
            {children}
          </ReactFlow>
        </CanvasActionsContext>
      </RightAnglesContext>
      {menu === undefined ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('canvas.menu', { name: nameOf(menu.id) })}
          items={menuItems(menu.id)}
          onAction={onMenu}
          onClose={() => {
            setMenu(undefined);
            container.current?.focus();
          }}
        />
      )}
      {addAt === undefined ? null : (
        <AddDialog
          title={t('canvas.addHereTitle')}
          choices={[...library, { choice: { kind: 'note' }, label: t('canvas.kindNote') }]}
          onPick={(choice) => {
            setAddAt(undefined);
            onAddAt(choice, addAt);
            container.current?.focus();
          }}
          onClose={() => {
            setAddAt(undefined);
            container.current?.focus();
          }}
        />
      )}
      {dialog?.kind === 'add' && dialogBlock !== undefined ? (
        <AddDialog
          title={t('canvas.addTitle', { name: nameOf(dialogBlock.id) })}
          choices={library}
          onPick={(choice) => {
            setDialog(undefined);
            if (choice.kind === 'note') return;
            const added = onAddAfter(dialogBlock.id, choice);
            container.current?.focus();
            if (added !== undefined) {
              setFocused(added);
              reveal_(added);
              announce(t('canvas.added', { after: nameOf(dialogBlock.id) }));
            }
          }}
          onClose={() => {
            setDialog(undefined);
            container.current?.focus();
          }}
        />
      ) : null}
      {dialog?.kind === 'connect' && dialogBlock !== undefined ? (
        <ConnectDialog
          sourceName={nameOf(dialogBlock.id)}
          outputs={outputsOf(dialogBlock).map((output) => {
            const now = document.connections
              .filter(
                (connection) =>
                  connection.from === dialogBlock.id && connectionOutput(connection) === output,
              )
              .map(({ to }) => nameOf(to));
            return {
              id: output,
              label: outputLabel(output),
              now: now.length === 0 ? undefined : now.join(', '),
            };
          })}
          targetsOf={(output) => {
            const origin = document.positions[dialogBlock.id] ?? { x: 0, y: 0 };
            const distance = (id: string): number => {
              const at = document.positions[id] ?? origin;
              return Math.hypot(at.x - origin.x, at.y - origin.y);
            };
            return validTargets(document, dialogBlock.id, output)
              .sort((a, b) => distance(a) - distance(b))
              .map((id) => ({ id, name: nameOf(id) }));
          }}
          onConnect={(output, target) => {
            setDialog(undefined);
            onChange((current) => connect(current, dialogBlock.id, output, target));
            container.current?.focus();
            announce(
              t('canvas.connected', {
                from: nameOf(dialogBlock.id),
                output: outputLabel(output),
                to: nameOf(target),
              }),
            );
          }}
          onClose={() => {
            setDialog(undefined);
            container.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
