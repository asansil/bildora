import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AUTOMATION_SCHEMA_VERSION,
  AUTOMATION_V1_SCHEMA_VERSION,
  automationFileSchema,
  automationV1Schema,
  isValidIdentifier,
} from '@bildora/protocol';
import type { Automation } from '@bildora/protocol';
import { parseDocument, stringify } from 'yaml';
import type { RemovedAutomationRun, RunHistory } from '../history/run-history.js';
import { identifierFromName } from '../import/identifier.js';
import {
  automationRunFolder,
  automationRunsDirectory,
  automationsDirectory,
  isMissingFile,
  writeFileAtomic,
} from '../storage/data-directory.js';
import { DefinitionError } from '../storage/definition-error.js';
import { migrateDefinition } from '../storage/migrations.js';
import type { VersionedFormat } from '../storage/migrations.js';
import { listWorkspaces } from '../workspaces/workspace-store.js';
import { convertAutomationV1 } from './convert-v1.js';

const EXTENSION = '.yaml';
const format: VersionedFormat = {
  label: 'automation',
  versionField: 'schemaVersion',
  currentVersion: AUTOMATION_SCHEMA_VERSION,
  migrations: [],
};

/** A list of steps that cannot become blocks. Its file stays as it is until someone rearranges it. */
export class UnconvertibleAutomationError extends DefinitionError {}

/** A stored automation that cannot be used. It never hides the healthy ones around it. */
export interface AutomationFileProblem {
  readonly file: string;
  readonly message: string;
}

export interface AutomationList {
  /** Sorted by name. */
  readonly automations: readonly Automation[];
  readonly problems: readonly AutomationFileProblem[];
}

/** An automation found by `findAutomations`, with the Workspace that holds it. */
export interface FoundAutomation {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly automation: Automation;
}

function automationFile(dataDir: string, workspaceId: string, id: string): string {
  if (!isValidIdentifier(id)) {
    throw new DefinitionError(`Automation id "${id}" is not valid`);
  }
  return join(automationsDirectory(dataDir, workspaceId), `${id}${EXTENSION}`);
}

function issuesOf(error: { readonly issues: readonly { path: PropertyKey[]; message: string }[] }) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** Turns a list of steps, the format before blocks, into blocks. */
function convertSteps(content: object): Automation {
  const steps = automationV1Schema.safeParse(content);
  if (!steps.success) {
    throw new DefinitionError('The automation is not valid', issuesOf(steps.error));
  }
  const converted = convertAutomationV1(steps.data);
  if (!converted.ok) {
    throw new UnconvertibleAutomationError(
      'The automation is a list of steps that cannot be converted to blocks, and its file is left as it is',
      converted.problems.map((message) => ({ path: '', message })),
    );
  }
  return converted.automation;
}

/**
 * Reads an automation from YAML text. A list of steps is converted to blocks, and the file changes
 * only when the automation is next saved.
 */
export function parseAutomation(text: string): Automation {
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new DefinitionError(
      'The automation is not valid YAML',
      document.errors.map((error) => ({ path: '', message: error.message })),
    );
  }
  const content: unknown = document.toJS();
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new DefinitionError('The automation must be a YAML mapping');
  }
  if ((content as { schemaVersion?: unknown }).schemaVersion === AUTOMATION_V1_SCHEMA_VERSION) {
    return convertSteps(content);
  }
  const result = automationFileSchema.safeParse(migrateDefinition({ ...content }, format));
  if (!result.success) {
    throw new DefinitionError('The automation is not valid', issuesOf(result.error));
  }
  return result.data;
}

