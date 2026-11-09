import type { RegisteredTool } from '../registry/tool-registry.js';
import { MissingPathVariableError, expandToolCommand } from '../runner/expand-paths.js';
import type { PathVariables } from '../runner/expand-paths.js';
import { resolveExecutable } from '../runner/resolve-executable.js';

export type RuntimeStatus =
  | { readonly status: 'ready' }
  | { readonly status: 'missing-variable'; readonly variable: string }
  | { readonly status: 'missing-program'; readonly program: string }
  | { readonly status: 'missing-interpreter'; readonly interpreter: string };

export interface RuntimeCheckOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly pathVariables?: PathVariables;
}

/** Tells whether a tool can start, without starting anything. */
export async function checkRuntime(
  tool: RegisteredTool,
  options: RuntimeCheckOptions = {},
): Promise<RuntimeStatus> {
  let expanded: RegisteredTool;
  try {
    expanded = expandToolCommand(tool, options.pathVariables ?? new Map<string, string>());
  } catch (error) {
    if (error instanceof MissingPathVariableError) {
      return { status: 'missing-variable', variable: error.variable };
    }
    throw error;
  }
  const { manifest, directory } = expanded;
  const env = options.env === undefined ? {} : { env: options.env };
  const { program } = manifest.run;
  const found = await resolveExecutable(program, { ...env, searchFirst: [directory] });
  if (found === undefined) {
    return { status: 'missing-program', program };
  }
  const { interpreter } = manifest;
  if (interpreter !== undefined && (await resolveExecutable(interpreter, env)) === undefined) {
    return { status: 'missing-interpreter', interpreter };
  }
  return { status: 'ready' };
}

/**
 * The full path of the file a tool starts, as this machine sees it, or undefined when it cannot be
 * found. Only paths are looked at, so the shell can show the file's icon without running anything.
 */
export async function locateProgram(
  tool: RegisteredTool,
  options: RuntimeCheckOptions = {},
): Promise<string | undefined> {
  let expanded: RegisteredTool;
  try {
    expanded = expandToolCommand(tool, options.pathVariables ?? new Map<string, string>());
  } catch (error) {
    if (error instanceof MissingPathVariableError) {
      return undefined;
    }
    throw error;
  }
  const { manifest, directory } = expanded;
  const env = options.env === undefined ? {} : { env: options.env };
  return resolveExecutable(manifest.run.program, { ...env, searchFirst: [directory] });
}

export interface ToolGroup {
  /** Absent for the tools that declare no category, which always come last. */
  readonly category?: string;
  readonly tools: readonly RegisteredTool[];
}

/**
 * Puts named categories in the order a Workspace chose. Those it never placed follow, as they came,
 * and the tools with no category stay last.
 */
export function orderGroups<Group extends { readonly category?: string }>(
  groups: readonly Group[],
  categoryOrder: readonly string[],
): readonly Group[] {
  const position = ({ category }: Group): number => {
    const index = category === undefined ? -1 : categoryOrder.indexOf(categoryKey(category));
    return index === -1 ? categoryOrder.length : index;
  };
  return groups.toSorted((first, second) => {
    if (first.category === undefined || second.category === undefined) {
      return Number(first.category === undefined) - Number(second.category === undefined);
    }
    return position(first) - position(second);
  });
}

/**
 * Moves a category one place up or down the rail. The result lists every shown category, then the
 * ones placed before that are not shown now, which keep their turn for when they return.
 */
export function moveCategory(
  groups: readonly { readonly category?: string }[],
  categoryOrder: readonly string[],
  category: string,
  offset: -1 | 1,
): readonly string[] {
  const shown = orderGroups(groups, categoryOrder).flatMap((group) =>
    group.category === undefined ? [] : [categoryKey(group.category)],
  );
  const key = categoryKey(category);
  const from = shown.indexOf(key);
  const to = from + offset;
  const others = shown.filter((item) => item !== key);
  const moved =
    from === -1 || to < 0 || to >= shown.length
      ? shown
      : [...others.slice(0, to), key, ...others.slice(to)];
  return [...moved, ...categoryOrder.filter((item) => !shown.includes(item))];
}

function byName(first: RegisteredTool, second: RegisteredTool): number {
  return first.manifest.name.localeCompare(second.manifest.name);
}

/** Names differing only in case are one category, and this is what they share. */
export function categoryKey(category: string): string {
  return category.toLocaleLowerCase('en');
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
    const key = categoryKey(category);
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
