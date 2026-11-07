import { listProfiles, removeProfile } from '../profiles/profile-store.js';
import type { ToolRegistry } from '../registry/tool-registry.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { GLOBAL_SCOPE } from '../storage/data-directory.js';
import type { InstallScope } from '../storage/data-directory.js';

/**
 * Removes a tool, its profiles and their secrets. Its past runs stay, as evidence, and they do not
 * need the tool: each one holds the name it ran under.
 */
export async function removeTool(
  registry: ToolRegistry,
  id: string,
  store: SecretStore,
  scope: InstallScope = GLOBAL_SCOPE,
): Promise<boolean> {
  const tool = await registry.get(id, scope);
  if (tool !== undefined) {
    for (const profile of await listProfiles(tool)) {
      await removeProfile(tool, profile.id, store);
    }
  }
  return registry.remove(id, scope);
}
