import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  PanOnScrollMode,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import type {
  Connection,
  Edge,
  EdgeChange,
  FinalConnectionState,
  HandleType,
  IsValidConnection,
  NodeChange,
  OnConnectStart,
  OnNodeDrag,
} from '@xyflow/react';
import { ChevronDown, ChevronUp, StickyNote, X } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './canvas.css';
import {
  BODY_OUTPUT,
  ERROR_OUTPUT,
  connectionOutput,
  isDisableable,
  isLoopBlock,
  isLoopType,
  loopBody,
  outputsOf,
  validTargets,
} from '@bildora/protocol';
import type {
  AutomationBlock,
  AutomationConnection,
  AutomationGroup,
  AutomationPosition,
} from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type {
  AutomationCanvasView,
  RunCallerView,
  StepRunView,
  TakenPathView,
  ToolView,
} from '../../../shared/ipc-contract.js';
import { blockKindText, loopHeader, loopSummary, outputLabel, portText } from './block-text.js';
import {
  NOTE_SIZE,
  blockOf,
  clipCorner,
  alignToGrid,
  connect,
  copyItems,
  disablesChosen,
  disconnect,
  downstreamOf,
  dropInLoops,
  duplicateItems,
  extractBlock,
  isDisabled,
  isInFlow,
  loopAtPoint,
  loopOf,
  moveItems,
  pasteItems,
  removeItems,
  resizeLoop,
  sizeOf,
  spliceEnds,
  spliceInto,
  toggleDisabled,
  updateNote,
  upstreamOf,
  withFramePositions,
} from './flow-document.js';
import type { ConnectionRef, FlowClip } from './flow-document.js';
import { ContextMenu } from '../../shell/ContextMenu.js';
import type { MenuEntry } from '../../shell/menu-model.js';
import {
  arrangeEntries,
  commandItem,
  optionsEntries,
  scaleEntries,
  toggleDisabledItem,
} from './canvas-commands.js';
import type {
  CanvasCommand,
  CanvasCommands,
  CanvasToggle,
  EditorCommands,
} from './canvas-commands.js';
import { layoutBlocks } from './layout.js';
import {
  CanvasActionsContext,
  InputTonesContext,
  LoopRoundsContext,
  NO_PORT_HOVER,
  PortHoverContext,
  PortLayoutsContext,
  RightAnglesContext,
} from './canvas-actions.js';
import type { PortHover } from './canvas-actions.js';
import { inputTones } from './input-tones.js';
import { PortTooltip } from './PortTooltip.js';
import type { PortBox } from './PortTooltip.js';
import { layoutPorts } from './port-sides.js';
import type { PortRect, Side } from './port-sides.js';
import type { CanvasActions, ChooseRound } from './canvas-actions.js';
import { edgeTypes } from './edges.js';
import { AddDialog, ConnectDialog } from './KeyboardDialogs.js';
import type { AddChoice, LibraryChoice } from './KeyboardDialogs.js';
import { describeBlock, domId, isDirection, nearestInDirection, neighbourOf } from './keyboard.js';
import type { FlowDocument, NewBlock } from './flow-document.js';
import { nodeTypes } from './nodes.js';
import type { BlockNodeData, CanvasNode, LoopNodeData } from './nodes.js';
import { LOOP_BODY_PORT_X, LOOP_BODY_PORT_Y, LOOP_HEADER, frameRects } from './loop-frames.js';
import type { Rect } from './loop-frames.js';
import { isShownPath, shownRounds } from './run-rounds.js';
import { usedByCounts } from './values.js';
import { matchingBlocks } from './find.js';

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
const NO_ROUNDS: ReadonlyMap<string, number> = new Map();
const NO_AUTOMATIONS: readonly { readonly id: string; readonly name: string }[] = [];
/** The zoom range, as wide as Scale's presets go. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
/** A box drawn for Scale to rectangle smaller than this, in pixels, zooms nowhere. */
const RECTANGLE_MIN = 8;
export const LIBRARY_DRAG_TYPE = 'application/x-bildora-block';
/** What Ctrl+C copied, kept outside any one canvas so it pastes into another automation too. */
let clipboard: FlowClip | undefined;

function keepCopy(clip: FlowClip): void {
  clipboard = clip;
}

/** How far from a port the pointer still points at it, as its hit area reaches. */
const PORT_REACH = 6;

/** The port under the pointer, and where it is in the canvas. */
interface HoveredPort {
  readonly block: string;
  readonly input: boolean;
  readonly port: string;
  readonly side: Side;
  readonly box: PortBox;
}

function isSide(value: string | undefined): value is Side {
  return value === 'left' || value === 'right' || value === 'top' || value === 'bottom';
}

/**
 * The port nearest the pointer within reach of it. An input lets the pointer through to the end of
 * a connection, so the pointer is tested against where the ports are rather than what it is over.
 */
function portUnder(x: number, y: number, canvas: HTMLElement): HoveredPort | undefined {
  const area = canvas.getBoundingClientRect();
  let nearest: { port: HoveredPort; distance: number } | undefined;
  for (const handle of canvas.querySelectorAll<HTMLElement>('.react-flow__handle.handle')) {
    const rect = handle.getBoundingClientRect();
    if (
      x < rect.left - PORT_REACH ||
      x > rect.right + PORT_REACH ||
      y < rect.top - PORT_REACH ||
      y > rect.bottom + PORT_REACH
    ) {
      continue;
    }
    const block = handle.dataset['nodeid'];
    const port = handle.dataset['handleid'];
    const side = handle.dataset['side'];
    if (block === undefined || port === undefined || !isSide(side)) continue;
    const distance = Math.hypot(x - (rect.left + rect.right) / 2, y - (rect.top + rect.bottom) / 2);
    if (nearest !== undefined && nearest.distance <= distance) continue;
    nearest = {
      distance,
      port: {
        block,
        input: handle.classList.contains('target'),
        port,
        side,
        box: {
          left: rect.left - area.left,
          top: rect.top - area.top,
          right: rect.right - area.left,
          bottom: rect.bottom - area.top,
        },
      },
    };
  }
  return nearest?.port;
}

/** A connection drawn with one more class. */
function withClass(edge: Edge, mark: string): Edge {
  return { ...edge, className: `${edge.className ?? ''} ${mark}`.trim() };
}

function samePort(a: HoveredPort | undefined, b: HoveredPort | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.block === b.block &&
    a.port === b.port &&
    a.input === b.input &&
    a.side === b.side &&
    a.box.left === b.box.left &&
    a.box.top === b.box.top
  );
}

function nothing(): void {
  // A command that cannot run now.
}
const UNAVAILABLE: CanvasCommand = { enabled: false, run: nothing };
const NO_EDITOR: EditorCommands = {
  undo: UNAVAILABLE,
  redo: UNAVAILABLE,
  group: UNAVAILABLE,
  ungroup: UNAVAILABLE,
  save: UNAVAILABLE,
  saveAndRun: UNAVAILABLE,
};

type CommandName = {
  [K in keyof CanvasCommands]: CanvasCommands[K] extends CanvasCommand ? K : never;
}[keyof CanvasCommands];

/**
 * The commands handed to the app's menus: their states as they were, and runs that reach the
 * canvas as it is when chosen.
 */
