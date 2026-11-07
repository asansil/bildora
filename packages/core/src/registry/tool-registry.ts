import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isValidIdentifier } from '@bildora/protocol';
import type { ToolManifest } from '@bildora/protocol';
import { parseManifest, serializeManifest } from '../manifest/parse-manifest.js';
import {
  GLOBAL_SCOPE,
  isMissingFile,
  openDataDirectory,
  resolveDataDir,
  toolDirectory,
  toolsDirectory,
  writeFileAtomic,
} from '../storage/data-directory.js';
import type { DataDirectoryOptions, InstallScope } from '../storage/data-directory.js';
import { DefinitionError } from '../storage/definition-error.js';

const MANIFEST_FILE = 'tool.yaml';

export interface RegisteredTool {
  readonly manifest: ToolManifest;
  readonly scope: InstallScope;
  /** Tool folder, which relative paths in the manifest start from. */
  readonly directory: string;
}

/** Tells tools apart across scopes, where they can share an id. */
export function toolKey(tool: Pick<RegisteredTool, 'manifest' | 'scope'>): string {
  const { scope, manifest } = tool;
  const prefix = scope.kind === 'global' ? 'global' : `workspace/${scope.workspaceId}`;
  return `${prefix}/${manifest.id}`;
}

/** A stored tool that cannot be used. It never hides the healthy tools around it. */
export interface RegistryProblem {
  /** Folder name, which is all that is known about a tool whose manifest cannot be read. */
  readonly folder: string;
  readonly scope: InstallScope;
  readonly message: string;
}

export interface ToolList {
  readonly tools: readonly RegisteredTool[];
  readonly problems: readonly RegistryProblem[];
}

export interface RegisterOptions {
  readonly scope?: InstallScope;
  /** Replaces a tool with the same id in the same scope, which otherwise is an error. */
  readonly replace?: boolean;
}

/**
 * Tools installed in a data directory. Files are the only source of truth, with no index that
 * could disagree with them, so the desktop app and the CLI always see the same tools.
 */
export class ToolRegistry {
  readonly dataDir: string;

  private constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  static async open(options: DataDirectoryOptions = {}): Promise<ToolRegistry> {
    const dataDir = resolveDataDir(options);
    await openDataDirectory(dataDir);
    return new ToolRegistry(dataDir);
  }

  async register(manifest: ToolManifest, options: RegisterOptions = {}): Promise<RegisteredTool> {
    const { scope = GLOBAL_SCOPE, replace = false } = options;
    const directory = toolDirectory(this.dataDir, scope, manifest.id);
    const text = serializeManifest(manifest);
    // The stored text is what later reads will see, so that is what gets validated.
    const stored = parseManifest(text);

    if (!replace && (await this.exists(directory))) {
      throw new DefinitionError(`Tool "${manifest.id}" is already registered in this scope`);
    }
    await mkdir(directory, { recursive: true });
    await writeFileAtomic(join(directory, MANIFEST_FILE), text);
    return { manifest: stored, scope, directory };
  }

  /** Finds a tool in one scope. A tool that exists but cannot be read throws, with the reason. */
  async get(id: string, scope: InstallScope = GLOBAL_SCOPE): Promise<RegisteredTool | undefined> {
    const directory = toolDirectory(this.dataDir, scope, id);
    let text: string;
    try {
      text = await readFile(join(directory, MANIFEST_FILE), 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw error;
    }
    const manifest = parseManifest(text);
    if (manifest.id !== id) {
      throw new DefinitionError(`Folder "${id}" holds the manifest of tool "${manifest.id}"`);
    }
    return { manifest, scope, directory };
  }

  /** Lists one scope. What a Workspace shows, global plus its own, is decided by its caller. */
  async list(scope: InstallScope = GLOBAL_SCOPE): Promise<ToolList> {
    const tools: RegisteredTool[] = [];
    const problems: RegistryProblem[] = [];
    for (const folder of await this.toolFolders(scope)) {
      try {
        const tool = isValidIdentifier(folder) ? await this.get(folder, scope) : undefined;
        if (tool === undefined) {
          problems.push({ folder, scope, message: `No readable ${MANIFEST_FILE} in this folder` });
        } else {
          tools.push(tool);
        }
      } catch (error) {
        problems.push({ folder, scope, message: messageOf(error) });
      }
    }
    return { tools, problems };
  }

  /** Removes a tool and its folder. Returns whether there was anything to remove. */
  async remove(id: string, scope: InstallScope = GLOBAL_SCOPE): Promise<boolean> {
    const directory = toolDirectory(this.dataDir, scope, id);
    const existed = await this.exists(directory);
    await rm(directory, { recursive: true, force: true });
    return existed;
  }

  /** Tells whether a scope holds this id, even in a folder that cannot be read as a tool. */
  async has(id: string, scope: InstallScope = GLOBAL_SCOPE): Promise<boolean> {
    return this.exists(toolDirectory(this.dataDir, scope, id));
  }

  /** Moves a tool's folder, and so its profiles, to another scope. */
  async move(id: string, from: InstallScope, to: InstallScope): Promise<void> {
    const target = toolDirectory(this.dataDir, to, id);
    if (await this.exists(target)) {
      throw new DefinitionError(`Tool "${id}" is already registered in that scope`);
    }
    await mkdir(dirname(target), { recursive: true });
    await rename(toolDirectory(this.dataDir, from, id), target);
  }

  private async exists(directory: string): Promise<boolean> {
    try {
      await readdir(directory);
      return true;
    } catch (error) {
      if (isMissingFile(error)) {
        return false;
      }
      throw error;
    }
  }

  private async toolFolders(scope: InstallScope): Promise<string[]> {
    try {
      const entries = await readdir(toolsDirectory(this.dataDir, scope), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
