import { t } from '../../shared/i18n/translate.js';
import type { HistoryStatus } from '../../shared/ipc-contract.js';
import type { ToolState } from '../tools/run-state.js';

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
