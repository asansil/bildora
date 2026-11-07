import { isAbsolute, win32 } from 'node:path';
import {
  MANIFEST_SCHEMA_VERSION,
  startsWithPathVariable,
  toolManifestSchema,
} from '@bildora/protocol';
import type { ToolManifest } from '@bildora/protocol';
import type { RegisteredTool, ToolRegistry } from '../registry/tool-registry.js';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import type { InstallScope } from '../storage/data-directory.js';
import { DefinitionError } from '../storage/definition-error.js';
import { identifierFromName } from './identifier.js';

export { identifierFromName };

/** Registered programs have no version of their own that Bildora could know. */
const REGISTERED_VERSION = '0.0.0';

export interface ToolDetails {
  readonly name: string;
  readonly category?: string | undefined;
  readonly description?: string | undefined;
  readonly interpreter?: string | undefined;
}

export interface ProgramDetails extends ToolDetails {
  /** Absolute path. A registered program stays where it is, so a relative path has no base. */
  readonly program: string;
}

function uniqueIdentifier(name: string, taken: ReadonlySet<string>): string {
  const base = identifierFromName(name);
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${base}-${String(suffix)}`;
  }
  return candidate;
}

/** The fields users edit as text, where an empty box means the field is not set. */
function textFields(details: ToolDetails): Record<string, string> {
  const fields: Record<string, string> = { name: details.name.trim() };
  for (const key of ['category', 'description', 'interpreter'] as const) {
    const value = details[key]?.trim();
    if (value !== undefined && value !== '') {
      fields[key] = value;
    }
  }
  return fields;
}

/**
 * Builds the same manifest a package would hold, so a registered program can be exported later.
 * Leftovers are kept because many launchers and batch files start the real program and exit, and
 * ending what they left would close it at once. Cancelling still ends everything.
 */
export function createRegisteredManifest(details: ProgramDetails, id: string): ToolManifest {
  return toolManifestSchema.parse({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    version: REGISTERED_VERSION,
    level: 0,
    ...textFields(details),
    leftoverProcesses: 'keep',
    run: { program: details.program },
  });
}

export interface RegistrationFailure {
  readonly program: string;
  readonly message: string;
}

export interface RegistrationReport {
  readonly registered: readonly RegisteredTool[];
  readonly failures: readonly RegistrationFailure[];
}

/** Ids in use, in a scope and in the global one it sees. A broken tool still holds its folder. */
async function takenIds(registry: ToolRegistry, scope: InstallScope): Promise<Set<string>> {
  const scopes = scope.kind === 'global' ? [scope] : [scope, GLOBAL_SCOPE];
  const lists = await Promise.all(scopes.map((item) => registry.list(item)));
  return new Set(
    lists.flatMap(({ tools, problems }) => [
      ...tools.map((tool) => tool.manifest.id),
      ...problems.map((problem) => problem.folder),
    ]),
  );
}

/** Registers programs in one scope. One bad entry does not stop the others. */
export async function registerPrograms(
  registry: ToolRegistry,
  programs: readonly ProgramDetails[],
  scope: InstallScope = GLOBAL_SCOPE,
): Promise<RegistrationReport> {
  const taken = await takenIds(registry, scope);
  const registered: RegisteredTool[] = [];
  const failures: RegistrationFailure[] = [];
  for (const details of programs) {
    try {
      const id = uniqueIdentifier(details.name, taken);
      const tool = await registry.register(createRegisteredManifest(details, id), { scope });
      taken.add(id);
      registered.push(tool);
    } catch (error) {
      failures.push({
        program: details.program,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { registered, failures };
}

export interface ToolChanges extends ToolDetails {
  /** A new path, which lets a registered program point through a path variable. */
  readonly program?: string | undefined;
}

function changedRun(manifest: ToolManifest, program: string | undefined): object {
  if (program === undefined || manifest.level === 2 || program === manifest.run.program) {
    return {};
  }
  if (!isAbsolute(program) && !win32.isAbsolute(program) && !startsWithPathVariable(program)) {
    throw new DefinitionError('A program must be an absolute path or start with a path variable');
  }
  return { run: { ...manifest.run, program } };
}

/** Changes what the user can edit about a tool. Its id, and so its folder, stays the same. */
export async function updateToolDetails(
  registry: ToolRegistry,
  id: string,
  details: ToolChanges,
  scope: InstallScope = GLOBAL_SCOPE,
): Promise<RegisteredTool | undefined> {
  const tool = await registry.get(id, scope);
  if (tool === undefined) {
    return undefined;
  }
  const kept: Record<string, unknown> = { ...tool.manifest };
  delete kept['category'];
  delete kept['description'];
  delete kept['interpreter'];
  const manifest = toolManifestSchema.parse({
    ...kept,
    ...textFields(details),
    ...changedRun(tool.manifest, details.program),
  });
  return registry.register(manifest, { replace: true, scope });
}
