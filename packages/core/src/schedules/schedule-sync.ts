import { startBlocker } from '@bildora/protocol';
import type {
  Automation,
  AutomationSchedule,
  ScheduleBlocker,
  StartBlock,
} from '@bildora/protocol';
import {
  putScheduleSetting,
  readScheduleSettings,
  removeScheduleSetting,
} from './schedule-settings.js';
import type { ScheduleSetting } from './schedule-settings.js';
import type { SystemScheduler, SystemTask, TaskLocation } from './system-scheduler.js';
import { buildTaskXml, readTaskXml, sameDefinition } from './task-xml.js';
import type { TaskCommand, TaskDefinition } from './task-xml.js';

/** What Bildora needs to keep this computer's tasks in step with its automations. */
export interface ScheduleContext {
  readonly dataDir: string;
  readonly scheduler: SystemScheduler;
  /** How a task starts one automation, which depends on where Bildora is installed. */
  readonly commandFor: (location: TaskLocation) => TaskCommand;
  readonly now?: () => Date;
}

/** An automation together with the Workspace it belongs to. */
export interface AutomationAt {
  readonly workspaceId: string;
  readonly automation: Automation;
}

/** How one automation's schedule stands on this computer. */
export type ScheduleState =
  | { readonly kind: 'off' }
  | { readonly kind: 'blocked'; readonly blocker: ScheduleBlocker }
  | ({ readonly kind: 'on' } & TaskTimes)
  /** Someone removed the task outside Bildora. */
  | { readonly kind: 'missing' }
  /** Someone changed the task outside Bildora, so it may no longer run as the automation says. */
  | ({ readonly kind: 'changed' } & TaskTimes)
  /** The automation changed, and its task runs with nobody signed in, so updating it needs administrator rights. */
  | ({ readonly kind: 'outdated' } & TaskTimes);

export interface TaskTimes {
  readonly nextRun?: Date;
  readonly lastRun?: Date;
  readonly lastResult?: number;
  readonly running: boolean;
}

export type { ScheduleBlocker };

const keyOf = ({ workspaceId, automationId }: TaskLocation): string =>
  `${workspaceId}/${automationId}`;

function startOf(automation: Automation): StartBlock | undefined {
  const start = automation.blocks.find((block) => block.type === 'start');
  return start?.type === 'start' ? start : undefined;
}

function scheduleOf(automation: Automation): AutomationSchedule | undefined {
  const start = startOf(automation);
  return start?.mode === 'scheduled' ? start.schedule : undefined;
}

/** Why the automation's schedule cannot run now, if it cannot. */
export function scheduleBlocker(automation: Automation, now: Date): ScheduleBlocker | undefined {
  return startBlocker(startOf(automation), now);
}

function definitionOf(
  context: ScheduleContext,
  { workspaceId, automation }: AutomationAt,
  signedOut: boolean,
): TaskDefinition | undefined {
  const schedule = scheduleOf(automation);
  if (schedule === undefined) return undefined;
  return {
    schedule,
    command: context.commandFor({ workspaceId, automationId: automation.id }),
    signedOut,
  };
}

function descriptionOf(automation: Automation): string {
  return `Runs the Bildora automation "${automation.name}". Bildora keeps this task up to date, so change it there.`;
}

async function writeTask(
  context: ScheduleContext,
  target: AutomationAt,
  definition: TaskDefinition,
): Promise<void> {
  const now = context.now?.() ?? new Date();
  const xml = buildTaskXml(definition, {
    user: context.scheduler.user,
    description: descriptionOf(target.automation),
    now,
  });
  await context.scheduler.put(
    { workspaceId: target.workspaceId, automationId: target.automation.id },
    xml,
    { elevated: definition.signedOut },
  );
  await putScheduleSetting(context.dataDir, {
    workspaceId: target.workspaceId,
    automationId: target.automation.id,
    signedOut: definition.signedOut,
    written: definition,
  });
}

