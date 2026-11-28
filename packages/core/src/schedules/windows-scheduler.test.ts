import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTaskXml, commandLineOf, readTaskXml, sameDefinition } from './task-xml.js';
import type { TaskDefinition } from './task-xml.js';
import { WindowsScheduler } from './windows-scheduler.js';

const folder = `BildoraTest-${randomBytes(4).toString('hex')}`;
const POWERSHELL_TEST_TIMEOUT_MS = 60_000;

/** Removes the test's folders from Task Scheduler, which removing their tasks leaves behind. */
function removeTestFolders(): void {
  const script = `$s = New-Object -ComObject Schedule.Service; $s.Connect(); $root = $s.GetFolder('\\'); try { $top = $root.GetFolder('${folder}'); foreach ($f in @($top.GetFolders(0))) { $top.DeleteFolder($f.Name, 0) }; $root.DeleteFolder('${folder}', 0) } catch {}`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
  });
}

// Creates real tasks, in a folder of its own that it removes afterwards. Signed-in tasks need no
// administrator rights; runs with nobody signed in are checked by hand, as they ask for them.
describe.runIf(process.platform === 'win32')('WindowsScheduler', () => {
  const scheduler = new WindowsScheduler({ root: `\\${folder}\\` });
  const location = { workspaceId: 'work', automationId: 'nightly' };
  const definition: TaskDefinition = {
    schedule: { repeat: 'weekly', days: ['mon', 'fri'], time: '07:30', timeLimitMinutes: 90 },
    command: {
      program: 'C:\\Windows\\System32\\cmd.exe',
      arguments: commandLineOf(['/c', 'exit', '3']),
    },
    signedOut: false,
  };

  afterAll(() => {
    removeTestFolders();
  });

  it(
    'creates, reads back, replaces and removes a task',
    async () => {
      expect(await scheduler.list()).toEqual([]);
      const now = new Date();
      await scheduler.put(
        location,
        buildTaskXml(definition, { user: scheduler.user, description: 'Bildora test', now }),
        { elevated: false },
      );
      const [task] = await scheduler.list();
      expect(task).toMatchObject({ ...location, running: false });
      expect(task?.nextRun?.getTime()).toBeGreaterThan(now.getTime());
      expect(task?.lastRun).toBeUndefined();
      const read = task === undefined ? undefined : readTaskXml(task.xml);
      expect(read?.enabled).toBe(true);
      expect(read && sameDefinition(read.definition, definition)).toBe(true);

      const daily: TaskDefinition = {
        ...definition,
        schedule: { repeat: 'hours', every: 6, from: '00:15', runMissed: false },
      };
      await scheduler.put(
        location,
        buildTaskXml(daily, { user: scheduler.user, description: 'Bildora test', now }),
        { elevated: false },
      );
      const tasks = await scheduler.list();
      expect(tasks).toHaveLength(1);
      const again = tasks[0] === undefined ? undefined : readTaskXml(tasks[0].xml);
      expect(again && sameDefinition(again.definition, daily)).toBe(true);

      await scheduler.remove(location);
      await scheduler.remove(location);
      expect(await scheduler.list()).toEqual([]);
    },
    POWERSHELL_TEST_TIMEOUT_MS,
  );
});