function relayed(
  commands: CanvasCommands,
  latest: { readonly current: CanvasCommands },
): CanvasCommands {
  const command = (name: CommandName): CanvasCommand => ({
    enabled: commands[name].enabled,
    run: () => {
      latest.current[name].run();
    },
  });
  const toggle = (
    name: 'showGrid' | 'snapToGrid' | 'rightAngles' | 'showNavigator',
  ): CanvasToggle => ({
    on: commands[name].on,
    toggle: () => {
      latest.current[name].toggle();
    },
  });
  return {
    undo: command('undo'),
    redo: command('redo'),
    group: command('group'),
    ungroup: command('ungroup'),
    save: command('save'),
    saveAndRun: command('saveAndRun'),
    copy: command('copy'),
    paste: command('paste'),
    duplicate: command('duplicate'),
    delete: command('delete'),
    selectAll: command('selectAll'),
    deselectAll: command('deselectAll'),
    invertSelection: command('invertSelection'),
    selectUpstream: command('selectUpstream'),
    selectDownstream: command('selectDownstream'),
    takeOut: command('takeOut'),
    replace: command('replace'),
    showUses: command('showUses'),
    toggleDisabled: command('toggleDisabled'),
    disables: commands.disables,
    tidyAll: command('tidyAll'),
    tidySelected: command('tidySelected'),
    alignToGrid: command('alignToGrid'),
    zoom: commands.zoom,
    scaleTo: (zoom) => {
      latest.current.scaleTo(zoom);
    },
    scaleToFit: command('scaleToFit'),
    scaleToRectangle: command('scaleToRectangle'),
    zoomIn: command('zoomIn'),
    zoomOut: command('zoomOut'),
    showGrid: toggle('showGrid'),
    snapToGrid: toggle('snapToGrid'),
    rightAngles: toggle('rightAngles'),
    showNavigator: toggle('showNavigator'),
  };
}

/** What the app's menus need to know has changed: which commands can run, and the zoom. */
function stateOf(commands: CanvasCommands): string {
  return Object.values(commands)
    .map((value: unknown) =>
      typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : typeof value === 'object' && value !== null && 'enabled' in value
          ? String(value.enabled)
          : typeof value === 'object' && value !== null && 'on' in value
            ? String(value.on)
            : '',
    )
    .join(',');
}

export interface CanvasRun {
  /** Which run it is, so that rounds picked in one are not kept for the next. */
  readonly runId?: string;
  readonly steps: readonly StepRunView[];
  readonly paths: readonly TakenPathView[];
  /** Set when a Run automation block of another run started this one. */
  readonly caller?: RunCallerView;
}

