/**
 * Where a task lives: a folder per Workspace inside Bildora's own folder, so that Bildora never
 * reads or touches a task it did not create.
 */
export interface TaskLocation {
  readonly workspaceId: string;
  readonly automationId: string;
}

/** A task as the system scheduler holds it. */
export interface SystemTask extends TaskLocation {
  /** The task's definition as the scheduler exports it, to be read back with `readTaskXml`. */
  readonly xml: string;
  readonly nextRun?: Date;
  readonly lastRun?: Date;
  /** The exit code of the last run, which is the `bildora run` exit code. */
  readonly lastResult?: number;
  readonly running: boolean;
}

export interface PutTaskOptions {
  /** The definition is for runs with nobody signed in, which needs administrator rights. */
  readonly elevated: boolean;
}

/**
 * The system's scheduler, reached through this interface so that another system, such as cron on
 * Linux, can stand in without any change to the automation format.
 */
export interface SystemScheduler {
  /** The account tasks run as. */
  readonly user: string;
  /** Creates the task, or replaces the one at the same place. */
  put(location: TaskLocation, xml: string, options: PutTaskOptions): Promise<void>;
  /** Removes the task. A task that is already gone is no error. */
  remove(location: TaskLocation): Promise<void>;
  /** Every task in Bildora's folder. */
  list(): Promise<readonly SystemTask[]>;
}

/** Raised when the system refused a change, for example because administrator rights were refused. */
export class SchedulerError extends Error {
  readonly reason: 'denied' | 'failed';

  constructor(message: string, reason: 'denied' | 'failed') {
    super(message);
    this.reason = reason;
    this.name = 'SchedulerError';
  }
}
