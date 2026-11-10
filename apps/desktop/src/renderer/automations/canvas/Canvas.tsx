import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from '@xyflow/react';
import type {
  Connection,
  Edge,
  EdgeChange,
  IsValidConnection,
  NodeChange,
  OnConnectStart,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './canvas.css';
import { ERROR_OUTPUT, connectionOutput, outputsOf, validTargets } from '@bildora/protocol';
import type { AutomationGroup, AutomationPosition } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { StepRunView, TakenPathView } from '../../../shared/ipc-contract.js';
import { kindLabel, outputLabel } from './block-text.js';
import {
  NOTE_SIZE,
  blockOf,
  connect,
  moveItems,
  removeItems,
  sizeOf,
  updateNote,
} from './flow-document.js';
import { AddDialog, ConnectDialog } from './KeyboardDialogs.js';
import type { LibraryChoice } from './KeyboardDialogs.js';
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
/** How far an arrow key moves a selected block. */
const NUDGE = 16;
export const LIBRARY_DRAG_TYPE = 'application/x-bildora-block';

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
  readonly onDrop: (choice: NewBlock, at: AutomationPosition) => void;
  /** What A offers to add after the focused block. */
  readonly library: readonly LibraryChoice[];
  /** Adds a block after another, and gives the new block's id. */
  readonly onAddAfter: (anchor: string, choice: NewBlock) => string | undefined;
  /** Moves keyboard focus to a block, as the blocks list asks. Changes each time it is asked. */
  readonly focusRequest?: { readonly id: string; readonly count: number };
  readonly children?: ReactNode;
}

function edgeId(from: string, output: string, to: string): string {
  return `${from}\u0000${output}\u0000${to}`;
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
      targets?.has(node.id) === true ? 'is-target' : '',
      focused === node.id ? 'is-focused' : '',
    ]
      .join(' ')
      .trim();
    if (node.selected === isSelected && (node.className ?? '') === className) return node;
    return { ...node, selected: isSelected, className };
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
  onDrop,
  library,
  onAddAfter,
  focusRequest,
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
  const flow = useReactFlow<CanvasNode>();
  const readOnly = run !== undefined;
  const [targets, setTargets] = useState<ReadonlySet<string> | undefined>(undefined);
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
  // Blocks move here while dragged, and start again from the document whenever it changes.
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
    setNodes(marked(from.built === built ? nodes : built, selected, targets, focused));
  }

  const taken = useMemo(
    () => new Set(run?.paths.map(({ from, output, to }) => edgeId(from, output, to))),
    [run],
  );
  const builtEdges = useMemo(
    () =>
      document.connections.map((connection): Edge => {
        const output = connectionOutput(connection);
        const id = edgeId(connection.from, output, connection.to);
        const classes = [
          output === ERROR_OUTPUT ? 'edge--error' : '',
          taken.has(id) ? 'edge--taken' : '',
        ].join(' ');
        return {
          id,
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
    [document.connections, names, taken, readOnly],
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
      if (Object.keys(moved).length > 0 || resized.length > 0) {
        onChange((current) => {
          let updated = moveItems(current, moved);
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

  const announce = useCallback((message: string) => {
    // Clearing first makes the same message speak again.
    setAnnouncement('');
    requestAnimationFrame(() => {
      setAnnouncement(message);
    });
  }, []);

  const nameOf = useCallback((id: string) => names.get(id) ?? id, [names]);

  /** Deletes what is selected, or else the focused block, and keeps focus on the canvas. */
  function deleteChosen(): void {
    const ids = new Set(selected);
    if (ids.size === 0 && focused !== undefined) ids.add(focused);
    const cut = new Set(edges.filter((edge) => edge.selected === true).map(({ id }) => id));
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

  const onConnectStart: OnConnectStart = useCallback(
    (_event, { nodeId, handleId, handleType }) => {
      if (nodeId === null || handleType !== 'source' || handleId === null) return;
      setTargets(new Set(validTargets(document, nodeId, handleId)));
    },
    [document],
  );

  const onConnectEnd = useCallback(() => {
    setTargets(undefined);
  }, []);

  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      const output = connection.sourceHandle ?? 'next';
      return (
        targets?.has(connection.target) ??
        validTargets(document, connection.source, output).includes(connection.target)
      );
    },
    [targets, document],
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

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== container.current || event.altKey || event.metaKey) return;
    if (event.ctrlKey) return;
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
        const at = document.positions[current];
        if (at === undefined) return;
        const step = {
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
        }[key];
        onChange(
          (flowDocument) =>
            moveItems(flowDocument, {
              [current]: { x: at.x + (step[0] ?? 0) * NUDGE, y: at.y + (step[1] ?? 0) * NUDGE },
            }),
          `move:${current}`,
        );
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
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      deleteChosen();
    }
  }

  useEffect(() => {
    if (reveal !== undefined) reveal_(reveal.id, reveal.center === true);
  }, [reveal, reveal_]);

  function dragOver(event: DragEvent): void {
    if (readOnly || !event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function drop(event: DragEvent): void {
    const text = event.dataTransfer.getData(LIBRARY_DRAG_TYPE);
    if (readOnly || text === '') return;
    event.preventDefault();
    const choice = JSON.parse(text) as NewBlock;
    onDrop(choice, flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
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
      className="flow-canvas"
      data-testid="canvas"
      data-focused={focused}
      onDragOver={dragOver}
      onDrop={drop}
      onKeyDown={onKeyDown}
    >
      <p id={`${prefix}-help`} className="visually-hidden">
        {t(readOnly ? 'canvas.keysRun' : 'canvas.keys')}
      </p>
      <div className="visually-hidden" role="status" aria-live="polite" data-testid="announcer">
        {announcement}
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_event, node) => {
          setFocused(node.id);
          setMoving(false);
        }}
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
      >
        <Background gap={16} />
        <MiniMap pannable zoomable ariaLabel={t('canvas.overview')} />
        <Controls showInteractive={false} />
        {children}
      </ReactFlow>
      {dialog?.kind === 'add' && dialogBlock !== undefined ? (
        <AddDialog
          anchorName={nameOf(dialogBlock.id)}
          choices={library}
          onPick={(choice) => {
            setDialog(undefined);
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
