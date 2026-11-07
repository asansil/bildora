import { rm } from 'node:fs/promises';
import type { RunHistory } from '../history/run-history.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { automationRunsDirectory, workspaceDirectory } from '../storage/data-directory.js';
import { DefinitionError } from '../storage/definition-error.js';
import { removeTool } from '../tools/remove-tool.js';
import { workspaceScope } from './visible-tools.js';
import { getWorkspace, listWorkspaces } from './workspace-store.js';

/**
 * Deletes a Workspace with its tools, their profiles and secrets, and its past runs. Unlike a
 * removed tool's, these runs would stay out of every view, with no way left to clear them.
 */
export async function removeWorkspace(
  registry: ToolRegistry,
  id: string,
  store: SecretStore,
  history: RunHistory,
): Promise<void> {
  const { dataDir } = registry;
  if ((await getWorkspace(dataDir, id)) === undefined) {
    throw new DefinitionError(`Workspace "${id}" does not exist`);
  }
  const { workspaces } = await listWorkspaces(dataDir);
  if (workspaces.every((workspace) => workspace.id === id)) {
    throw new DefinitionError('The last Workspace cannot be deleted');
  }
  const scope = workspaceScope(id);
  const { tools } = await registry.list(scope);
  for (const tool of tools) {
    await removeTool(registry, tool.manifest.id, store, scope);
  }
  history.removeWorkspace(id);
  await rm(automationRunsDirectory(dataDir, id), { recursive: true, force: true });
  await rm(workspaceDirectory(dataDir, id), { recursive: true, force: true });
}
