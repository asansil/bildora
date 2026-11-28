import { describe, expect, it } from 'vitest';
import { dataDirArgument, scheduledCommand } from './schedule-service.js';

const NIGHTLY = { workspaceId: 'default', automationId: 'nightly' };

describe('scheduledCommand', () => {
  it('starts the packaged app with no window for one automation', () => {
    expect(scheduledCommand('C:\\Apps\\Bildora.exe', undefined, NIGHTLY)).toEqual({
      program: 'C:\\Apps\\Bildora.exe',
      arguments: '--scheduled-run run nightly --workspace default',
    });
  });

  it('names a data directory that is not the usual one, before the run', () => {
    const command = scheduledCommand('C:\\Apps\\Bildora.exe', undefined, NIGHTLY, 'D:\\My data');
    expect(command.arguments).toBe(
      '--data-dir "D:\\My data" --scheduled-run run nightly --workspace default',
    );
  });

  it('puts the app folder first in development', () => {
    const command = scheduledCommand('electron.exe', 'C:\\repo\\apps\\desktop', NIGHTLY, 'D:\\d');
    expect(command.arguments).toBe(
      'C:\\repo\\apps\\desktop --data-dir D:\\d --scheduled-run run nightly --workspace default',
    );
  });
});

describe('dataDirArgument', () => {
  it('reads the directory after --data-dir', () => {
    expect(dataDirArgument(['Bildora.exe', '--data-dir', 'D:\\My data', '--scheduled-run'])).toBe(
      'D:\\My data',
    );
  });

  it('gives nothing when the argument is missing or empty', () => {
    expect(dataDirArgument(['Bildora.exe', '--scheduled-run', 'run', 'nightly'])).toBeUndefined();
    expect(dataDirArgument(['Bildora.exe', '--data-dir'])).toBeUndefined();
    expect(dataDirArgument(['Bildora.exe', '--data-dir', ''])).toBeUndefined();
  });
});
