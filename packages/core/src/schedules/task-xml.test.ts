import { describe, expect, it } from 'vitest';
import type { AutomationSchedule } from '@bildora/protocol';
import {
  buildTaskXml,
  commandLineOf,
  durationMinutes,
  readTaskXml,
  sameDefinition,
} from './task-xml.js';
import type { TaskDefinition } from './task-xml.js';

const command = {
  program: 'C:\\Apps\\Bildora\\Bildora.exe',
  arguments: commandLineOf(['--scheduled-run', 'run', 'nightly', '--workspace', 'work']),
};
const options = {
  user: 'PC\\ana',
  description: 'Runs "Nightly" & more',
  now: new Date(2026, 10, 25, 12, 0),
};
const definition = (schedule: AutomationSchedule, signedOut = false): TaskDefinition => ({
  schedule,
  command,
  signedOut,
});

describe('commandLineOf', () => {
  it('quotes only the arguments Windows would split', () => {
    expect(commandLineOf(['run', 'C:\\My Files\\a', '', 'say "hi"'])).toBe(
      'run "C:\\My Files\\a" "" "say \\"hi\\""',
    );
  });
});

describe('durationMinutes', () => {
  it('reads the durations Task Scheduler writes', () => {
    expect(durationMinutes('PT120M')).toBe(120);
    expect(durationMinutes('PT2H')).toBe(120);
    expect(durationMinutes('P1D')).toBe(1440);
    expect(durationMinutes('P3DT0H')).toBe(4320);
    expect(durationMinutes('PT90S')).toBeUndefined();
    expect(durationMinutes('P')).toBeUndefined();
    expect(durationMinutes('soon')).toBeUndefined();
  });
});

describe('buildTaskXml and readTaskXml', () => {
  const schedules: AutomationSchedule[] = [
    { repeat: 'once', date: '2026-12-01', time: '08:30' },
    { repeat: 'daily', time: '23:59', runMissed: false },
    { repeat: 'weekly', days: ['fri', 'mon'], time: '07:00', timeLimitMinutes: 30 },
    { repeat: 'hours', every: 4, from: '06:15' },
  ];

  it('reads back every schedule it writes', () => {
    for (const schedule of schedules) {
      for (const signedOut of [false, true]) {
        const written = definition(schedule, signedOut);
        const read = readTaskXml(buildTaskXml(written, options));
        expect(read?.enabled).toBe(true);
        expect(read && sameDefinition(read.definition, written)).toBe(true);
      }
    }
  });

  it('starts a repeating schedule tomorrow when today’s time has gone by', () => {
    const xml = (time: string) => buildTaskXml(definition({ repeat: 'daily', time }), options);
    expect(xml('13:00')).toContain('<StartBoundary>2026-11-25T13:00:00</StartBoundary>');
    expect(xml('11:00')).toContain('<StartBoundary>2026-11-26T11:00:00</StartBoundary>');
  });

  it('escapes text and keeps the settings that stop a task on battery off', () => {
    const xml = buildTaskXml(definition({ repeat: 'daily', time: '08:00' }), options);
    expect(xml).toContain('Runs &quot;Nightly&quot; &amp; more');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
  });

  it('reads a task as Windows exports it, with its own way of writing the same settings', () => {
    const exported = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>Bildora</Author><URI>\\Bildora\\work\\nightly</URI></RegistrationInfo>
  <Principals><Principal id="Author"><UserId>S-1-5-21-1</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <IdleSettings><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
  </Settings>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-11-26T07:00:00</StartBoundary>
      <ScheduleByWeek><DaysOfWeek><Monday /><Friday /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Actions Context="Author"><Exec><Command>${command.program}</Command><Arguments>${command.arguments}</Arguments></Exec></Actions>
</Task>`;
    const read = readTaskXml(exported);
    expect(read?.enabled).toBe(true);
    expect(
      read &&
        sameDefinition(
          read.definition,
          definition({ repeat: 'weekly', days: ['mon', 'fri'], time: '07:00' }),
        ),
    ).toBe(true);
    expect(
      readTaskXml(
        exported.replace('<StartWhenAvailable>', '<Enabled>false</Enabled><StartWhenAvailable>'),
      )?.enabled,
    ).toBe(false);
  });

  it('gives nothing for a task with something Bildora never writes', () => {
    const xml = buildTaskXml(definition({ repeat: 'daily', time: '08:00' }), options);
    const twoTriggers = xml.replace(
      '</Triggers>',
      '<TimeTrigger><StartBoundary>2026-12-01T08:00:00</StartBoundary></TimeTrigger></Triggers>',
    );
    expect(readTaskXml(twoTriggers)).toBeUndefined();
    expect(
      readTaskXml(xml.replace('<DaysInterval>1</DaysInterval>', '<DaysInterval>2</DaysInterval>')),
    ).toBeUndefined();
    expect(
      readTaskXml(xml.replace('</Exec>', '</Exec><Exec><Command>x</Command></Exec>')),
    ).toBeUndefined();
    expect(
      readTaskXml(
        xml.replace('<DisallowStartIfOnBatteries>false', '<DisallowStartIfOnBatteries>true'),
      ),
    ).toBeUndefined();
  });

  it('tells a changed schedule, account mode or program apart', () => {
    const base = definition({ repeat: 'daily', time: '08:00' });
    expect(
      sameDefinition(base, {
        ...base,
        schedule: { repeat: 'daily', time: '08:00', runMissed: true, timeLimitMinutes: 120 },
      }),
    ).toBe(true);
    expect(sameDefinition(base, { ...base, schedule: { repeat: 'daily', time: '08:01' } })).toBe(
      false,
    );
    expect(sameDefinition(base, { ...base, signedOut: true })).toBe(false);
    expect(
      sameDefinition(base, {
        ...base,
        command: { ...command, program: command.program.toUpperCase() },
      }),
    ).toBe(true);
    expect(
      sameDefinition(base, { ...base, command: { ...command, program: 'D:\\Bildora.exe' } }),
    ).toBe(false);
  });
});
