import { use, useId, useState } from 'react';
import type { ReactNode } from 'react';
import {
  SCHEDULE_DAYS,
  SCHEDULE_EVERY_HOURS_MAX,
  SCHEDULE_TIME_LIMIT_DEFAULT_MINUTES,
  SCHEDULE_TIME_LIMIT_MAX_MINUTES,
  startBlocker,
} from '@bildora/protocol';
import type { AutomationSchedule, ScheduleDay, StartBlock } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { ScheduleStatusView } from '../../../shared/ipc-contract.js';
import { RunStateBadge } from '../../shell/RunStateBadge.js';
import type { BlockState } from '../../shell/RunStateBadge.js';
import { without } from '../automation-draft.js';
import { ScheduleStatusContext } from '../schedule-status.js';
import { Select } from './fields.js';
import { PanelSection } from './PanelSection.js';

type Repeat = AutomationSchedule['repeat'];

const REPEATS: readonly Repeat[] = ['once', 'daily', 'weekly', 'hours'];
const MINUTES_PER_HOUR = 60;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** What a new schedule starts as. */
const FIRST_SCHEDULE: AutomationSchedule = { repeat: 'daily', time: '08:00' };
/** Task Scheduler's code for a task it ended, as it does when the time limit runs out. */
const ENDED_BY_SCHEDULER = 0x41306;
/** Exit codes of `bildora run`, as docs/scheduling.md lists them. */
const EXIT_STATES: Readonly<Record<number, BlockState>> = {
  0: 'completed',
  1: 'failed',
  3: 'completed',
  4: 'failed',
  5: 'failed',
  130: 'cancelled',
  [ENDED_BY_SCHEDULER]: 'cancelled',
};

const pad = (value: number): string => String(value).padStart(2, '0');

