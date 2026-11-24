import { CALL_DEPTH_MAX, automationProblem } from '@bildora/protocol';
import type { Automation, AutomationProblem } from '@bildora/protocol';

/**
 * An automation with every automation it can call, read once when a run starts, so that checking
 * and running see the same files.
 */
export interface CallTree {
  readonly automation: Automation;
  /** What each Run automation block calls, by block id. A call that cannot be made is left out. */
  readonly calls: ReadonlyMap<string, CallTree>;
  /**
   * Why calls cannot be made: a missing automation, a circle of calls, or calls too deep. Each is
   * filed under the Run automation block of this automation that leads to it.
   */
  readonly problems: readonly AutomationProblem[];
}

/** Reads an automation of the Workspace, or gives undefined when there is none or it is unreadable. */
export type AutomationLoader = (id: string) => Promise<Automation | undefined>;

/** A tree with no calls, for an automation that calls nothing or whose calls are not read. */
export function leafTree(automation: Automation): CallTree {
  return { automation, calls: new Map(), problems: [] };
}

/**
 * Reads every automation `automation` can call. It refuses an automation that ends up calling
 * itself, and goes at most `CALL_DEPTH_MAX` automations deep, the first one included.
 */
export async function readCallTree(
  automation: Automation,
  load: AutomationLoader,
): Promise<CallTree> {
  const loaded = new Map<string, Promise<Automation | undefined>>();
  const read = (id: string): Promise<Automation | undefined> => {
    let found = loaded.get(id);
    if (found === undefined) {
      found = load(id).catch(() => undefined);
      loaded.set(id, found);
    }
    return found;
  };

  /** `chain` holds the automations from the first one down to `current`, as ids. */
  const visit = async (
    current: Automation,
    chain: readonly string[],
  ): Promise<{ tree: CallTree; deep: AutomationProblem[] }> => {
    const calls = new Map<string, CallTree>();
    const problems: AutomationProblem[] = [];
    // Problems further down, which the first automation files under its own block.
    const deep: AutomationProblem[] = [];
    for (const block of current.blocks) {
      if (block.type !== 'run-automation') continue;
      const path = [...chain, block.automation];
      const report = (problem: AutomationProblem): void => {
        problems.push({ ...problem, blockId: block.id });
        deep.push(problem);
      };
      if (chain.includes(block.automation)) {
        report(automationProblem('call-cycle', { reference: path.join(' → ') }));
        continue;
      }
      if (path.length > CALL_DEPTH_MAX) {
        report(automationProblem('call-depth', { reference: path.join(' → ') }));
        continue;
      }
      const called = await read(block.automation);
      if (called === undefined) {
        report(automationProblem('automation-missing', { automation: block.automation }));
        continue;
      }
      const inner = await visit(called, path);
      calls.set(block.id, inner.tree);
      for (const problem of inner.deep) report(problem);
    }
    return { tree: { automation: current, calls, problems }, deep };
  };

  return (await visit(automation, [automation.id])).tree;
}

/** Every automation of a tree, each once, the first one included. */
export function automationsOf(tree: CallTree): Automation[] {
  const found = new Map<string, Automation>();
  const visit = (node: CallTree): void => {
    found.set(node.automation.id, node.automation);
    node.calls.forEach(visit);
  };
  visit(tree);
  return [...found.values()];
}
