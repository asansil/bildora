import { createContext, useCallback, useEffect, useState } from 'react';
import type { ScheduleStatusView } from '../../shared/ipc-contract.js';

const api = window.bildora;
/** How often the next and last run are read again while the automation is open. */
const REFRESH_MS = 60_000;

/** How the open automation's schedule stands on this computer, and how to change it. */
export interface ScheduleStatus {
  /** Unknown until read, and for an automation not saved yet. */
  readonly status: ScheduleStatusView | undefined;
  /** Set when this computer cannot schedule, so there is no state to read. */
  readonly unavailable: boolean;
  /** Set while a change is on its way, which may wait for an administrator prompt. */
  readonly busy: boolean;
  /** Saves the automation first when it has changes, so the task follows what is on screen. */
  readonly set: (on: boolean, signedOut?: boolean) => void;
}

export const ScheduleStatusContext = createContext<ScheduleStatus | undefined>(undefined);

/**
 * Reads an automation's schedule state when it opens and after each save, and every minute after,
 * so the next run moves on as runs happen.
 */
export function useScheduleStatus(
  automationId: string | undefined,
  savedRevision: unknown,
  saveFirst: () => Promise<void>,
  onError: (error: unknown) => void,
): ScheduleStatus {
  const [status, setStatus] = useState<ScheduleStatusView>();
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (automationId === undefined) {
      setStatus(undefined);
      return undefined;
    }
    let current = true;
    const read = (): void => {
      void api
        .scheduleStatus(automationId)
        .then((next) => {
          if (!current) return;
          setStatus(next);
          setUnavailable(false);
        })
        .catch(() => {
          // A computer that cannot schedule shows no state; the editor still edits the file.
          if (!current) return;
          setStatus(undefined);
          setUnavailable(true);
        });
    };
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [automationId, savedRevision]);

  const set = useCallback(
    (on: boolean, signedOut?: boolean) => {
      if (automationId === undefined) return;
      setBusy(true);
      void saveFirst()
        .then(() => api.setSchedule(automationId, on, signedOut))
        .then(setStatus)
        .catch(onError)
        .finally(() => {
          setBusy(false);
        });
    },
    [automationId, saveFirst, onError],
  );

  return { status, unavailable, busy, set };
}