function tomorrow(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return `${String(next.getFullYear())}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

/** The schedule repeated another way, keeping its time and its settings. */
function repeated(schedule: AutomationSchedule, repeat: Repeat): AutomationSchedule {
  const time = schedule.repeat === 'hours' ? schedule.from : schedule.time;
  const shared = {
    ...(schedule.runMissed === undefined ? {} : { runMissed: schedule.runMissed }),
    ...(schedule.timeLimitMinutes === undefined
      ? {}
      : { timeLimitMinutes: schedule.timeLimitMinutes }),
  };
  switch (repeat) {
    case 'once':
      return { ...shared, repeat, date: tomorrow(), time };
    case 'daily':
      return { ...shared, repeat, time };
    case 'weekly':
      return { ...shared, repeat, days: ['mon'], time };
    case 'hours':
      return { ...shared, repeat, every: 4, from: time };
  }
}

/** A time field that applies only a whole `HH:MM`, so a half-typed time never reaches the file. */
function TimeField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="time"
        value={value}
        onChange={(event) => {
          if (TIME.test(event.target.value)) onChange(event.target.value);
        }}
      />
    </div>
  );
}

function DaysField({
  days,
  onChange,
}: {
  readonly days: readonly ScheduleDay[];
  readonly onChange: (days: ScheduleDay[]) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <span className="field-label" id={id}>
        {t('canvas.scheduleOn')}
      </span>
      <div className="schedule-days" role="group" aria-labelledby={id}>
        {SCHEDULE_DAYS.map((day) => {
          const on = days.includes(day);
          return (
            <button
              key={day}
              type="button"
              aria-pressed={on}
              aria-label={t(`canvas.dayLong.${day}`)}
              title={t(`canvas.dayLong.${day}`)}
              onClick={() => {
                // A weekly schedule keeps at least one day.
                if (on && days.length === 1) return;
                onChange(
                  SCHEDULE_DAYS.filter((item) => (item === day ? !on : days.includes(item))),
                );
              }}
            >
              {t(`canvas.day.${day}`).slice(0, 2)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EveryField({
  every,
  onChange,
}: {
  readonly every: number;
  readonly onChange: (every: number) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('canvas.scheduleEvery')}
      </label>
      <div className="field-row schedule-amount">
        <input
          id={id}
          type="number"
          min={1}
          max={SCHEDULE_EVERY_HOURS_MAX}
          value={every}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isInteger(next) && next >= 1 && next <= SCHEDULE_EVERY_HOURS_MAX) {
              onChange(next);
            }
          }}
        />
        <span>{t('canvas.scheduleHoursUnit')}</span>
      </div>
    </div>
  );
}

function LimitField({
  minutes,
  onChange,
}: {
  readonly minutes: number;
  readonly onChange: (minutes: number) => void;
}) {
  const id = useId();
  const [unit, setUnit] = useState<'minutes' | 'hours'>(
    minutes % MINUTES_PER_HOUR === 0 ? 'hours' : 'minutes',
  );
  const factor = unit === 'hours' ? MINUTES_PER_HOUR : 1;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('canvas.scheduleLimit')}
      </label>
      <div className="field-row schedule-amount">
        <input
          id={id}
          type="number"
          min={1}
          max={Math.floor(SCHEDULE_TIME_LIMIT_MAX_MINUTES / factor)}
          // Minutes that do not make whole hours show in minutes until the unit is chosen again.
          value={Number.isInteger(minutes / factor) ? minutes / factor : minutes}
          onChange={(event) => {
            const next = Number(event.target.value) * factor;
            if (Number.isInteger(next) && next >= 1 && next <= SCHEDULE_TIME_LIMIT_MAX_MINUTES) {
              onChange(next);
            }
          }}
        />
        <select
          aria-label={t('canvas.scheduleLimitUnit')}
          value={unit}
          onChange={(event) => {
            setUnit(event.target.value === 'hours' ? 'hours' : 'minutes');
          }}
        >
          <option value="minutes">{t('canvas.unit.minutes')}</option>
          <option value="hours">{t('canvas.unit.hours')}</option>
        </select>
      </div>
    </div>
  );
}

/** When the automation starts, as its file stores it. */
function StartsSection({
  block,
  onChange,
}: {
  readonly block: StartBlock;
  readonly onChange: (block: StartBlock) => void;
}) {
  const scheduled = block.mode === 'scheduled';
  const schedule = block.schedule ?? FIRST_SCHEDULE;
  const setSchedule = (next: AutomationSchedule): void => {
    onChange({ ...block, schedule: next });
  };
  const dateId = useId();
  return (
    <PanelSection id="start.starts" title={t('canvas.sectionStarts')}>
      <div className="segmented" role="group" aria-label={t('canvas.sectionStarts')}>
        <button
          type="button"
          aria-pressed={!scheduled}
          onClick={() => {
            onChange(without(block, 'mode'));
          }}
        >
          {t('canvas.startsWithRun')}
        </button>
        <button
          type="button"
          aria-pressed={scheduled}
          data-testid="starts-on-schedule"
          onClick={() => {
            onChange({ ...block, mode: 'scheduled', schedule });
          }}
        >
          {t('canvas.startsOnSchedule')}
        </button>
      </div>
      {scheduled ? (
        <>
          <Select
            label={t('canvas.scheduleRepeats')}
            value={schedule.repeat}
            options={REPEATS.map((repeat) => ({
              value: repeat,
              label: t(`canvas.repeat.${repeat}`),
            }))}
            onChange={(repeat) => {
              if (repeat !== schedule.repeat) setSchedule(repeated(schedule, repeat));
            }}
          />
          {schedule.repeat === 'once' ? (
            <div className="field">
              <label className="field-label" htmlFor={dateId}>
                {t('canvas.scheduleOn')}
              </label>
              <input
                id={dateId}
                type="date"
                value={schedule.date}
                onChange={(event) => {
                  if (DATE.test(event.target.value)) {
                    setSchedule({ ...schedule, date: event.target.value });
                  }
                }}
              />
            </div>
          ) : null}
          {schedule.repeat === 'weekly' ? (
            <DaysField
              days={schedule.days}
              onChange={(days) => {
                setSchedule({ ...schedule, days });
              }}
            />
          ) : null}
          {schedule.repeat === 'hours' ? (
            <>
              <EveryField
                every={schedule.every}
                onChange={(every) => {
                  setSchedule({ ...schedule, every });
                }}
              />
              <TimeField
                label={t('canvas.scheduleFrom')}
                value={schedule.from}
                onChange={(from) => {
                  setSchedule({ ...schedule, from });
                }}
              />
            </>
          ) : (
            <TimeField
              label={t('canvas.scheduleAt')}
              value={schedule.time}
              onChange={(time) => {
                setSchedule({ ...schedule, time });
              }}
            />
          )}
          <div className="field">
            <label className="field-check">
              <input
                type="checkbox"
                checked={schedule.runMissed ?? true}
                onChange={(event) => {
                  setSchedule(
                    event.target.checked
                      ? (without(schedule, 'runMissed') as AutomationSchedule)
                      : { ...schedule, runMissed: false },
                  );
                }}
              />
              {t('canvas.scheduleRunMissed')}
            </label>
          </div>
          <LimitField
            minutes={schedule.timeLimitMinutes ?? SCHEDULE_TIME_LIMIT_DEFAULT_MINUTES}
            onChange={(minutes) => {
              setSchedule(
                minutes === SCHEDULE_TIME_LIMIT_DEFAULT_MINUTES
                  ? (without(schedule, 'timeLimitMinutes') as AutomationSchedule)
                  : { ...schedule, timeLimitMinutes: minutes },
              );
            }}
          />
        </>
      ) : (
        <p className="field-hint">{t('canvas.scheduleButtonHint')}</p>
      )}
    </PanelSection>
  );
}

const formatWhen = (iso: string): string =>
  new Date(iso).toLocaleString('en', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

function LastResult({ code }: { readonly code: number }) {
  const state = EXIT_STATES[code];
  return state === undefined ? (
    <span>{t('canvas.scheduleExitCode', { code })}</span>
  ) : (
    <RunStateBadge state={state} />
  );
}

function Times({ status }: { readonly status: ScheduleStatusView }) {
  return (
    <dl className="schedule-times" data-testid="schedule-times">
      <div>
        <dt>{t('canvas.scheduleNextRun')}</dt>
        <dd>
          {status.nextRun === undefined
            ? t('canvas.scheduleNoNextRun')
            : formatWhen(status.nextRun)}
        </dd>
      </div>
      <div>
        <dt>{t('canvas.scheduleLastRun')}</dt>
        <dd>
          {status.running ? (
            <RunStateBadge state="running" label={t('canvas.scheduleRunningNow')} />
          ) : status.lastRun === undefined ? (
            t('canvas.scheduleNeverRan')
          ) : (
            <>
              {formatWhen(status.lastRun)}
              {status.lastResult === undefined ? null : (
                <>
                  {' · '}
                  <LastResult code={status.lastResult} />
                </>
              )}
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}

function Notice({
  text,
  fix,
  action,
  onAction,
  busy,
}: {
  readonly text: string;
  readonly fix?: string;
  readonly action?: string;
  readonly onAction?: () => void;
  readonly busy: boolean;
}) {
  return (
    <div className="schedule-notice" role="status" data-testid="schedule-notice">
      <p>{text}</p>
      {fix === undefined ? null : <p className="field-hint">{fix}</p>}
      {action === undefined ? null : (
        <button type="button" className="primary" disabled={busy} onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

/** A card at the top of the panel with the switch, its warnings and its times. */
function ScheduleCard({ children }: { readonly children: ReactNode }) {
  return (
    <div className="schedule-card" data-testid="schedule-card">
      {children}
    </div>
  );
}

/**
 * Whether the schedule is active on this computer, and how its task stands. Turning it on is not
 * part of the automation's file, so a shared or imported copy starts off wherever it goes.
 */
function ScheduleStatus({ block }: { readonly block: StartBlock }) {
  const schedule = use(ScheduleStatusContext);
  const switchId = useId();
  // Where the switch was moved to, shown at once while Windows creates or removes the task.
  const [pending, setPending] = useState<boolean>();
  const status = schedule?.status;
  // The tab gives no schedule state to an automation that has no file yet.
  if (schedule === undefined) {
    return (
      <ScheduleCard>
        <p className="field-hint">{t('canvas.scheduleSaveFirst')}</p>
      </ScheduleCard>
    );
  }
  if (status === undefined) {
    return schedule.unavailable ? (
      <ScheduleCard>
        <p className="field-hint">{t('canvas.scheduleUnavailable')}</p>
      </ScheduleCard>
    ) : null;
  }
  const { busy, set } = schedule;
  const on = status.kind !== 'off';
  const shown = busy && pending !== undefined ? pending : on;
  // The block as edited decides, not the saved file, so a problem shows before the switch is tried
  // and goes away as soon as it is fixed. Saving brings the task's state to the same answer.
  const blocker = startBlocker(block, new Date());
  const again = (): void => {
    set(true, status.signedOut);
  };
  return (
    <ScheduleCard>
      <div className="schedule-switch">
        <span className="schedule-switch-label" id={switchId}>
          {t('canvas.scheduleActive')}
        </span>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={shown}
          aria-labelledby={switchId}
          aria-busy={busy}
          data-testid="schedule-switch"
          // Off and blocked, there is nothing to turn on until the block is fixed.
          disabled={!on && blocker !== undefined}
          onClick={() => {
            if (busy) return;
            setPending(!on);
            set(!on, on ? undefined : status.signedOut);
          }}
        />
      </div>
      <p className="field-hint">{t('canvas.scheduleActiveHint')}</p>
      {blocker === undefined ? null : (
        <Notice
          text={t(`canvas.scheduleBlocked.${blocker}`)}
          fix={t(`canvas.scheduleBlocked.${blocker}Fix`)}
          busy={busy}
        />
      )}
      {status.kind === 'missing' ? (
        <Notice
          text={t('canvas.scheduleMissing')}
          action={t('canvas.scheduleCreateAgain')}
          onAction={again}
          busy={busy}
        />
      ) : null}
      {status.kind === 'changed' ? (
        <Notice
          text={t('canvas.scheduleChanged')}
          action={t('canvas.scheduleRestore')}
          onAction={again}
          busy={busy}
        />
      ) : null}
      {status.kind === 'outdated' ? (
        <Notice
          text={t('canvas.scheduleOutdated')}
          action={t('canvas.scheduleUpdate')}
          onAction={again}
          busy={busy}
        />
      ) : null}
      {status.kind === 'on' || status.kind === 'changed' ? <Times status={status} /> : null}
      <div className="field">
        <label className="field-check">
          <input
            type="checkbox"
            checked={status.signedOut}
            disabled={!on || busy}
            onChange={(event) => {
              set(true, event.target.checked);
            }}
          />
          {t('canvas.scheduleSignedOut')}
        </label>
        <p className="field-hint">{t('canvas.scheduleSignedOutHint')}</p>
      </div>
    </ScheduleCard>
  );
}

/** How the automation starts: with Run, or on a schedule that this computer may run. */
export function StartSettings({
  block,
  onChange,
}: {
  readonly block: StartBlock;
  readonly onChange: (block: StartBlock) => void;
}) {
  return (
    <>
      {block.mode === 'scheduled' ? <ScheduleStatus block={block} /> : null}
      <StartsSection block={block} onChange={onChange} />
    </>
  );
}
