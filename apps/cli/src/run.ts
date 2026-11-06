import { getCoreInfo } from '@bildora/core';

export interface CliResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** Runs one CLI invocation and returns what the process should print and exit with. */
export function runCli(args: readonly string[], version: string): CliResult {
  const [command] = args;
  if (command === '--version' || command === '-v') {
    return { exitCode: 0, stdout: `${getCoreInfo().productName} ${version}` };
  }
  return { exitCode: 2, stderr: 'Usage: bildora --version' };
}