/** Thrown when a schedule cannot be turned on, with the reason. */
export class ScheduleBlockedError extends Error {
  readonly blocker: ScheduleBlocker;

  constructor(blocker: ScheduleBlocker) {
    super(`The schedule cannot be turned on: ${blocker}`);
    this.blocker = blocker;
    this.name = 'ScheduleBlockedError';
  }
}

/**
 * Turns an automation's schedule on for this computer, or changes how it runs, and creates its
 * task. Running with nobody signed in asks the person for administrator rights.
 */
export async function turnScheduleOn(
  context: ScheduleContext,
  target: AutomationAt,
  options: { readonly signedOut: boolean },
): Promise<void> {
  const blocker = scheduleBlocker(target.automation, context.now?.() ?? new Date());
  const definition = definitionOf(context, target, options.signedOut);
  if (blocker !== undefined || definition === undefined) {
    throw new ScheduleBlockedError(blocker ?? 'not-scheduled');
  }
  await writeTask(context, target, definition);
}

/** Turns an automation's schedule off for this computer, and removes its task. */
export async function turnScheduleOff(
  context: ScheduleContext,
  location: TaskLocation,
): Promise<void> {
  await context.scheduler.remove(location);
  await removeScheduleSetting(context.dataDir, location);
}

/**
 * Brings the task of a saved automation up to date, when its schedule is on: rewritten when the
 * schedule changed, removed while the schedule cannot run. Nothing happens to one that is off.
 */
export async function applySchedule(
  context: ScheduleContext,
  target: AutomationAt,
  options: { readonly elevate?: boolean } = {},
): Promise<void> {
  const location = { workspaceId: target.workspaceId, automationId: target.automation.id };
  const setting = (await readScheduleSettings(context.dataDir)).find(
    (item) => keyOf(item) === keyOf(location),
  );
  if (setting === undefined) return;
  const blocker = scheduleBlocker(target.automation, context.now?.() ?? new Date());
  const definition = definitionOf(context, target, setting.signedOut);
  if (blocker !== undefined || definition === undefined) {
    if (setting.written !== undefined) {
      await context.scheduler.remove(location);
      await putScheduleSetting(context.dataDir, {
        workspaceId: setting.workspaceId,
        automationId: setting.automationId,
        signedOut: setting.signedOut,
      });
    }
    return;
  }
  if (setting.written === undefined || !sameDefinition(setting.written, definition)) {
    // Without leave to ask for administrator rights, a task for runs with nobody signed in stays
    // behind, and its state says it is out of date.
    if (definition.signedOut && options.elevate === false) return;
    await writeTask(context, target, definition);
  }
}

/** Removes the task and the setting of an automation that is gone. */
export async function forgetSchedule(
  context: ScheduleContext,
  location: TaskLocation,
): Promise<void> {
  await turnScheduleOff(context, location);
}

function timesOf(task: SystemTask): TaskTimes {
  return {
    running: task.running,
    ...(task.nextRun === undefined ? {} : { nextRun: task.nextRun }),
    ...(task.lastRun === undefined ? {} : { lastRun: task.lastRun }),
    ...(task.lastResult === undefined ? {} : { lastResult: task.lastResult }),
  };
}