/** Finds an automation. One that exists but cannot be read throws, with the reason. */
export async function getAutomation(
  dataDir: string,
  workspaceId: string,
  id: string,
): Promise<Automation | undefined> {
  let text: string;
  try {
    text = await readFile(automationFile(dataDir, workspaceId, id), 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
  const automation = parseAutomation(text);
  if (automation.id !== id) {
    throw new DefinitionError(`The automation in this file has id "${automation.id}"`);
  }
  return automation;
}

export async function listAutomations(
  dataDir: string,
  workspaceId: string,
): Promise<AutomationList> {
  let files: string[];
  try {
    files = await readdir(automationsDirectory(dataDir, workspaceId));
  } catch (error) {
    if (isMissingFile(error)) {
      return { automations: [], problems: [] };
    }
    throw error;
  }
  const automations: Automation[] = [];
  const problems: AutomationFileProblem[] = [];
  for (const file of files.filter((name) => name.endsWith(EXTENSION)).sort()) {
    try {
      const automation = await getAutomation(
        dataDir,
        workspaceId,
        file.slice(0, -EXTENSION.length),
      );
      if (automation !== undefined) {
        automations.push(automation);
      }
    } catch (error) {
      problems.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }
  automations.sort((first, second) => first.name.localeCompare(second.name));
  return { automations, problems };
}

/** Stores an automation, refusing to replace a file it cannot read the way its author meant. */
export async function saveAutomation(
  dataDir: string,
  workspaceId: string,
  automation: Automation,
): Promise<Automation> {
  const checked = automationFileSchema.parse(automation);
  try {
    await getAutomation(dataDir, workspaceId, checked.id);
  } catch (error) {
    // A damaged file may be replaced. One from a newer build, or steps that could not be
    // converted, have to stay.
    if (
      error instanceof UnconvertibleAutomationError ||
      (error instanceof DefinitionError && error.message.includes('Update Bildora'))
    ) {
      throw error;
    }
  }
  await mkdir(automationsDirectory(dataDir, workspaceId), { recursive: true });
  await writeFileAtomic(automationFile(dataDir, workspaceId, checked.id), stringify(checked));
  return checked;
}

/** Makes an id for a new automation, from its name. */
export function newAutomationId(name: string, taken: readonly string[]): string {
  const slug = identifierFromName(name);
  const base = slug === 'tool' || slug.startsWith('tool-') ? `automation-${slug}` : slug;
  let candidate = base;
  for (let suffix = 2; taken.includes(candidate); suffix += 1) {
    candidate = `${base}-${String(suffix)}`;
  }
  return candidate;
}

/** Deletes an automation and its past runs, which no view could reach anymore. */
export async function removeAutomation(
  dataDir: string,
  workspaceId: string,
  id: string,
  history: RunHistory,
): Promise<void> {
  await rm(automationFile(dataDir, workspaceId, id), { force: true });
  history.removeAutomation(workspaceId, id);
  await rm(join(automationRunsDirectory(dataDir, workspaceId), id), {
    recursive: true,
    force: true,
  });
}

/** Deletes the folders of runs whose records went. A folder in use stays until the next time. */
export async function removeRunFolders(
  dataDir: string,
  removed: readonly RemovedAutomationRun[],
): Promise<void> {
  for (const { workspaceId, automationId, runId } of removed) {
    await rm(automationRunFolder(dataDir, workspaceId, automationId, runId), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
}

function sameName(first: string, second: string): boolean {
  return first.toLocaleLowerCase('en') === second.toLocaleLowerCase('en');
}

/**
 * Finds what a person means by an automation, through its id or its name in any case, across every
 * Workspace or in one. The caller decides what to do with none, or with several.
 */
export async function findAutomations(
  dataDir: string,
  wanted: string,
  workspace?: string,
): Promise<readonly FoundAutomation[]> {
  const { workspaces } = await listWorkspaces(dataDir);
  const searched =
    workspace === undefined
      ? workspaces
      : workspaces.filter(({ id, name }) => id === workspace || sameName(name, workspace));
  const found: FoundAutomation[] = [];
  for (const { id: workspaceId, name: workspaceName } of searched) {
    const { automations } = await listAutomations(dataDir, workspaceId);
    for (const automation of automations) {
      if (automation.id === wanted || sameName(automation.name, wanted)) {
        found.push({ workspaceId, workspaceName, automation });
      }
    }
  }
  return found;
}