export interface CanvasProps {
  readonly document: FlowDocument;
  readonly names: ReadonlyMap<string, string>;
  /** The automations Run automation blocks can call, which their text names. */
  readonly automations?: readonly { readonly id: string; readonly name: string }[];
  /** The Workspace's tools, whose program icons Run tool blocks show. */
  readonly tools: readonly ToolView[];
  readonly problemCounts: ReadonlyMap<string, number>;
  readonly selected: ReadonlySet<string>;
  /** False while the tab is hidden, when the canvas has no size to measure. */
  readonly active: boolean;
  /** Set in the run view, which shows block states and changes nothing. */
  readonly run?: CanvasRun;
  /** The round each loop's frame shows in the run view; a loop not here follows its latest. */
  readonly roundChoices?: ReadonlyMap<string, number>;
  /** Chooses the round a loop's frame shows, or its latest again for undefined. */
  readonly onChooseRound?: ChooseRound;
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
  /** The automation on the canvas, which cannot be dropped onto itself to call itself. */
  readonly automationId?: string;
  /**
   * Opens what a Run automation block calls, on a double-click: the automation while editing, or
   * the run it started in a run view. Says whether there was one.
   */
  readonly onOpenCall?: (id: string) => boolean;
  /** What A offers to add after the focused block. */
  readonly library: readonly LibraryChoice[];
  /** In the run view, a double-click on a block goes back to editing it. */
  readonly onOpenBlock?: (id: string) => void;
  /** Asks for a block's name in links to be changed, as F2 and the block's menu do. */
  readonly onRenameBlock?: (id: string) => void;
  /** Puts a new block for another tool in a Run tool block's place, and gives its id. */
  readonly onReplaceBlock?: (id: string, choice: NewBlock & { kind: 'run' }) => string | undefined;
  /** Adds a block after another, and gives the new block's id. */
  readonly onAddAfter: (anchor: string, choice: NewBlock) => string | undefined;
  /** Moves keyboard focus to a block, as the blocks list asks. Changes each time it is asked. */
  readonly focusRequest?: { readonly id: string; readonly count: number };
  /** Snap to grid and right-angle connections, shared by every automation tab. */
  readonly options?: AutomationCanvasView;
  readonly onOptions?: (options: AutomationCanvasView) => void;
  /** What the tab around the canvas does, which the menus offer beside the canvas's own commands. */
  readonly editor?: EditorCommands;
  /** Given the commands while the canvas is the one on view, and nothing once it is not. */
  readonly onCommands?: ((commands: CanvasCommands | undefined) => void) | undefined;
  readonly onError?: (error: unknown) => void;
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
    const node = element.closest('.react-flow__node-block, .react-flow__node-loop');
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
  if (step.state === 'disabled') return t('automation.disabled');
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
  matches: ReadonlySet<string> | undefined,
): CanvasNode[] {
  return nodes.map((node): CanvasNode => {
    const isSelected = selected.has(node.id);
    const className = [
      // Shift on the empty canvas draws a selection box, but on a block it drags the block in or
      // out of the flow. xyflow starts no box from an element marked `nokey`.
      node.type === 'block' ? 'nokey' : '',
      targets?.has(node.id) === true ? 'is-target' : '',
      focused === node.id ? 'is-focused' : '',
      matches === undefined || node.type !== 'block'
        ? ''
        : matches.has(node.id)
          ? 'is-match'
          : 'is-dimmed',
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

/** Loops nest behind each other, and every loop sits behind the blocks it holds. */
const LOOP_Z = -20;

/**
 * Each loop's frame around the blocks inside it, wherever they are now. A block being dragged does
 * not count, so the frame shows what stays in it, and a block dragged out leaves it.
 */
function framedLoops(
  nodes: readonly CanvasNode[],
  blocks: readonly AutomationBlock[],
  positions: Readonly<Record<string, AutomationPosition>>,
  released: ReadonlySet<string> = new Set(),
): CanvasNode[] {
  if (!blocks.some(isLoopBlock)) return [...nodes];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rectOf = (id: string): Rect | undefined => {
    const node = byId.get(id);
    if (node?.type !== 'block' || node.hidden === true) return undefined;
    return { ...node.position, width: node.width ?? 0, height: node.height ?? 0 };
  };
  // A loop being dragged keeps its own place; others keep theirs when nothing stays inside. A
  // frame being resized takes the size it is dragged to, never less than its blocks.
  const positionOf = (id: string): AutomationPosition | undefined => {
    const node = byId.get(id);
    const kept = positions[id];
    if (node?.resizing === true && node.width !== undefined && node.height !== undefined) {
      return { ...node.position, width: node.width, height: node.height };
    }
    // A frame just let go is where it was dropped, not where the flow had it before.
    if (node?.dragging !== true && !released.has(id)) return kept ?? node?.position;
    if (node === undefined) return kept;
    // A frame given a size keeps it while it is dragged.
    return kept?.width === undefined || kept.height === undefined
      ? node.position
      : { ...node.position, width: kept.width, height: kept.height };
  };
  // What is being dragged belongs to no frame until it is let go.
  const loose = blocks.map((block) => ({
    id: block.id,
    type: block.type,
    loop: byId.get(block.id)?.dragging === true ? undefined : loopOf(block),
  }));
  const frames = frameRects(loose, rectOf, positionOf);
  return nodes.map((node): CanvasNode => {
    if (node.type !== 'loop') return node;
    const frame = frames.get(node.id);
    if (frame === undefined) return node;
    const { x, y, width, height } = frame;
    if (
      node.position.x === x &&
      node.position.y === y &&
      node.width === width &&
      node.height === height
    ) {
      return node;
    }
    return { ...node, position: { x, y }, width, height };
  });
}

function blockById(blocks: readonly AutomationBlock[], id: string): AutomationBlock | undefined {
  return blocks.find((block) => block.id === id);
}

/** Loop frames, then each group's frame around its blocks and loops. */
function framed(
  nodes: readonly CanvasNode[],
  blocks: readonly AutomationBlock[],
  positions: Readonly<Record<string, AutomationPosition>>,
  groups: readonly AutomationGroup[],
  released?: ReadonlySet<string>,
): CanvasNode[] {
  return framedGroups(framedLoops(nodes, blocks, positions, released), groups);
}

/** What moves with an item dragged by itself: a loop's blocks, or a group's blocks and loops. */
function carriedBy(
  id: string,
  blocks: readonly AutomationBlock[],
  groups: readonly AutomationGroup[],
): string[] {
  const group = groups.find((item) => item.id === id);
  const held = group === undefined ? [id] : group.blocks;
  return [
    ...new Set(
      held.flatMap((member) =>
        isLoopType(blockById(blocks, member)?.type ?? '')
          ? [member, ...loopBody(blocks, member)]
          : [member],
      ),
    ),
  ];
}

/** Each group's frame around its blocks, wherever those blocks are now, dragged ones included. */
function framedGroups(
  nodes: readonly CanvasNode[],
  groups: readonly AutomationGroup[],
): CanvasNode[] {
  if (groups.length === 0) return [...nodes];
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
  automations = NO_AUTOMATIONS,
  tools,
  problemCounts,
  selected,
  active,
  run,
  roundChoices = NO_ROUNDS,
  onChooseRound,
  reveal,
  onChange,
  onSelect,
  onAddAt,
  automationId,
  onOpenCall,
  library,
  onOpenBlock,
  onRenameBlock,
  onReplaceBlock,
  onAddAfter,
  focusRequest,
  options = NO_OPTIONS,
  onOptions,
  editor = NO_EDITOR,
  onCommands,
  onError,
  children,
}: CanvasProps) {
  const prefix = useId();
  const [focused, setFocused] = useState<string | undefined>(undefined);
  /** The canvas find: what it looks for, and which match is on view. */
  const [find, setFind] = useState<
    { readonly query: string; readonly index: number } | undefined
  >();
  /** Changes each time the find field should take the caret. */
  const [findFocus, setFindFocus] = useState(0);
  const findField = useRef<HTMLInputElement>(null);
  /** After Enter, arrow keys move the focused block instead of moving between blocks. */
  const [moving, setMoving] = useState(false);
  const [dialog, setDialog] = useState<
    { kind: 'add' | 'connect' | 'replace'; id: string } | undefined
  >(undefined);
  const [announcement, setAnnouncement] = useState('');
  /** The note being written on the canvas. */
  const [editingNote, setEditingNote] = useState<string | undefined>(undefined);
  /** A block's or a note's menu, open at the pointer. */
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | undefined>(undefined);
  /** The empty canvas's menu, open at the pointer, and the point of the flow it was asked at. */
  const [paneMenu, setPaneMenu] = useState<
    { x: number; y: number; at: AutomationPosition } | undefined
  >(undefined);
  /** Where a right-click on the empty canvas asked to add something. */
  const [addAt, setAddAt] = useState<AutomationPosition | undefined>(undefined);
  /** Scale to rectangle: waiting for a box, then the box being drawn, from the canvas's corner. */
  const [rectangle, setRectangle] = useState<
    { from?: { x: number; y: number }; to?: { x: number; y: number } } | undefined
  >(undefined);
  const flow = useReactFlow<CanvasNode>();
  const zoom = useStore((state) => state.transform[2]);
  const readOnly = run !== undefined;
  const shown = useMemo(
    () => shownRounds(document.blocks, run?.steps ?? [], roundChoices),
    [document.blocks, run, roundChoices],
  );
  const snapToGrid = options.snapToGrid === true && !readOnly;
  const rightAngles = options.rightAngles === true;
  const showGrid = options.hideGrid !== true;
  const showNavigator = options.hideNavigator !== true;
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
  // A tab laid out before its panels have their size can open with no width yet.
  const [hasWidth, setHasWidth] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (element === null) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      setHasWidth((entry?.contentRect.width ?? 0) > 0);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const toolsById = useMemo(() => new Map(tools.map((tool) => [tool.id, tool])), [tools]);
  const usedBy = useMemo(() => usedByCounts(document.blocks), [document.blocks]);
  const matches = useMemo(
    () => (find === undefined ? [] : matchingBlocks(document.blocks, find.query, names, toolsById)),
    [find, document.blocks, names, toolsById],
  );
  const matched = useMemo(
    () => (find === undefined || find.query.trim() === '' ? undefined : new Set(matches)),
    [find, matches],
  );
  const data = useMemo(() => {
    const states = shown.steps;
    return new Map(
      document.blocks.map((block): [string, BlockNodeData | LoopNodeData] => {
        const step = states.get(block.id);
        const tool = block.type === 'run' ? toolsById.get(block.tool) : undefined;
        const detail = stepDetail(step);
        if (isLoopBlock(block)) {
          const nameOf = (id: string): string => names.get(id) ?? id;
          const header = loopHeader(block, nameOf);
          const summary = loopSummary(block, nameOf);
          const rounds = shown.rounds.get(block.id);
          return [
            block.id,
            {
              kind: block.type,
              name: names.get(block.id) ?? block.id,
              kindLabel: blockKindText(block, tools, automations),
              ...(header === undefined ? {} : { header }),
              ...(summary === undefined ? {} : { summary }),
              resizable: !readOnly,
              domId: domId(prefix, block.id),
              blockId: block.id,
              description: describeBlock(document, block.id, (id) => names.get(id) ?? id),
              problems: readOnly ? 0 : (problemCounts.get(block.id) ?? 0),
              usedBy: usedBy.get(block.id) ?? 0,
              ...(run === undefined ? {} : { state: step?.state ?? 'idle' }),
              ...(detail === undefined ? {} : { detail }),
              ...(rounds === undefined ? {} : { rounds }),
            },
          ];
        }
        return [
          block.id,
          {
            kind: block.type,
            name: names.get(block.id) ?? block.id,
            // Start's name already says what it is, so its second line says when it runs.
            kindLabel: blockKindText(block, tools, automations),
            outputs: outputsOf(block).map((id) => ({ id, label: outputLabel(id) })),
            domId: domId(prefix, block.id),
            blockId: block.id,
            description: describeBlock(document, block.id, (id) => names.get(id) ?? id),
            problems: readOnly ? 0 : (problemCounts.get(block.id) ?? 0),
            usedBy: usedBy.get(block.id) ?? 0,
            disabled: isDisabled(block) || step?.state === 'disabled',
            ...(tool === undefined ? {} : { tool }),
            ...(run === undefined ? {} : { state: step?.state ?? 'idle' }),
            ...(detail === undefined ? {} : { detail }),
          },
        ];
      }),
    );
    // `document` stands for its blocks and connections here; positions are left out on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    document.blocks,
    document.connections,
    names,
    toolsById,
    tools,
    automations,
    problemCounts,
    usedBy,
    run,
    shown,
    readOnly,
    prefix,
  ]);

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
    const loopDepths = new Map(
      document.blocks.filter(isLoopBlock).map(({ id }) => {
        let depth = 0;
        for (
          let at = loopOf(blockOf(document, id));
          at !== undefined;
          at = loopOf(blockOf(document, at))
        ) {
          depth += 1;
          if (depth > document.blocks.length) break;
        }
        return [id, depth];
      }),
    );
    const blocks = document.blocks.map((block): CanvasNode => {
      const size = sizeOf(block);
      const position = document.positions[block.id];
      if (isLoopBlock(block)) {
        const inside = document.blocks.some((item) => loopOf(item) === block.id);
        return {
          id: block.id,
          type: 'loop',
          position: position ?? { x: 0, y: 0 },
          hidden: position === undefined && !inside,
          width: size.width,
          height: size.height,
          data: data.get(block.id) as LoopNodeData,
          dragHandle: '.loop-header',
          zIndex: LOOP_Z + (loopDepths.get(block.id) ?? 0),
          deletable: !readOnly,
        };
      }
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
    // Loops come before the blocks they hold, so a frame never covers them.
    const notes = document.notes.map((note): CanvasNode => ({
      id: note.id,
      type: 'note',
      position: { x: note.x, y: note.y },
      width: note.width ?? NOTE_SIZE.width,
      height: note.height ?? NOTE_SIZE.height,
      data: { text: note.text, placeholder: t('canvas.notePlaceholder'), readOnly },
      deletable: !readOnly,
    }));
    const ordered = [
      ...blocks.filter(({ type }) => type === 'loop'),
      ...blocks.filter(({ type }) => type !== 'loop'),
    ];
    return framed(
      [...frames, ...ordered, ...notes],
      document.blocks,
      document.positions,
      document.groups,
    );
  }, [document, data, readOnly]);
  // Blocks move here while dragged, and start again from the document whenever it changes, but
  // for a block still being dragged, which a check finishing meanwhile must not snap back.
  // Selection and the targets of a connection being drawn only mark the blocks as they are.
  const [nodes, setNodes] = useState<CanvasNode[]>(() =>
    marked(built, selected, targets, focused, matched),
  );
  const [from, setFrom] = useState({ built, selected, targets, focused, matched });
  if (
    from.built !== built ||
    from.selected !== selected ||
    from.targets !== targets ||
    from.focused !== focused ||
    from.matched !== matched
  ) {
    setFrom({ built, selected, targets, focused, matched });
    setNodes(
      marked(
        from.built === built ? nodes : stillDragged(built, nodes),
        selected,
        targets,
        focused,
        matched,
      ),
    );
  }

  const taken = useMemo(
    () =>
      new Set(
        run?.paths
          .filter((path) => isShownPath(path, loopOf(blockOf(document, path.from)), shown.keys))
          .map(({ from, output, to }) => edgeId(from, output, to)),
      ),
    // `document` stands for its blocks here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, shown, document.blocks],
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

  const announce = useCallback((message: string) => {
    // Clearing first makes the same message speak again.
    setAnnouncement('');
    requestAnimationFrame(() => {
      setAnnouncement(message);
    });
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      let next = applyNodeChanges(changes, nodes);
      // A frame resized from a corner moves too; its blocks stay where they are.
      const resizing = new Set(
        changes.flatMap((change) =>
          change.type === 'dimensions' && change.resizing !== undefined ? [change.id] : [],
        ),
      );
      // Where each frame let go of a resize ends up, before frames are drawn around their blocks.
      const resizedRects = new Map(
        changes.flatMap((change) => {
          if (change.type !== 'dimensions' || change.resizing !== false || !change.dimensions) {
            return [];
          }
          const node = next.find((item) => item.id === change.id);
          return node?.type === 'loop'
            ? [[change.id, { ...node.position, ...change.dimensions }]]
            : [];
        }),
      );
      const dragged = new Set(
        changes.flatMap((change) => (change.type === 'position' ? [change.id] : [])),
      );
      // Dragging a frame by its header moves what it holds: a group's blocks, a loop's body.
      for (const change of changes) {
        if (change.type !== 'position' || change.position === undefined) continue;
        if (resizing.has(change.id)) continue;
        const before = nodes.find(({ id }) => id === change.id);
        if (before === undefined || (before.type !== 'frame' && before.type !== 'loop')) continue;
        const carried = new Set(
          carriedBy(change.id, document.blocks, document.groups).filter(
            (id) => id !== change.id && !dragged.has(id),
          ),
        );
        if (carried.size === 0) continue;
        const dx = change.position.x - before.position.x;
        const dy = change.position.y - before.position.y;
        next = next.map((node) =>
          carried.has(node.id)
            ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } }
            : node,
        );
      }
      const released = new Set(
        changes.flatMap((change) =>
          change.type === 'position' && change.dragging === false && !resizing.has(change.id)
            ? [change.id]
            : [],
        ),
      );
      next = framed(next, document.blocks, document.positions, document.groups, released);

      // A drag or a resize reaches the document once it ends.
      const moved: Record<string, AutomationPosition> = {};
      const resized: { id: string; width: number; height: number }[] = [];
      const dropped: string[] = [];
      for (const change of changes) {
        if (change.type === 'position' && change.dragging === false && !resizing.has(change.id)) {
          const node = next.find((item) => item.id === change.id);
          if (node?.type === 'block' || node?.type === 'loop') dropped.push(change.id);
          for (const id of carriedBy(change.id, document.blocks, document.groups)) {
            const item = next.find((candidate) => candidate.id === id);
            if (item !== undefined && item.type !== 'frame') moved[id] = item.position;
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
      // Blocks let go over a frame go into its loop, and out of it when let go outside. A move
      // that would make a connection cross a frame is refused, and the blocks go back.
      const landed =
        dropped.length === 0
          ? undefined
          : dropInLoops(
              document,
              shifted === undefined
                ? moveItems(document, moved)
                : extractBlock(moveItems(document, moved), shifted.node),
              dropped,
            );
      if (dropped.length > 0 && landed === undefined) {
        announce(t('canvas.crossesLoop'));
        setNodes(marked(built, selected, targets, focused, matched));
        return;
      }
      setNodes(next);
      if (landed !== undefined) {
        const entered = dropped.filter(
          (id) => loopOf(blockOf(landed, id)) !== loopOf(blockOf(document, id)),
        );
        const into = loopOf(blockOf(landed, entered[0] ?? ''));
        if (entered.length > 0) {
          announce(
            into === undefined
              ? t('canvas.movedOutOfLoop', { count: entered.length })
              : t('canvas.movedIntoLoop', {
                  count: entered.length,
                  loop: names.get(into) ?? into,
                }),
          );
        }
      }
      if (Object.keys(moved).length > 0 || resized.length > 0) {
        onChange((current) => {
          let updated = moveItems(current, moved);
          if (dropped.length > 0) {
            updated = dropInLoops(current, updated, dropped) ?? updated;
          }
          if (shifted !== undefined) {
            updated = extractBlock(updated, shifted.node);
            const ends = spliceEnds(updated, shifted.node);
            if (shifted.edge !== undefined && shifted.fits && ends !== undefined) {
              const into = connectionOf(shifted.edge);
              updated = spliceInto(updated, into, ends.first, ends.tail) ?? updated;
            }
          }
          updated = withFramePositions(updated);
          for (const { id, width, height } of resized) {
            const note = updated.notes.find((item) => item.id === id);
            const node = next.find((item) => item.id === id);
            const rect = resizedRects.get(id);
            if (rect !== undefined) {
              updated = resizeLoop(updated, id, rect);
              continue;
            }
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
    [
      nodes,
      document,
      onChange,
      onSelect,
      selected,
      built,
      targets,
      focused,
      matched,
      names,
      announce,
    ],
  );

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);
  // The connection a block from the library would go into is drawn in the accent. While a block is
  // Shift-dragged, the flow is drawn as it would be if the block were let go now, with the
  // connections that would join it in the accent.
  const drawnEdges = useMemo(() => {
    if (preview !== undefined) {
      return edgesFor(preview.connections).map((edge) =>
        preview.pending.has(edge.id)
          ? withClass(edge, 'edge--pending')
          : edge.id === preview.replaced
            ? withClass(edge, 'edge--replaced')
            : edge,
      );
    }
    return edges.map((edge) => (edge.id === spliceEdge ? withClass(edge, 'edge--splice') : edge));
  }, [edges, spliceEdge, preview, edgesFor]);

  // The port under the pointer names itself and lights up its connections and the blocks at their
  // other end.
  const [hoveredPort, setHoveredPort] = useState<HoveredPort | undefined>(undefined);
  const [hoveredEdge, setHoveredEdge] = useState<string | undefined>(undefined);
  const hoverFrame = useRef(0);
  const hoverPoint = useRef<{ x: number; y: number } | undefined>(undefined);
  const findPort = useCallback((x: number, y: number, pressed: boolean) => {
    hoverPoint.current = pressed ? undefined : { x, y };
    if (hoverFrame.current !== 0) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const point = hoverPoint.current;
      const canvas = container.current;
      // Nothing is named while a button is held: a block or a connection is being dragged.
      const found =
        point === undefined || canvas === null ? undefined : portUnder(point.x, point.y, canvas);
      setHoveredPort((known) => (samePort(known, found) ? known : found));
    });
  }, []);
  const forgetPort = useCallback(() => {
    cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = 0;
    hoverPoint.current = undefined;
    setHoveredPort(undefined);
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );
  const hoveredBlock = hoveredPort === undefined ? undefined : blockOf(document, hoveredPort.block);
  const portEdges = useMemo(() => {
    if (hoveredPort === undefined) return new Set<string>();
    return new Set(
      drawnEdges
        .filter((edge) =>
          hoveredPort.input
            ? edge.target === hoveredPort.block
            : edge.source === hoveredPort.block && edge.sourceHandle === hoveredPort.port,
        )
        .map(({ id }) => id),
    );
  }, [drawnEdges, hoveredPort]);
  const shownEdges = useMemo(
    () =>
      portEdges.size === 0
        ? drawnEdges
        : drawnEdges.map((edge) =>
            portEdges.has(edge.id) ? withClass(edge, 'edge--port-hover') : edge,
          ),
    [drawnEdges, portEdges],
  );
  const portHover = useMemo((): PortHover => {
    if (hoveredPort === undefined) return NO_PORT_HOVER;
    const peers = new Set<string>();
    for (const edge of shownEdges) {
      if (portEdges.has(edge.id)) peers.add(hoveredPort.input ? edge.source : edge.target);
    }
    return { owner: hoveredPort.block, peers };
  }, [hoveredPort, portEdges, shownEdges]);
  const tones = useMemo(() => inputTones(shownEdges, hoveredEdge), [shownEdges, hoveredEdge]);

  // Ports face the blocks they connect to, as the blocks stand now, so they follow a drag.
  const portShapes = useMemo(
    () =>
      new Map(
        document.blocks.map((block) => [
          block.id,
          {
            hasInput: block.type !== 'start',
            // A loop's body port sits inside its frame, always in the same place.
            outputs: outputsOf(block).filter((output) => output !== BODY_OUTPUT),
          },
        ]),
      ),
    [document.blocks],
  );
  const portLayouts = useMemo(() => {
    const rects = nodes.flatMap((node): PortRect[] => {
      const shape =
        node.type === 'block' || node.type === 'loop' ? portShapes.get(node.id) : undefined;
      if (shape === undefined || node.hidden === true) return [];
      const rect = {
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        width: node.width ?? 0,
        height: node.height ?? 0,
        ...shape,
      };
      if (node.type !== 'loop') return [rect];
      // Blocks the body starts at face the body port, not the middle of the frame.
      const body = {
        id: `${node.id}\u0000${BODY_OUTPUT}`,
        x: node.position.x + LOOP_BODY_PORT_X,
        y: node.position.y + LOOP_HEADER + LOOP_BODY_PORT_Y,
        width: 1,
        height: 1,
        hasInput: false,
        outputs: [],
      };
      return [rect, body];
    });
    const links = drawnEdges.map((edge) =>
      edge.sourceHandle === BODY_OUTPUT
        ? { ...edge, source: `${edge.source}\u0000${BODY_OUTPUT}`, sourceHandle: 'next' }
        : edge,
    );
    return layoutPorts(rects, links);
  }, [nodes, drawnEdges, portShapes]);

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
    (): CanvasActions | undefined =>
      readOnly
        ? undefined
        : {
            editingNote,
            finishNote,
            showUses: (id) => {
              setFind({ query: `${id}.`, index: 0 });
              setFindFocus((count) => count + 1);
            },
          },
    [readOnly, editingNote, finishNote],
  );

  /** Moves to the next match of the find, or the one before, and brings it into view. */
  function stepFind(step: 1 | -1): void {
    if (find === undefined || matches.length === 0) return;
    const index =
      (Math.min(find.index, matches.length - 1) + step + matches.length) % matches.length;
    setFind({ ...find, index });
    const id = matches[index];
    if (id !== undefined) reveal_(id, true);
  }

  function closeFind(): void {
    setFind(undefined);
    container.current?.focus();
  }

  // The find stays open while focus is elsewhere, and Escape closes it from anywhere in the tab,
  // unless a menu or a dialog is open: Escape belongs to those first. Handlers that use Escape
  // themselves, such as an open suggestion list, have already stopped or prevented it.
  const findOpen = find !== undefined;
  useEffect(() => {
    if (!findOpen) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const tab = container.current?.closest('.automation-tab');
      if (!(event.target instanceof Node) || tab?.contains(event.target) !== true) return;
      if (window.document.querySelector('dialog[open], .context-menu-root') !== null) return;
      event.preventDefault();
      setFind(undefined);
      container.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [findOpen]);

  useEffect(() => {
    if (findFocus === 0) return;
    findField.current?.focus();
    findField.current?.select();
  }, [findFocus]);

  /** Opens a block's or a note's menu, chosen first so the menu acts on what it shows. */
  function openMenu(id: string, x: number, y: number): void {
    onSelect(new Set([id]));
    if (blockOf(document, id) !== undefined) setFocused(id);
    setMoving(false);
    setMenu({ id, x, y });
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
    if (!active || !hasWidth || opened.current) return undefined;
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
  }, [active, hasWidth, document.blocks, document.positions, flow]);

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
    keepCopy(clip);
    announce(t('canvas.copied', { count: clip.blocks.length + clip.notes.length }));
  }

  /**
   * Pastes what was copied at a point of the flow, such as where the pointer is, or else a grid
   * step past the original, and selects the copy.
   */
  function pasteClip(where?: AutomationPosition): void {
    if (clipboard === undefined) return;
    const corner = clipCorner(clipboard);
    const at = where ?? { x: corner.x + NUDGE, y: corner.y + NUDGE };
    const into = loopAtPoint(document, placed(at));
    const pasted = pasteItems(document, clipboard, placed(at), into);
    if (pasted === undefined) {
      announce(t('canvas.pasteTooMany'));
      return;
    }
    onChange(() => pasted.document);
    onSelect(new Set(pasted.ids));
    announce(t('canvas.pasted', { count: pasted.ids.length }));
  }

  /** What is chosen: the selection, or else the focused block. */
  const chosen: ReadonlySet<string> =
    selected.size > 0 ? selected : new Set(focused === undefined ? [] : [focused]);
  const chosenBlocks = document.blocks.filter(({ id }) => chosen.has(id));
  const copyable =
    chosenBlocks.some(({ type }) => type !== 'start') ||
    document.notes.some(({ id }) => chosen.has(id));
  const items = [...document.blocks.map(({ id }) => id), ...document.notes.map(({ id }) => id)];
  const cutEdges = edges.some((edge) => edge.selected === true);
  const [single] = chosenBlocks.length === 1 ? chosenBlocks : [];
  const editable = !readOnly;
  const can = (enabled: boolean, run: () => void): CanvasCommand => ({ enabled, run });
  /** Whether toggling the chosen blocks disables them, or undefined when none can be. */
  const disables = disablesChosen(document, chosen);

  function duplicateChosen(): void {
    const copy = duplicateItems(document, chosen, GRID);
    if (copy === undefined) {
      if (copyable) announce(t('canvas.pasteTooMany'));
      return;
    }
    onChange(() => copy.document);
    onSelect(new Set(copy.ids));
    announce(t('command.duplicated', { count: copy.ids.length }));
  }

  /** Lays out the chosen blocks among themselves, keeping their top-left corner where it was. */
  function tidySelected(): void {
    const ids = new Set(chosenBlocks.map(({ id }) => id));
    const corner = (positions: Iterable<AutomationPosition>): AutomationPosition => {
      const list = [...positions];
      return { x: Math.min(...list.map(({ x }) => x)), y: Math.min(...list.map(({ y }) => y)) };
    };
    const before = corner(
      chosenBlocks.flatMap(({ id }) => {
        const at = document.positions[id];
        return at === undefined ? [] : [at];
      }),
    );
    const between = document.connections.filter(({ from, to }) => ids.has(from) && ids.has(to));
    void layoutBlocks(chosenBlocks, between)
      .then((positions) => {
        const after = corner(Object.values(positions));
        const moved = Object.fromEntries(
          Object.entries(positions).map(([id, { x, y }]) => [
            id,
            placed({ x: x - after.x + before.x, y: y - after.y + before.y }),
          ]),
        );
        onChange((current) => moveItems(current, moved));
      })
      .catch((error: unknown) => onError?.(error));
  }

  const commands: CanvasCommands = {
    ...editor,
    copy: can(copyable, copyChosen),
    paste: can(editable && clipboard !== undefined, () => {
      pasteClip();
    }),
    duplicate: can(editable && copyable, duplicateChosen),
    delete: can(editable && (chosen.size > 0 || cutEdges), deleteChosen),
    selectAll: can(items.length > 0, () => {
      onSelect(new Set(items));
    }),
    deselectAll: can(selected.size > 0, () => {
      onSelect(new Set());
    }),
    invertSelection: can(items.length > 0, () => {
      onSelect(new Set(items.filter((id) => !selected.has(id))));
    }),
    selectUpstream: can(chosenBlocks.length > 0, () => {
      onSelect(new Set([...selected, ...upstreamOf(document, chosen)]));
    }),
    selectDownstream: can(chosenBlocks.length > 0, () => {
      onSelect(new Set([...selected, ...downstreamOf(document, chosen)]));
    }),
    takeOut: can(editable && single !== undefined && isInFlow(document, single.id), () => {
      if (single === undefined) return;
      onChange((current) => extractBlock(current, single.id));
      announce(t('command.tookOut', { name: nameOf(single.id) }));
    }),
    replace: can(editable && single?.type === 'run' && onReplaceBlock !== undefined, () => {
      if (single !== undefined) setDialog({ kind: 'replace', id: single.id });
    }),
    showUses: can(single !== undefined && (usedBy.get(single.id) ?? 0) > 0, () => {
      if (single === undefined) return;
      setFind({ query: `${single.id}.`, index: 0 });
      setFindFocus((count) => count + 1);
    }),
    toggleDisabled: can(editable && disables !== undefined, () => {
      const names = chosenBlocks.map(({ id }) => nameOf(id)).join(', ');
      onChange((current) => toggleDisabled(current, chosen));
      announce(t(disables === true ? 'command.disabled' : 'command.enabled', { names }));
    }),
    disables: disables !== false,
    tidyAll: can(editable, () => {
      void layoutBlocks(document.blocks, document.connections)
        .then((positions) => {
          onChange((current) => ({ ...current, positions }));
        })
        .catch((error: unknown) => onError?.(error));
    }),
    tidySelected: can(editable && chosenBlocks.length > 1, tidySelected),
    alignToGrid: can(editable && chosen.size > 0, () => {
      onChange((current) => alignToGrid(current, chosen, GRID));
    }),
    zoom,
    scaleTo: (value) => {
      void flow.zoomTo(value);
    },
    scaleToFit: can(document.blocks.length > 0, () => {
      void flow.fitView({ padding: 0.1, maxZoom: MAX_ZOOM });
    }),
    scaleToRectangle: can(true, () => {
      setRectangle({});
      announce(t('command.scaleToRectangleHint'));
    }),
    zoomIn: can(zoom < MAX_ZOOM, () => {
      void flow.zoomIn();
    }),
    zoomOut: can(zoom > MIN_ZOOM, () => {
      void flow.zoomOut();
    }),
    showGrid: {
      on: showGrid,
      toggle: () => onOptions?.({ ...options, hideGrid: showGrid }),
    },
    snapToGrid: {
      on: snapToGrid,
      toggle: () => onOptions?.({ ...options, snapToGrid: !snapToGrid }),
    },
    rightAngles: {
      on: rightAngles,
      toggle: () => onOptions?.({ ...options, rightAngles: !rightAngles }),
    },
    showNavigator: {
      on: showNavigator,
      toggle: () => onOptions?.({ ...options, hideNavigator: showNavigator }),
    },
  };

  // The app's menus get commands again only when what they can do changes, so the shell draws
  // again only then; what they run is always the latest.
  const latest = useRef(commands);
  useEffect(() => {
    latest.current = commands;
  });
  const state = stateOf(commands);
  useEffect(() => {
    onCommands?.(relayed(latest.current, latest));
  }, [onCommands, state]);
  useEffect(
    () => () => {
      onCommands?.(undefined);
    },
    [onCommands],
  );

  /** A block's or a note's menu. */
  function itemMenu(id: string): MenuEntry[] {
    const block = blockOf(document, id);
    const copying: MenuEntry[] = [
      commandItem(t('command.copy'), commands.copy, 'Ctrl+C'),
      commandItem(t('command.duplicate'), commands.duplicate, 'Ctrl+D'),
    ];
    const removing: MenuEntry[] =
      block?.type === 'start'
        ? []
        : [
            'separator',
            commandItem(t('canvas.menuDelete'), commands.delete, 'Del', { danger: true }),
          ];
    if (block === undefined) {
      const note = document.notes.some((item) => item.id === id);
      return [
        ...(note
          ? [
              {
                label: t('canvas.menuWrite'),
                run: () => {
                  setEditingNote(id);
                },
              },
              'separator' as const,
              ...copying,
            ]
          : []),
        ...removing,
      ];
    }
    return [
      {
        label: t('canvas.menuAdd'),
        shortcut: 'A',
        run: () => {
          setDialog({ kind: 'add', id });
        },
      },
      ...(outputsOf(block).length > 0
        ? [
            {
              label: t('canvas.menuConnect'),
              shortcut: 'C',
              run: () => {
                setDialog({ kind: 'connect', id });
              },
            },
          ]
        : []),
      {
        label: t('canvas.rename'),
        shortcut: 'F2',
        run: () => {
          onRenameBlock?.(id);
        },
      },
      ...(block.type === 'run' && onReplaceBlock !== undefined
        ? [
            {
              label: t('canvas.menuReplace'),
              run: () => {
                setDialog({ kind: 'replace', id });
              },
            },
          ]
        : []),
      ...(isDisableable(block.type) ? [toggleDisabledItem(commands)] : []),
      ...(block.type === 'start'
        ? []
        : [
            'separator' as const,
            ...copying,
            'separator' as const,
            commandItem(t('command.takeOut'), commands.takeOut, 'Shift+drag'),
            commandItem(t('command.group'), commands.group, 'Ctrl+G'),
          ]),
      ...removing,
    ];
  }

  /** The empty canvas's menu, whose additions land where it was opened. */
  function canvasMenu(at: AutomationPosition): MenuEntry[] {
    const add =
      (choice: AddChoice): (() => void) =>
      () => {
        onAddAt(choice, at);
      };
    const tools = library.filter(({ choice }) => choice.kind === 'run');
    const controls = library.filter(
      ({ choice }) => choice.kind !== 'run' && choice.kind !== 'note',
    );
    const entry = ({ choice, label, icon }: LibraryChoice): MenuEntry => ({
      label,
      ...(icon === undefined ? {} : { icon }),
      run: add(choice),
    });
    const categories = new Map<string, LibraryChoice[]>();
    for (const tool of tools) {
      const name = tool.group ?? t('nav.uncategorized');
      categories.set(name, [...(categories.get(name) ?? []), tool]);
    }
    const toolEntries: MenuEntry[] =
      tools.length === 0
        ? [{ label: t('canvas.noTools'), disabled: true }]
        : categories.size === 1
          ? tools.map(entry)
          : [...categories].map(([name, list]) => ({ label: name, items: list.map(entry) }));
    return [
      {
        label: t('command.addBlock'),
        items: [
          {
            label: t('command.search'),
            shortcut: 'Shift+Space',
            run: () => {
              setAddAt(at);
            },
          },
          'separator',
          { label: t('command.tools'), items: toolEntries },
          { label: t('command.control'), items: controls.map(entry) },
        ],
      },
      { label: t('command.addNote'), run: add({ kind: 'note' }) },
      'separator',
      commandItem(
        t('command.paste'),
        can(commands.paste.enabled, () => {
          pasteClip(at);
        }),
        'Ctrl+V',
      ),
      commandItem(t('command.selectAll'), commands.selectAll, 'Ctrl+A'),
      commandItem(t('command.deselectAll'), commands.deselectAll, 'Esc'),
      'separator',
      { label: t('command.arrange'), items: arrangeEntries(commands) },
      { label: t('menu.scale'), items: scaleEntries(commands) },
      { label: t('menu.options'), items: optionsEntries(commands) },
    ];
  }

  /** Zooms to the box drawn for Scale to rectangle. */
  function finishRectangle(): void {
    const box = rectangle;
    setRectangle(undefined);
    const area = container.current?.getBoundingClientRect();
    if (box?.from === undefined || box.to === undefined || area === undefined) return;
    const width = Math.abs(box.to.x - box.from.x);
    const height = Math.abs(box.to.y - box.from.y);
    if (width < RECTANGLE_MIN || height < RECTANGLE_MIN) return;
    const corner = flow.screenToFlowPosition({
      x: area.left + Math.min(box.from.x, box.to.x),
      y: area.top + Math.min(box.from.y, box.to.y),
    });
    const far = flow.screenToFlowPosition({
      x: area.left + Math.max(box.from.x, box.to.x),
      y: area.top + Math.max(box.from.y, box.to.y),
    });
    void flow.fitBounds(
      { x: corner.x, y: corner.y, width: far.x - corner.x, height: far.y - corner.y },
      { padding: 0 },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.metaKey || isTyping(event.target)) return;
    // These also come from the frame around selected blocks, which takes focus after a selection
    // box, so they are not limited to the canvas itself.
    if (event.ctrlKey) {
      const shortcuts: Readonly<Record<string, CanvasCommand>> = {
        c: commands.copy,
        v: commands.paste,
        d: commands.duplicate,
        a: commands.selectAll,
        e: commands.toggleDisabled,
      };
      const letter = event.key.toLowerCase();
      if (letter === 'f' && !event.shiftKey) {
        event.preventDefault();
        setFind((current) => current ?? { query: '', index: 0 });
        setFindFocus((count) => count + 1);
        return;
      }
      const command = event.shiftKey ? undefined : shortcuts[letter];
      if (command === undefined) return;
      event.preventDefault();
      if (!command.enabled) return;
      // Ctrl+V pastes where the pointer is, when it is over the canvas.
      if (letter === 'v' && pointer.current !== undefined) {
        pasteClip(flow.screenToFlowPosition(pointer.current));
      } else {
        command.run();
      }
      return;
    }
    if (event.key === 'Escape' && rectangle !== undefined) {
      event.preventDefault();
      setRectangle(undefined);
      return;
    }
    if (event.key === 'Escape' && find !== undefined) {
      event.preventDefault();
      closeFind();
      return;
    }
    if (event.key === 'F2' && !readOnly) {
      const [only] = selected.size === 1 ? [...selected] : [];
      const id = focused ?? only;
      if (id !== undefined && blockOf(document, id) !== undefined) {
        event.preventDefault();
        onRenameBlock?.(id);
      }
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
    if (key === 'Escape' && selected.size > 0) {
      event.preventDefault();
      onSelect(new Set());
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
    if (choice.kind === 'run-automation' && choice.automation === automationId) {
      announce(t('canvas.callsItself'));
      return;
    }
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
        findPort(event.clientX, event.clientY, event.buttons !== 0);
      }}
      onMouseLeave={() => {
        pointer.current = undefined;
        forgetPort();
      }}
      onKeyDown={onKeyDown}
    >
      <p id={`${prefix}-help`} className="visually-hidden">
        {t(readOnly ? 'canvas.keysRun' : 'canvas.keys')}
      </p>
      <div className="visually-hidden" role="status" aria-live="polite" data-testid="announcer">
        {announcement}
      </div>
      {find === undefined ? null : (
        <div className="canvas-find" role="search" data-testid="canvas-find">
          <input
            ref={findField}
            value={find.query}
            spellCheck={false}
            aria-label={t('canvas.find')}
            placeholder={t('canvas.findPlaceholder')}
            onChange={(event) => {
              setFind({ query: event.target.value, index: 0 });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeFind();
              } else if (event.key === 'Enter') {
                event.preventDefault();
                stepFind(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="canvas-find-count" data-testid="canvas-find-count" aria-live="polite">
            {find.query.trim() === ''
              ? ''
              : matches.length === 0
                ? t('canvas.findNone')
                : t('canvas.findCount', {
                    number: Math.min(find.index, matches.length - 1) + 1,
                    count: matches.length,
                  })}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label={t('canvas.findPrevious')}
            title={t('canvas.findPrevious')}
            disabled={matches.length === 0}
            onClick={() => {
              stepFind(-1);
            }}
          >
            <ChevronUp className="icon" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('canvas.findNext')}
            title={t('canvas.findNext')}
            disabled={matches.length === 0}
            onClick={() => {
              stepFind(1);
            }}
          >
            <ChevronDown className="icon" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('canvas.findClose')}
            title={t('canvas.findClose')}
            onClick={closeFind}
          >
            <X className="icon" aria-hidden="true" />
          </button>
        </div>
      )}
      <RightAnglesContext value={rightAngles}>
        <CanvasActionsContext value={actions}>
          <PortLayoutsContext value={portLayouts}>
            <InputTonesContext value={tones}>
              <PortHoverContext value={portHover}>
                <LoopRoundsContext value={readOnly ? onChooseRound : undefined}>
                  <ReactFlow
                    nodes={nodes}
                    edges={shownEdges}
                    onMove={forgetPort}
                    onEdgeMouseEnter={(_event, edge) => {
                      // As its line does, the end of a connection lights up only where it can be edited.
                      if (!readOnly) setHoveredEdge(edge.id);
                    }}
                    onEdgeMouseLeave={() => {
                      setHoveredEdge(undefined);
                    }}
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
                      if (node.type === 'block' && onOpenCall?.(node.id) === true) return;
                      if (readOnly) {
                        if (node.type === 'block' || node.type === 'loop') onOpenBlock?.(node.id);
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
                      setMenu(undefined);
                      setPaneMenu({
                        x: event.clientX,
                        y: event.clientY,
                        at: placed(
                          flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
                        ),
                      });
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
                    minZoom={MIN_ZOOM}
                    maxZoom={MAX_ZOOM}
                    proOptions={{ hideAttribution: true }}
                    snapToGrid={snapToGrid}
                    snapGrid={[GRID, GRID]}
                  >
                    {showGrid ? <Background gap={GRID} /> : null}
                    {showNavigator ? (
                      <MiniMap pannable zoomable ariaLabel={t('canvas.overview')} />
                    ) : null}
                    <Controls showInteractive={false} />
                    {children}
                  </ReactFlow>
                </LoopRoundsContext>
              </PortHoverContext>
            </InputTonesContext>
          </PortLayoutsContext>
        </CanvasActionsContext>
      </RightAnglesContext>
      {hoveredPort === undefined || hoveredBlock === undefined ? null : (
        <PortTooltip
          text={portText(
            hoveredBlock.type,
            hoveredPort.input ? { input: true } : { input: false, output: hoveredPort.port },
          )}
          box={hoveredPort.box}
          side={hoveredPort.side}
        />
      )}
      {rectangle === undefined ? null : (
        <div
          className="scale-rectangle"
          data-testid="scale-rectangle"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const area = event.currentTarget.getBoundingClientRect();
            const point = { x: event.clientX - area.left, y: event.clientY - area.top };
            setRectangle({ from: point, to: point });
          }}
          onPointerMove={(event) => {
            if (rectangle.from === undefined) return;
            const area = event.currentTarget.getBoundingClientRect();
            setRectangle({
              from: rectangle.from,
              to: { x: event.clientX - area.left, y: event.clientY - area.top },
            });
          }}
          onPointerUp={finishRectangle}
        >
          {rectangle.from === undefined || rectangle.to === undefined ? null : (
            <div
              className="scale-rectangle-box"
              style={{
                left: Math.min(rectangle.from.x, rectangle.to.x),
                top: Math.min(rectangle.from.y, rectangle.to.y),
                width: Math.abs(rectangle.to.x - rectangle.from.x),
                height: Math.abs(rectangle.to.y - rectangle.from.y),
              }}
            />
          )}
        </div>
      )}
      {menu === undefined ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('canvas.menu', { name: nameOf(menu.id) })}
          items={itemMenu(menu.id)}
          onClose={() => {
            setMenu(undefined);
            container.current?.focus();
          }}
        />
      )}
      {paneMenu === undefined ? null : (
        <ContextMenu
          x={paneMenu.x}
          y={paneMenu.y}
          label={t('command.canvasMenu')}
          items={canvasMenu(paneMenu.at)}
          onClose={() => {
            setPaneMenu(undefined);
            container.current?.focus();
          }}
        />
      )}
      {addAt === undefined ? null : (
        <AddDialog
          title={t('canvas.addHereTitle')}
          choices={[
            ...library,
            {
              choice: { kind: 'note' },
              label: t('canvas.kindNote'),
              icon: <StickyNote className="icon" aria-hidden="true" />,
            },
          ]}
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
      {dialog?.kind === 'replace' && dialogBlock !== undefined ? (
        <AddDialog
          title={t('canvas.replaceTitle', { name: nameOf(dialogBlock.id) })}
          choices={library.filter(({ choice }) => choice.kind === 'run')}
          onPick={(choice) => {
            setDialog(undefined);
            if (choice.kind !== 'run') return;
            const replaced = onReplaceBlock?.(dialogBlock.id, choice);
            container.current?.focus();
            if (replaced !== undefined) {
              setFocused(replaced);
              announce(t('canvas.replaced', { name: replaced }));
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