async function reviewOne(
  context: ScheduleContext,
  target: AutomationAt,
  setting: ScheduleSetting | undefined,
  task: SystemTask | undefined,
): Promise<ScheduleState> {
  if (setting === undefined) return { kind: 'off' };
  const blocker = scheduleBlocker(target.automation, context.now?.() ?? new Date());
  const definition = definitionOf(context, target, setting.signedOut);
  if (blocker !== undefined || definition === undefined) {
    if (task !== undefined) await context.scheduler.remove(task);
    return { kind: 'blocked', blocker: blocker ?? 'not-scheduled' };
  }
  if (task === undefined) {
    // A schedule turned on while it could not run has no task yet, and nobody removed it.
    if (setting.written === undefined) {
      await writeTask(context, target, definition);
      return { kind: 'on', running: false };
    }
    return { kind: 'missing' };
  }
  const read = readTaskXml(task.xml);
  const untouched =
    read !== undefined &&
    read.enabled &&
    setting.written !== undefined &&
    sameDefinition(read.definition, setting.written);
  if (!untouched) return { kind: 'changed', ...timesOf(task) };
  if (sameDefinition(definition, read.definition)) return { kind: 'on', ...timesOf(task) };
  // The automation changed, or Bildora moved: the task only needs to follow.
  if (definition.signedOut) return { kind: 'outdated', ...timesOf(task) };
  await writeTask(context, target, definition);
  return { kind: 'on', ...timesOf(task) };
}

/**
 * Compares this computer's tasks with what its automations say, as Bildora does on launch. It
 * brings tasks up to date where nobody else touched them, removes tasks of automations that are
 * gone or turned off, and reports tasks someone else removed or changed. The answer has a state
 * for every automation given, by `<workspace>/<automation>`.
 */
export async function reviewSchedules(
  context: ScheduleContext,
  automations: readonly AutomationAt[],
  options: {
    /**
     * Whether automations left out are really gone. A caller that could not read every file must
     * say no, so that a damaged file does not cost its automation its schedule.
     */
    readonly complete?: boolean;
  } = {},
): Promise<ReadonlyMap<string, ScheduleState>> {
  const [settings, tasks] = await Promise.all([
    readScheduleSettings(context.dataDir),
    context.scheduler.list(),
  ]);
  const settingByKey = new Map(settings.map((setting) => [keyOf(setting), setting]));
  const taskByKey = new Map(tasks.map((task) => [keyOf(task), task]));
  const states = new Map<string, ScheduleState>();
  for (const target of automations) {
    const key = keyOf({ workspaceId: target.workspaceId, automationId: target.automation.id });
    states.set(key, await reviewOne(context, target, settingByKey.get(key), taskByKey.get(key)));
  }
  const complete = options.complete ?? true;
  for (const task of tasks) {
    const key = keyOf(task);
    const gone = !states.has(key) && complete;
    if (gone || (states.has(key) && !settingByKey.has(key))) await context.scheduler.remove(task);
  }
  if (complete) {
    for (const setting of settings) {
      if (!states.has(keyOf(setting))) await removeScheduleSetting(context.dataDir, setting);
    }
  }
  return states;
}

/** How one automation's schedule stands now, without changing anything. */
export async function scheduleState(
  context: ScheduleContext,
  target: AutomationAt,
): Promise<ScheduleState> {
  const location = { workspaceId: target.workspaceId, automationId: target.automation.id };
  const [settings, tasks] = await Promise.all([
    readScheduleSettings(context.dataDir),
    context.scheduler.list(),
  ]);
  const setting = settings.find((item) => keyOf(item) === keyOf(location));
  const task = tasks.find((item) => keyOf(item) === keyOf(location));
  if (setting === undefined) return { kind: 'off' };
  const blocker = scheduleBlocker(target.automation, context.now?.() ?? new Date());
  if (blocker !== undefined) return { kind: 'blocked', blocker };
  if (task === undefined)
    return setting.written === undefined ? { kind: 'off' } : { kind: 'missing' };
  const read = readTaskXml(task.xml);
  if (
    read === undefined ||
    !read.enabled ||
    setting.written === undefined ||
    !sameDefinition(read.definition, setting.written)
  ) {
    return { kind: 'changed', ...timesOf(task) };
  }
  const definition = definitionOf(context, target, setting.signedOut);
  if (definition !== undefined && !sameDefinition(definition, read.definition)) {
    return { kind: 'outdated', ...timesOf(task) };
  }
  return { kind: 'on', ...timesOf(task) };
}
