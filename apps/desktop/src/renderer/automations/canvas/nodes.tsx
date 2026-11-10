import { memo } from 'react';
import { Handle, NodeResizer, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { TriangleAlert } from 'lucide-react';
import { ERROR_OUTPUT } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { StepStateView } from '../../../shared/ipc-contract.js';
import { RunStateIcon } from '../../shell/RunStateBadge.js';
import type { BlockKind } from './flow-document.js';

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
  /** What a screen reader says: the block, then where its outputs lead. */
  readonly description: string;
  /** The category logo of a Run tool block's tool, as a data URL. */
  readonly logo?: string;
  readonly problems: number;
  /** Set in the run view. */
  readonly state?: StepStateView;
  /** A line under the name in the run view, such as a progress message or a failure. */
  readonly detail?: string;
}

export type BlockNode = Node<BlockNodeData, 'block'>;

/** Outputs on the right edge, each labeled in words, with Error drawn dashed. */
function Outputs({ outputs, labelled }: { outputs: readonly OutputView[]; labelled: boolean }) {
  return (
    <>
      {outputs.map((output, index) => (
        <Handle
          key={output.id}
          id={output.id}
          type="source"
          position={Position.Right}
          className={`handle ${output.id === ERROR_OUTPUT ? 'handle--error' : 'handle--out'}`}
          style={{ top: `${String(((index + 1) / (outputs.length + 1)) * 100)}%` }}
          aria-label={t('canvas.outputHandle', { output: output.label })}
          data-output={output.id}
        >
          {labelled ? <span className="handle-label">{output.label}</span> : null}
        </Handle>
      ))}
    </>
  );
}

export const BlockNodeView = memo(function BlockNodeView({ data, selected }: NodeProps<BlockNode>) {
  const narrow = data.kind === 'parallel' || data.kind === 'join';
  const labelled = data.outputs.length > 1 && data.kind !== 'parallel';
  const classes = [
    'block',
    `block--${data.kind}`,
    selected ? 'is-selected' : '',
    data.state === undefined ? '' : `is-${data.state}`,
  ].join(' ');
  return (
    <div
      id={data.domId}
      role="group"
      aria-label={data.description}
      className={classes}
      data-testid="canvas-block"
      data-kind={data.kind}
      data-state={data.state}
    >
      {data.kind === 'start' ? null : (
        <Handle id="in" type="target" position={Position.Left} className="handle handle--in" />
      )}
      {data.state === undefined ? null : (
        <span className="block-state">
          <RunStateIcon state={data.state} />
        </span>
      )}
      {narrow ? (
        <span className="block-glyph" aria-hidden="true">
          {data.kindLabel}
        </span>
      ) : (
        <span className="block-text">
          <span className="block-name">
            {data.logo === undefined ? null : (
              <img className="block-logo" src={data.logo} alt="" draggable={false} />
            )}
            <span className="truncate" title={data.name}>
              {data.name}
            </span>
          </span>
          <span className="block-kind truncate">{data.detail ?? data.kindLabel}</span>
        </span>
      )}
      {data.problems > 0 ? (
        <span className="block-problem" title={t('canvas.blockProblems', { count: data.problems })}>
          <TriangleAlert className="icon" aria-hidden="true" />
        </span>
      ) : null}
      <Outputs outputs={data.outputs} labelled={labelled} />
    </div>
  );
});

export interface NoteNodeData extends Record<string, unknown> {
  readonly text: string;
  readonly placeholder: string;
  readonly readOnly: boolean;
}

export type NoteNode = Node<NoteNodeData, 'note'>;

/** Text on the canvas. It is written in the settings panel, so the keyboard reaches it too. */
export const NoteNodeView = memo(function NoteNodeView({ data, selected }: NodeProps<NoteNode>) {
  return (
    <div className={`note${selected ? ' is-selected' : ''}`} data-testid="canvas-note">
      {data.readOnly ? null : <NodeResizer isVisible={selected} minWidth={120} minHeight={48} />}
      <p className={data.text === '' ? 'note-text is-empty' : 'note-text'}>
        {data.text === '' ? data.placeholder : data.text}
      </p>
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
