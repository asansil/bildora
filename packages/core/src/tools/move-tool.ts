import { listProfiles, profileSecretKey } from '../profiles/profile-store.js';
import type { RegisteredTool, ToolRegistry } from '../registry/tool-registry.js';
import type { SecretStore } from '../secrets/secret-store.js';
import { toolDirectory } from '../storage/data-directory.js';
import type { InstallScope } from '../storage/data-directory.js';
import { DefinitionError } from '../storage/definition-error.js';

/**
 * Moves a tool, with its profiles and secrets, to another scope. Secrets are copied first and the
 * originals go last, so a failure at any point leaves the tool working where it was.
 */
export async function moveTool(
  registry: ToolRegistry,
  id: string,
  from: InstallScope,
  to: InstallScope,
  store: SecretStore,
): Promise<RegisteredTool> {
  const tool = await registry.get(id, from);
  if (tool === undefined) {
    throw new DefinitionError(`Tool "${id}" is not installed in this scope`);
  }
  if (await registry.has(id, to)) {
    throw new DefinitionError(`Tool "${id}" is already installed in the other scope`);
  }
  const target: RegisteredTool = {
    ...tool,
    scope: to,
    directory: toolDirectory(registry.dataDir, to, id),
  };

  const keys = (await listProfiles(tool)).flatMap((profile) =>
    profile.secrets.map((parameter) => ({
      source: profileSecretKey(tool, profile.id, parameter),
      copy: profileSecretKey(target, profile.id, parameter),
    })),
  );
  const copied: string[] = [];
  try {
    for (const { source, copy } of keys) {
      const value = await store.get(source);
      if (value !== undefined) {
        await store.set(copy, value);
        copied.push(copy);
      }
    }
    await registry.move(id, from, to);
  } catch (error) {
    await Promise.allSettled(copied.map((key) => store.delete(key)));
    throw error;
  }
  for (const { source } of keys) {
    await store.delete(source);
  }
  return target;
}
