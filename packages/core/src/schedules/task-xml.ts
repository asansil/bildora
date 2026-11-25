import {
  SCHEDULE_DAYS,
  SCHEDULE_TIME_LIMIT_DEFAULT_MINUTES,
  SCHEDULE_TIME_LIMIT_MAX_MINUTES,
} from '@bildora/protocol';
import type { AutomationSchedule, ScheduleDay } from '@bildora/protocol';

/** The program a task starts, and the text of its arguments as Task Scheduler keeps it. */
export interface TaskCommand {
  readonly program: string;
  readonly arguments: string;
}

/** Everything about a task that Bildora decides, so that two can be compared. */
export interface TaskDefinition {
  readonly schedule: AutomationSchedule;
  readonly command: TaskCommand;
  /** Runs when nobody is signed in, in the mode that stores no password. */
  readonly signedOut: boolean;
}

const TASK_NAMESPACE = 'http://schemas.microsoft.com/windows/2004/02/mit/task';

const DAY_ELEMENTS: Readonly<Record<ScheduleDay, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;
const SECONDS_PER_MINUTE = 60;

/** Joins arguments into one command line, quoting the ones Windows would otherwise split. */
export function commandLineOf(args: readonly string[]): string {
  return args
    .map((arg) => (arg !== '' && !/[\s"]/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`))
    .join(' ');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const pad = (value: number): string => String(value).padStart(2, '0');

function localDate(moment: Date): string {
  return `${String(moment.getFullYear())}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

/**
 * The first day a repeating trigger counts from: today, or tomorrow when today's time has gone by.
 * A start already in the past could count as missed and run the moment the task is saved.
 */
function firstDay(time: string, now: Date): string {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
  if (today.getTime() > now.getTime()) return localDate(today);
  return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
}

function triggerXml(schedule: AutomationSchedule, now: Date): string {
  switch (schedule.repeat) {
    case 'once':
      return `<TimeTrigger><StartBoundary>${schedule.date}T${schedule.time}:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>`;
    case 'daily':
      return `<CalendarTrigger><StartBoundary>${firstDay(schedule.time, now)}T${schedule.time}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`;
    case 'weekly': {
      const days = SCHEDULE_DAYS.filter((day) => schedule.days.includes(day))
        .map((day) => `<${DAY_ELEMENTS[day]} />`)
        .join('');
      return `<CalendarTrigger><StartBoundary>${firstDay(schedule.time, now)}T${schedule.time}:00</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><DaysOfWeek>${days}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>`;
    }
    case 'hours':
      return `<CalendarTrigger><Repetition><Interval>PT${String(schedule.every)}H</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${firstDay(schedule.from, now)}T${schedule.from}:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`;
  }
}

export interface TaskXmlOptions {
  /** The account the task runs as, such as `PC\ana`. */
  readonly user: string;
  /** Shown in Task Scheduler beside the task. */
  readonly description: string;
  readonly now: Date;
}

/** The Task Scheduler XML for a definition, in the 1.2 schema every supported Windows reads. */
export function buildTaskXml(definition: TaskDefinition, options: TaskXmlOptions): string {
  const { schedule, command, signedOut } = definition;
  const limit = schedule.timeLimitMinutes ?? SCHEDULE_TIME_LIMIT_DEFAULT_MINUTES;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    `<Task version="1.2" xmlns="${TASK_NAMESPACE}">`,
    `<RegistrationInfo><Author>Bildora</Author><Description>${escapeXml(options.description)}</Description></RegistrationInfo>`,
    `<Triggers>${triggerXml(schedule, options.now)}</Triggers>`,
    '<Principals><Principal id="Author">',
    `<UserId>${escapeXml(options.user)}</UserId>`,
    `<LogonType>${signedOut ? 'S4U' : 'InteractiveToken'}</LogonType>`,
    '<RunLevel>LeastPrivilege</RunLevel>',
    '</Principal></Principals>',
    '<Settings>',
    '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    `<StartWhenAvailable>${String(schedule.runMissed ?? true)}</StartWhenAvailable>`,
    `<ExecutionTimeLimit>PT${String(limit)}M</ExecutionTimeLimit>`,
    '<Enabled>true</Enabled>',
    '</Settings>',
    '<Actions Context="Author"><Exec>',
    `<Command>${escapeXml(command.program)}</Command>`,
    command.arguments === '' ? '' : `<Arguments>${escapeXml(command.arguments)}</Arguments>`,
    '</Exec></Actions>',
    '</Task>',
  ].join('');
}

/** The text of every element with this name, in order. */
function texts(xml: string, name: string): string[] {
  const pattern = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g');
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? '');
}

function text(xml: string, name: string): string | undefined {
  const all = texts(xml, name);
  return all.length === 1 ? unescapeXml((all[0] ?? '').trim()) : undefined;
}

/** Minutes in an XML duration such as `PT2H` or `P1DT30M`, when it has a whole number of them. */
export function durationMinutes(duration: string): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration);
  if (match === null || duration === 'P' || duration.endsWith('T')) return undefined;
  const [days, hours, minutes, seconds] = (match.slice(1) as (string | undefined)[]).map((part) =>
    Number(part ?? 0),
  );
  if ((seconds ?? 0) % SECONDS_PER_MINUTE !== 0) return undefined;
  return (
    (days ?? 0) * MINUTES_PER_DAY +
    (hours ?? 0) * MINUTES_PER_HOUR +
    (minutes ?? 0) +
    (seconds ?? 0) / SECONDS_PER_MINUTE
  );
}

/** `HH:MM` and `YYYY-MM-DD` from a start such as `2026-12-01T08:30:00`, when it is on a minute. */
function boundaryParts(boundary: string): { date: string; time: string } | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::00(?:\.0+)?)?$/.exec(boundary);
  return match === null ? undefined : { date: match[1] ?? '', time: match[2] ?? '' };
}

function readTrigger(xml: string): AutomationSchedule | undefined {
  const timeTriggers = texts(xml, 'TimeTrigger');
  const calendarTriggers = texts(xml, 'CalendarTrigger');
  if (timeTriggers.length + calendarTriggers.length !== 1) return undefined;
  const trigger = timeTriggers[0] ?? calendarTriggers[0] ?? '';
  if (text(trigger, 'Enabled') === 'false') return undefined;
  const start = boundaryParts(text(trigger, 'StartBoundary') ?? '');
  if (start === undefined) return undefined;
  if (timeTriggers.length === 1) {
    return trigger.includes('<Repetition')
      ? undefined
      : { repeat: 'once', date: start.date, time: start.time };
  }
  const repetition = text(trigger, 'Repetition');
  const byWeek = text(trigger, 'ScheduleByWeek');
  if (byWeek !== undefined) {
    if (repetition !== undefined || (text(byWeek, 'WeeksInterval') ?? '1') !== '1')
      return undefined;
    const days = SCHEDULE_DAYS.filter((day) =>
      new RegExp(`<${DAY_ELEMENTS[day]}\\s*/>`).test(byWeek),
    );
    return days.length === 0 ? undefined : { repeat: 'weekly', days, time: start.time };
  }
  const byDay = text(trigger, 'ScheduleByDay');
  if (byDay === undefined || (text(byDay, 'DaysInterval') ?? '1') !== '1') return undefined;
  if (repetition === undefined) return { repeat: 'daily', time: start.time };
  const interval = durationMinutes(text(repetition, 'Interval') ?? '');
  const duration = durationMinutes(text(repetition, 'Duration') ?? '');
  if (interval === undefined || interval % MINUTES_PER_HOUR !== 0 || duration !== MINUTES_PER_DAY) {
    return undefined;
  }
  return { repeat: 'hours', every: interval / MINUTES_PER_HOUR, from: start.time };
}

/** What a task holds that Bildora could have written, besides its definition. */
export interface ReadTask {
  readonly definition: TaskDefinition;
  readonly enabled: boolean;
}

/**
 * Reads back a task as Task Scheduler exports it. Anything Bildora would never write, such as a
 * second trigger or a trigger it has no schedule for, gives undefined: the task was changed by hand.
 */
export function readTaskXml(xml: string): ReadTask | undefined {
  const trigger = readTrigger(xml);
  const program = text(xml, 'Command');
  const logon = text(xml, 'LogonType');
  const settings = text(xml, 'Settings') ?? '';
  // Windows leaves Enabled out of an enabled task's settings, and nests none of its own in them.
  const enabled = text(settings, 'Enabled') !== 'false';
  if (trigger === undefined || program === undefined || texts(xml, 'Exec').length !== 1) {
    return undefined;
  }
  const limitText = text(settings, 'ExecutionTimeLimit');
  const limit = limitText === undefined ? undefined : durationMinutes(limitText);
  if (limit === undefined || limit < 1 || limit > SCHEDULE_TIME_LIMIT_MAX_MINUTES) return undefined;
  const runMissed = text(settings, 'StartWhenAvailable') === 'true';
  if (text(settings, 'DisallowStartIfOnBatteries') !== 'false') return undefined;
  return {
    definition: {
      schedule: { ...trigger, runMissed, timeLimitMinutes: limit },
      command: { program, arguments: text(xml, 'Arguments') ?? '' },
      signedOut: logon === 'S4U',
    },
    enabled,
  };
}

/** A definition with every left-out setting filled in, so that equal tasks compare equal. */
export function normalizeDefinition(definition: TaskDefinition): TaskDefinition {
  const { schedule } = definition;
  const filled = {
    ...schedule,
    runMissed: schedule.runMissed ?? true,
    timeLimitMinutes: schedule.timeLimitMinutes ?? SCHEDULE_TIME_LIMIT_DEFAULT_MINUTES,
  };
  if (filled.repeat === 'weekly') {
    filled.days = SCHEDULE_DAYS.filter((day) => filled.days.includes(day));
  }
  return { ...definition, schedule: filled };
}

function sameSchedule(left: AutomationSchedule, right: AutomationSchedule): boolean {
  return JSON.stringify(sortedKeys(left)) === JSON.stringify(sortedKeys(right));
}

function sortedKeys(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

export function sameDefinition(left: TaskDefinition, right: TaskDefinition): boolean {
  const a = normalizeDefinition(left);
  const b = normalizeDefinition(right);
  return (
    a.signedOut === b.signedOut &&
    a.command.program.toLowerCase() === b.command.program.toLowerCase() &&
    a.command.arguments === b.command.arguments &&
    sameSchedule(a.schedule, b.schedule)
  );
}
