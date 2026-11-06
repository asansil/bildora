import type { RegisteredTool } from '../registry/tool-registry.js';
import { resolveExecutable } from '../runner/resolve-executable.js';

export type RuntimeStatus =
  | { readonly status: 'ready' }
  | { readonly status: 'missing-program'; readonly program: string }
  | { readonly status: 'missing-interpreter'; readonly interpreter: string };

export interface RuntimeCheckOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Tells whether a tool can start, without starting anything. */
export async function checkRuntime(
  tool: RegisteredTool,
  options: RuntimeCheckOptions = {},
): Promise<RuntimeStatus> {
  const { manifest, directory } = tool;
  const env = options.env === undefined ? {} : { env: options.env };
  if (manifest.level !== 2) {
    const { program } = manifest.run;
    const found = await resolveExecutable(program, { ...env, searchFirst: [directory] });
    if (found === undefined) {
      return { status: 'missing-program', program };
    }
  }
  const { interpreter } = manifest;
  if (interpreter !== undefined && (await resolveExecutable(interpreter, env)) === undefined) {
    return { status: 'missing-interpreter', interpreter };
  }
  return { status: 'ready' };
}

export interface ToolGroup {
  /** Absent for the tools that declare no category, which always come last. */
  readonly category?: string;
  readonly tools: readonly RegisteredTool[];
}

function byName(first: RegisteredTool, second: RegisteredTool): number {
  return first.manifest.name.localeCompare(second.manifest.name);
}

/**
 * Derives categories from the tools themselves, so they appear and disappear with what is
 * installed. Names differing only in case are one category, shown as the first spelling found.
 */
export function groupByCategory(tools: readonly RegisteredTool[]): readonly ToolGroup[] {
  const groups = new Map<string, { label: string; tools: RegisteredTool[] }>();
  const uncategorized: RegisteredTool[] = [];
  for (const tool of tools) {
    const { category } = tool.manifest;
    if (category === undefined) {
      uncategorized.push(tool);
      continue;
    }
    const key = category.toLocaleLowerCase('en');
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { label: category, tools: [tool] });
    } else {
      group.tools.push(tool);
    }
  }
  const named = [...groups.values()]
    .sort((first, second) => first.label.localeCompare(second.label))
    .map((group): ToolGroup => ({ category: group.label, tools: group.tools.sort(byName) }));
  return uncategorized.length === 0 ? named : [...named, { tools: uncategorized.sort(byName) }];
}
