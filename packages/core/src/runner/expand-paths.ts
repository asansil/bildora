import { replacePathVariables } from '@bildora/protocol';
import type { RegisteredTool } from '../registry/tool-registry.js';

export type PathVariables = ReadonlyMap<string, string>;

/** A path names a variable this machine has no value for. */
export class MissingPathVariableError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`Path variable "${variable}" has no value on this computer`);
    this.name = 'MissingPathVariableError';
    this.variable = variable;
  }
}

export function expandPath(text: string, variables: PathVariables): string {
  return replacePathVariables(text, (name) => {
    const value = variables.get(name);
    if (value === undefined) {
      throw new MissingPathVariableError(name);
    }
    return value;
  });
}

/** The tool as it runs on this machine. The manifest itself keeps its references. */
export function expandToolCommand(tool: RegisteredTool, variables: PathVariables): RegisteredTool {
  const { manifest } = tool;
  const run = {
    ...manifest.run,
    program: expandPath(manifest.run.program, variables),
    args: manifest.run.args.map((argument) => expandPath(argument, variables)),
  };
  return { ...tool, manifest: { ...manifest, run } };
}
