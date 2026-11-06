import { Circle, CircleCheck, CircleSlash, CircleX, LoaderCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import type { ToolState } from '../tools/run-state.js';

const STATES: Readonly<Record<ToolState, { icon: LucideIcon; label: MessageKey }>> = {
  idle: { icon: Circle, label: 'state.idle' },
  running: { icon: LoaderCircle, label: 'state.running' },
  completed: { icon: CircleCheck, label: 'state.completed' },
  failed: { icon: CircleX, label: 'state.failed' },
  cancelled: { icon: CircleSlash, label: 'state.cancelled' },
};

/** The same icon family, so a state reads by shape even with no color at all. */
export function RunStateIcon({ state }: { readonly state: ToolState }) {
  const Icon = STATES[state].icon;
  return <Icon className={`icon state-${state}`} aria-hidden="true" />;
}

interface RunStateBadgeProps {
  readonly state: ToolState;
  /** Replaces the state's own word, as in a count of running tasks. */
  readonly label?: string;
}

/** A run state, shown the same way everywhere: icon and word together, never color alone. */
export function RunStateBadge({ state, label }: RunStateBadgeProps) {
  return (
    <span className={`state-badge state-${state}`} data-state={state}>
      <RunStateIcon state={state} />
      {label ?? t(STATES[state].label)}
    </span>
  );
}

/** The state as text, for a compact list row that shows only the icon. */
export function runStateLabel(state: ToolState): string {
  return t(STATES[state].label);
}
