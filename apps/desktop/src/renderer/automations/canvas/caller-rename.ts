import { editBlockExpressions, renameCalledInExpression } from '@bildora/protocol';
import type { AutomationBlock } from '@bildora/protocol';

/** An automation as far as following its calls needs it. */
export interface CallingFlow {
  readonly id: string;
  readonly name: string;
  readonly blocks: readonly AutomationBlock[];
}

/** A block of `called` renamed from `from` to `to`. */
export interface CalledRename {
  readonly called: string;
  readonly from: string;
  readonly to: string;
}

/**
 * The blocks of `caller` with every read of the renamed block, through any chain of calls that ends
 * at the renamed automation, written with its new name. Gives nothing when no read changes.
 */
export function renamedCallerBlocks(
  caller: CallingFlow,
  automations: readonly CallingFlow[],
  rename: CalledRename,
): AutomationBlock[] | undefined {
  const byId = new Map(automations.map((automation) => [automation.id, automation]));
  /** The automation a chain of Run automation blocks leads to, from `caller`. */
  const reached = (calls: readonly string[]): string | undefined => {
    let at: CallingFlow | undefined = caller;
    for (const call of calls) {
      const block: AutomationBlock | undefined = at?.blocks.find(({ id }) => id === call);
      if (block?.type !== 'run-automation') return undefined;
      at = byId.get(block.automation);
    }
    return at?.id;
  };
  const changed: string[] = [];
  const blocks = caller.blocks.map((block) =>
    editBlockExpressions(block, (expression) => {
      const next = renameCalledInExpression(expression, (calls, id) =>
        id === rename.from && reached(calls) === rename.called ? rename.to : undefined,
      );
      if (next !== expression) changed.push(next);
      return next;
    }),
  );
  return changed.length > 0 ? blocks : undefined;
}

/** The automations whose links a rename in `called` would change, in the order given. */
export function affectedCallers(
  automations: readonly CallingFlow[],
  rename: CalledRename,
): CallingFlow[] {
  return automations.filter(
    (automation) =>
      automation.id !== rename.called &&
      renamedCallerBlocks(automation, automations, rename) !== undefined,
  );
}
