import type { StartBlock } from './automation.js';

/** Why a schedule cannot run, even if it is on. */
export type ScheduleBlocker =
  /** The Start block starts with a button. */
  | 'not-scheduled'
  /** A required input has no default, and a scheduled start has nobody to ask. */
  | 'input-without-default'
  /** A schedule that runs once is set for a time already gone. */
  | 'past';

/**
 * Why a Start block's schedule cannot run at `now`, if it cannot. It reads only the block, so the
 * editor can tell while the block is being edited, before anything is saved.
 */
export function startBlocker(
  start: StartBlock | undefined,
  now: Date,
): ScheduleBlocker | undefined {
  const schedule = start?.mode === 'scheduled' ? start.schedule : undefined;
  if (start === undefined || schedule === undefined) return 'not-scheduled';
  if (
    (start.inputs ?? []).some((input) => input.required === true && input.default === undefined)
  ) {
    return 'input-without-default';
  }
  if (schedule.repeat === 'once') {
    const [hours = 0, minutes = 0] = schedule.time.split(':').map(Number);
    const [year = 0, month = 1, day = 1] = schedule.date.split('-').map(Number);
    if (new Date(year, month - 1, day, hours, minutes).getTime() <= now.getTime()) return 'past';
  }
  return undefined;
}
