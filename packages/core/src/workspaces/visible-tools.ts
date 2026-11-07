import type { RegisteredTool, ToolList, ToolRegistry } from '../registry/tool-registry.js';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import type { InstallScope } from '../storage/data-directory.js';

export function workspaceScope(workspaceId: string): InstallScope {
  return { kind: 'workspace', workspaceId };
}

/**
 * What a Workspace shows: its own tools and the global ones. A tool of its own hides a global tool
 * with the same id, even when damaged, so a listing and a lookup can never disagree.
 */
export async function listVisibleTools(
  registry: ToolRegistry,
  workspaceId: string,
): Promise<ToolList> {
  const own = await registry.list(workspaceScope(workspaceId));
  const global = await registry.list(GLOBAL_SCOPE);
  const taken = new Set([
    ...own.tools.map((tool) => tool.manifest.id),
    ...own.problems.map((problem) => problem.folder),
  ]);
  return {
    tools: [...own.tools, ...global.tools.filter((tool) => !taken.has(tool.manifest.id))],
    problems: [...own.problems, ...global.problems.filter(({ folder }) => !taken.has(folder))],
  };
}

/** Finds the tool an id means inside a Workspace. A damaged tool throws, with the reason. */
export async function findVisibleTool(
  registry: ToolRegistry,
  workspaceId: string,
  id: string,
): Promise<RegisteredTool | undefined> {
  return (
    (await registry.get(id, workspaceScope(workspaceId))) ?? (await registry.get(id, GLOBAL_SCOPE))
  );
}
