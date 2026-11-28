import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Automation, AutomationSchedule } from '@bildora/protocol';
import { readScheduleSettings } from './schedule-settings.js';
import {
  ScheduleBlockedError,
  applySchedule,
  reviewSchedules,
  scheduleBlocker,
  scheduleState,
  turnScheduleOff,
  turnScheduleOn,
} from './schedule-sync.js';
import type { ScheduleContext } from './schedule-sync.js';
import type {
  PutTaskOptions,
  SystemScheduler,
  SystemTask,
  TaskLocation,
} from './system-scheduler.js';
import { commandLineOf } from './task-xml.js';

/** A scheduler that keeps its tasks in memory, as Task Scheduler would export them. */
class MemoryScheduler implements SystemScheduler {
  readonly user = 'PC\\ana';
  readonly tasks = new Map<string, SystemTask>();
  readonly puts: { location: TaskLocation; options: PutTaskOptions }[] = [];

  put(location: TaskLocation, xml: string, options: PutTaskOptions): Promise<void> {
    this.puts.push({ location, options });
    this.tasks.set(`${location.workspaceId}/${location.automationId}`, {
      ...location,
      xml,
      running: false,
      nextRun: new Date(2026, 10, 26, 8, 0),
    });
    return Promise.resolve();
  }

  remove(location: TaskLocation): Promise<void> {
    this.tasks.delete(`${location.workspaceId}/${location.automationId}`);
    return Promise.resolve();
  }

  list(): Promise<readonly SystemTask[]> {
    return Promise.resolve([...this.tasks.values()]);
  }
}

const daily: AutomationSchedule = { repeat: 'daily', time: '08:00' };

function automation(
  id: string,
  start: Record<string, unknown> = { mode: 'scheduled', schedule: daily },
): Automation {
  return {
    schemaVersion: 2,
    id,
    name: id,
    blocks: [{ id: 'start', type: 'start', ...start }],
    connections: [],
  };
}

