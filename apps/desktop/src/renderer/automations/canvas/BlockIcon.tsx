import {
  Clock,
  GitBranch,
  GitFork,
  GitMerge,
  Play,
  ListOrdered,
  RefreshCw,
  Split,
  UserRound,
  Workflow,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ToolView } from '../../../shared/ipc-contract.js';
import { ProgramIcon } from '../../shell/ProgramIcon.js';
import type { BlockKind } from './flow-document.js';

/** The families blocks are colored by. */
export type BlockFamily = 'start' | 'tool' | 'condition' | 'parallel' | 'wait' | 'loop';

const FAMILIES: Readonly<Record<BlockKind, BlockFamily>> = {
  start: 'start',
  run: 'tool',
  if: 'condition',
  switch: 'condition',
  parallel: 'parallel',
  join: 'parallel',
  'wait-for-time': 'wait',
  'wait-for-manual-action': 'wait',
  for: 'loop',
  while: 'loop',
  'run-automation': 'tool',
};

export function familyOf(kind: BlockKind): BlockFamily {
  return FAMILIES[kind];
}

const ICONS: Readonly<Record<Exclude<BlockKind, 'run'>, LucideIcon>> = {
  start: Play,
  if: GitBranch,
  switch: Split,
  parallel: GitFork,
  join: GitMerge,
  'wait-for-time': Clock,
  'wait-for-manual-action': UserRound,
  for: ListOrdered,
  while: RefreshCw,
  'run-automation': Workflow,
};

/**
 * A block's icon: the program's own for a tool block, the kind's otherwise. Its color comes from the
 * family class around it.
 */
export function BlockIcon({
  kind,
  tool,
  className = 'icon',
}: {
  readonly kind: BlockKind;
  readonly tool?: ToolView | undefined;
  readonly className?: string;
}) {
  if (kind === 'run') {
    return tool === undefined ? (
      <Wrench className={className} aria-hidden="true" />
    ) : (
      <ProgramIcon tool={tool} className={className} />
    );
  }
  const Icon = ICONS[kind];
  return <Icon className={className} aria-hidden="true" />;
}

/** A block's icon on its family's tint, as lists of blocks show it beside a name. */
export function BlockSwatch({
  kind,
  tool,
  size = 'small',
}: {
  readonly kind: BlockKind;
  readonly tool?: ToolView | undefined;
  readonly size?: 'small' | 'large';
}) {
  return (
    <span
      className={`block-swatch block-swatch--${size} family-${familyOf(kind)}`}
      aria-hidden="true"
    >
      <BlockIcon kind={kind} tool={tool} />
    </span>
  );
}
