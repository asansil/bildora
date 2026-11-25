import { t } from '../../shared/i18n/translate.js';
import type { MessageKey } from '../../shared/i18n/translate.js';
import type { HistoryStatus } from '../../shared/ipc-contract.js';
import type { ToolState } from '../tools/run-state.js';

type Trigger = 'app' | 'cli' | 'schedule';

/** Where an automation run came from, as the automation's Past runs list says it. */
export const TRIGGER_LABELS: Readonly<Record<Trigger, MessageKey>> = {
  app: 'automation.fromApp',
  cli: 'automation.fromCli',
  schedule: 'automation.fromSchedule',
};

/** Where an automation run came from, as its history detail says it. */
export const TRIGGER_NAMES: Readonly<Record<Trigger, MessageKey>> = {
  app: 'history.fromApp',
  cli: 'history.fromCli',
  schedule: 'history.fromSchedule',
};

/** A history row's title, which says when a run did not come from the app. */
export const TRIGGER_ROWS: Readonly<Record<Trigger, MessageKey>> = {
  app: 'history.automationRow',
  cli: 'history.automationRowCli',
  schedule: 'history.automationRowSchedule',
};

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** A run interrupted by Bildora closing reads as cancelled: nobody saw how it ended. */
export function historyState(status: HistoryStatus): ToolState {
  return status === 'interrupted' ? 'cancelled' : status;
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return t('history.noDuration');
  }
  const seconds = durationMs / MILLISECONDS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) {
    return t('history.seconds', { value: seconds.toFixed(1) });
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return t('history.minutes', {
      minutes,
      seconds: Math.round(seconds % SECONDS_PER_MINUTE),
    });
  }
  return t('history.hours', {
    hours: Math.floor(minutes / MINUTES_PER_HOUR),
    minutes: minutes % MINUTES_PER_HOUR,
  });
}

export function formatTime(startedAt: number): string {
  return new Date(startedAt).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'medium' });
}
