import {
  applySchedule,
  commandLineOf,
  forgetSchedule,
  readScheduleSettings,
  reviewSchedules,
  scheduleState,
  turnScheduleOff,
  turnScheduleOn,
} from '@bildora/core';
import type {
  AutomationAt,
  ScheduleContext,
  ScheduleState,
  SystemScheduler,
  TaskCommand,
  TaskLocation,
} from '@bildora/core';
import type { Automation } from '@bildora/protocol';
import type { ScheduleStatusView } from '../shared/ipc-contract.js';

/** The argument that makes Bildora run one automation with no window, as a scheduled task does. */
export const SCHEDULED_RUN_ARGUMENT = '--scheduled-run';

/**
 * The argument that names the data directory a scheduled run uses, when it is not the usual one. A
 * task runs with the user's environment, not with the one the app was started with.
 */
export const DATA_DIR_ARGUMENT = '--data-dir';

/** The data directory given after `--data-dir`, if any. */
export function dataDirArgument(argv: readonly string[]): string | undefined {
  const at = argv.indexOf(DATA_DIR_ARGUMENT);
  const value = at === -1 ? undefined : argv[at + 1];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * How a task starts Bildora for one automation: the executable itself, which then runs the command
 * with no window. In development the executable is Electron, which needs the app's folder first.
 * `dataDir` is given only when it is not the usual one.
 */
export function scheduledCommand(
  executable: string,
  appFolder: string | undefined,
  { workspaceId, automationId }: TaskLocation,
  dataDir?: string,
): TaskCommand {
  return {
    program: executable,
    arguments: commandLineOf([
      ...(appFolder === undefined ? [] : [appFolder]),
      ...(dataDir === undefined ? [] : [DATA_DIR_ARGUMENT, dataDir]),
      SCHEDULED_RUN_ARGUMENT,
      'run',
      automationId,
      '--workspace',
      workspaceId,
    ]),
  };
}

function viewOf(state: ScheduleState, signedOut: boolean): ScheduleStatusView {
  const times =
    state.kind === 'on' || state.kind === 'changed' || state.kind === 'outdated'
      ? {
          running: state.running,
          ...(state.nextRun === undefined ? {} : { nextRun: state.nextRun.toISOString() }),
          ...(state.lastRun === undefined ? {} : { lastRun: state.lastRun.toISOString() }),
          ...(state.lastResult === undefined ? {} : { lastResult: state.lastResult }),
        }
      : { running: false };
  return {
    kind: state.kind,
    signedOut,
    ...(state.kind === 'blocked' ? { blocker: state.blocker } : {}),
    ...times,
  };
}

/** Keeps this computer's scheduled tasks in step with the automations, for the app. */
export class ScheduleService {
  private readonly context: ScheduleContext;

  constructor(
    dataDir: string,
    scheduler: SystemScheduler,
    commandFor: ScheduleContext['commandFor'],
  ) {
    this.context = { dataDir, scheduler, commandFor };
  }

  private async signedOut(location: TaskLocation): Promise<boolean> {
    const settings = await readScheduleSettings(this.context.dataDir);
    return settings.some(
      (setting) =>
        setting.workspaceId === location.workspaceId &&
        setting.automationId === location.automationId &&
        setting.signedOut,
    );
  }

  async status(target: AutomationAt): Promise<ScheduleStatusView> {
    const location = { workspaceId: target.workspaceId, automationId: target.automation.id };
    const [state, signedOut] = await Promise.all([
      scheduleState(this.context, target),
      this.signedOut(location),
    ]);
    return viewOf(state, signedOut);
  }

  /** Turns the schedule on, off, or on in another mode, and says how it stands afterwards. */
  async set(
    target: AutomationAt,
    choice: { readonly on: boolean; readonly signedOut?: boolean | undefined },
  ): Promise<ScheduleStatusView> {
    const location = { workspaceId: target.workspaceId, automationId: target.automation.id };
    if (choice.on) {
      const signedOut = choice.signedOut ?? (await this.signedOut(location));
      await turnScheduleOn(this.context, target, { signedOut });
    } else {
      await turnScheduleOff(this.context, location);
    }
    return this.status(target);
  }

  /**
   * Follows a saved automation. It never asks for administrator rights on its own: a task that
   * needs them stays out of date until the person updates it.
   */
  async apply(workspaceId: string, automation: Automation): Promise<void> {
    await applySchedule(this.context, { workspaceId, automation }, { elevate: false });
  }

  async forget(location: TaskLocation): Promise<void> {
    await forgetSchedule(this.context, location);
  }

  /** Brings every task up to date on launch, and drops tasks of automations that are gone. */
  async review(automations: readonly AutomationAt[], complete: boolean): Promise<void> {
    await reviewSchedules(this.context, automations, { complete });
  }
}
