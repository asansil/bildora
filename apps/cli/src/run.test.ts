import { describe, expect, it } from 'vitest';
import { runCli } from './run.js';

describe('runCli', () => {
  it.each(['--version', '-v'])('prints the version for %s', (flag) => {
    expect(runCli([flag], '1.2.3')).toEqual({ exitCode: 0, stdout: 'Bildora 1.2.3' });
  });

  it.each([[[]], [['run']]])('fails with usage for %j', (args) => {
    expect(runCli(args, '1.2.3')).toEqual({ exitCode: 2, stderr: 'Usage: bildora --version' });
  });
});