describe('schedules', () => {
  let dataDir: string;
  let scheduler: MemoryScheduler;
  let program: string;
  let context: ScheduleContext;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'bildora-schedules-'));
    scheduler = new MemoryScheduler();
    program = 'C:\\Apps\\Bildora\\Bildora.exe';
    context = {
      dataDir,
      scheduler,
      commandFor: ({ workspaceId, automationId }) => ({
        program,
        arguments: commandLineOf([
          '--scheduled-run',
          'run',
          automationId,
          '--workspace',
          workspaceId,
        ]),
      }),
      now: () => new Date(2026, 10, 25, 12, 0),
    };
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  const at = (item: Automation) => ({ workspaceId: 'work', automation: item });
  const key = (id: string) => `work/${id}`;

  it('says why a schedule cannot run', () => {
    const now = new Date(2026, 10, 25, 12, 0);
    expect(scheduleBlocker(automation('a', {}), now)).toBe('not-scheduled');
    expect(scheduleBlocker(automation('a', { mode: 'button', schedule: daily }), now)).toBe(
      'not-scheduled',
    );
    const inputs = [{ name: 'file', type: 'path', required: true }];
    expect(
      scheduleBlocker(automation('a', { mode: 'scheduled', schedule: daily, inputs }), now),
    ).toBe('input-without-default');
    const once = (time: string): AutomationSchedule => ({
      repeat: 'once',
      date: '2026-11-25',
      time,
    });
    expect(
      scheduleBlocker(automation('a', { mode: 'scheduled', schedule: once('11:59') }), now),
    ).toBe('past');
    expect(
      scheduleBlocker(automation('a', { mode: 'scheduled', schedule: once('12:01') }), now),
    ).toBeUndefined();
  });

  it('turns a schedule on and off, keeping the choice outside the automation', async () => {
    await turnScheduleOn(context, at(automation('nightly')), { signedOut: false });
    expect(scheduler.tasks.has(key('nightly'))).toBe(true);
    expect(scheduler.puts[0]?.options.elevated).toBe(false);
    expect(await scheduleState(context, at(automation('nightly')))).toMatchObject({ kind: 'on' });

    await turnScheduleOff(context, { workspaceId: 'work', automationId: 'nightly' });
    expect(scheduler.tasks.size).toBe(0);
    expect(await readScheduleSettings(dataDir)).toEqual([]);
    expect(await scheduleState(context, at(automation('nightly')))).toEqual({ kind: 'off' });
  });

  it('asks for administrator rights only for runs with nobody signed in', async () => {
    await turnScheduleOn(context, at(automation('nightly')), { signedOut: true });
    expect(scheduler.puts[0]?.options.elevated).toBe(true);
    expect(scheduler.tasks.get(key('nightly'))?.xml).toContain('<LogonType>S4U</LogonType>');
  });

  it('refuses to turn on a schedule that cannot run', async () => {
    await expect(
      turnScheduleOn(context, at(automation('nightly', {})), { signedOut: false }),
    ).rejects.toBeInstanceOf(ScheduleBlockedError);
    expect(scheduler.tasks.size).toBe(0);
  });

  it('follows a saved automation, and leaves one that is off alone', async () => {
    await applySchedule(context, at(automation('other')));
    expect(scheduler.tasks.size).toBe(0);

    await turnScheduleOn(context, at(automation('nightly')), { signedOut: false });
    await applySchedule(context, at(automation('nightly')));
    expect(scheduler.puts).toHaveLength(1);

    const later = automation('nightly', {
      mode: 'scheduled',
      schedule: { repeat: 'daily', time: '09:00' },
    });
    await applySchedule(context, at(later));
    expect(scheduler.puts).toHaveLength(2);
    expect(scheduler.tasks.get(key('nightly'))?.xml).toContain('T09:00:00');

    // A button removes the task but keeps the schedule on, so that going back restores it.
    await applySchedule(context, at(automation('nightly', { mode: 'button', schedule: daily })));
    expect(scheduler.tasks.size).toBe(0);
    expect(await scheduleState(context, at(automation('nightly', { mode: 'button' })))).toEqual({
      kind: 'blocked',
      blocker: 'not-scheduled',
    });
    await applySchedule(context, at(automation('nightly')));
    expect(scheduler.tasks.has(key('nightly'))).toBe(true);
  });

  it('repairs a moved Bildora on review, and reports tasks changed or removed by someone else', async () => {
    await turnScheduleOn(context, at(automation('moved')), { signedOut: false });
    await turnScheduleOn(context, at(automation('edited')), { signedOut: false });
    await turnScheduleOn(context, at(automation('removed')), { signedOut: false });
    await turnScheduleOn(context, at(automation('locked')), { signedOut: true });

    program = 'D:\\Bildora\\Bildora.exe';
    const edited = scheduler.tasks.get(key('edited'));
    if (edited !== undefined) {
      scheduler.tasks.set(key('edited'), {
        ...edited,
        xml: edited.xml.replace('T08:00:00', 'T10:00:00'),
      });
    }
    scheduler.tasks.delete(key('removed'));
    // A task of an automation that no longer exists.
    await turnScheduleOn(context, at(automation('gone')), { signedOut: false });

    const states = await reviewSchedules(
      context,
      ['moved', 'edited', 'removed', 'locked', 'off'].map((id) => at(automation(id))),
    );
    expect(states.get(key('moved'))).toMatchObject({ kind: 'on' });
    expect(scheduler.tasks.get(key('moved'))?.xml).toContain('D:\\Bildora\\Bildora.exe');
    expect(states.get(key('edited'))).toMatchObject({ kind: 'changed' });
    expect(states.get(key('removed'))).toEqual({ kind: 'missing' });
    expect(states.get(key('locked'))).toMatchObject({ kind: 'outdated' });
    expect(states.get(key('off'))).toEqual({ kind: 'off' });
    expect(scheduler.tasks.has(key('gone'))).toBe(false);
    expect(
      (await readScheduleSettings(dataDir)).map(({ automationId }) => automationId).sort(),
    ).toEqual(['edited', 'locked', 'moved', 'removed']);
  });

  it('restores a task someone changed when the schedule is turned on again', async () => {
    await turnScheduleOn(context, at(automation('nightly')), { signedOut: false });
    const task = scheduler.tasks.get(key('nightly'));
    if (task !== undefined) {
      scheduler.tasks.set(key('nightly'), {
        ...task,
        xml: task.xml.replace('T08:00:00', 'T10:00:00'),
      });
    }
    expect(await scheduleState(context, at(automation('nightly')))).toMatchObject({
      kind: 'changed',
    });
    await turnScheduleOn(context, at(automation('nightly')), { signedOut: false });
    expect(await scheduleState(context, at(automation('nightly')))).toMatchObject({ kind: 'on' });
  });
});
