import { automationSchema } from '@bildora/protocol';
import type {
  AutomationV1,
  AutomationV1Step,
  Automation,
  AutomationInput,
} from '@bildora/protocol';

type Block = AutomationInput['blocks'][number];
type Connection = AutomationInput['connections'][number];

export type ConversionResult =
  | { readonly ok: true; readonly automation: Automation }
  | { readonly ok: false; readonly problems: readonly string[] };

/** A place a path leaves from, waiting to be joined to whatever comes next. */
interface Exit {
  readonly id: string;
  readonly output: 'next' | 'error';
}

interface Piece {
  readonly first: string | undefined;
  readonly exits: readonly Exit[];
}

class Unconvertible extends Error {}

const ID_MAX = 56;

/**
 * Turns an automation written as a list of steps into blocks and connections.
 *
 * Steps become a chain after a Start block. A step set to continue gets an Error output that leads
 * to the next block. A background step and the step that waits for it become a Parallel and a
 * Join, and one nobody waits for is joined at the end. Overlapping background steps that do not
 * nest cannot convert. A `continue` on the very last step has no next block to lead to, so there
 * the converted automation stops where the old one carried on.
 */
export function convertAutomationV1(automation: AutomationV1): ConversionResult {
  try {
    const converted = new Converter(automation.steps).convert(automation);
    const checked = automationSchema.safeParse(converted);
    if (!checked.success) {
      return { ok: false, problems: checked.error.issues.map((issue) => issue.message) };
    }
    return { ok: true, automation: checked.data };
  } catch (error) {
    if (error instanceof Unconvertible) return { ok: false, problems: [error.message] };
    throw error;
  }
}

class Converter {
  private readonly blocks: Block[] = [];
  private readonly connections: Connection[] = [];
  private readonly steps: readonly AutomationV1Step[];
  private readonly taken: Set<string>;

  constructor(steps: readonly AutomationV1Step[]) {
    this.steps = steps;
    this.taken = new Set(steps.map(({ id }) => id));
  }

  convert(automation: AutomationV1): AutomationInput {
    const start = this.unique('start');
    this.blocks.push({ id: start, type: 'start', mode: 'button' });
    const body = this.sequence(0, this.steps.length);
    if (body.first !== undefined) this.connections.unshift({ from: start, to: body.first });
    return {
      schemaVersion: 2,
      id: automation.id,
      name: automation.name,
      ...(automation.description === undefined ? {} : { description: automation.description }),
      blocks: this.blocks,
      connections: this.connections,
    };
  }

  private unique(base: string): string {
    const stem = base.slice(0, ID_MAX);
    let id = stem;
    for (let n = 2; this.taken.has(id); n += 1) id = `${stem}-${String(n)}`;
    this.taken.add(id);
    return id;
  }

  private link(exits: readonly Exit[], to: string): void {
    for (const { id, output } of exits) {
      this.connections.push(output === 'next' ? { from: id, to } : { from: id, output, to });
    }
  }

  /** Index of the step that waits for the background step at `index`, or the end of the list. */
  private waitFor(index: number): number {
    const background = this.steps[index];
    const found = this.steps.findIndex(
      (step, at) =>
        at > index && step.type === 'wait-for-completion' && step.step === background?.id,
    );
    return found === -1 ? this.steps.length : found;
  }

  /** Converts steps `from` up to, not including, `to`. */
  private sequence(from: number, to: number): Piece {
    let first: string | undefined;
    let exits: readonly Exit[] = [];
    const append = (entry: string, after: readonly Exit[]): void => {
      if (first === undefined) first = entry;
      else this.link(exits, entry);
      exits = after;
    };

    for (let index = from; index < to; index += 1) {
      const step = this.steps[index];
      if (step === undefined || step.type === 'wait-for-completion') continue;

      if (step.type === 'run' && step.background === true) {
        const wait = this.waitFor(index);
        const waited = wait < this.steps.length;
        if (waited ? wait >= to : to !== this.steps.length) {
          throw new Unconvertible(
            `Background step "${step.id}" overlaps another one without nesting inside it, so it cannot be converted. Rearrange the steps so that each background step is waited for inside the one around it.`,
          );
        }
        const waiting = this.steps[wait];
        const policy = waiting?.type === 'wait-for-completion' ? waiting.onFailure : undefined;
        if (wait === index + 1) {
          // Nothing runs beside it, so the step simply blocks and the wait only sets its policy.
          const plain = this.blockFor(step, policy);
          this.blocks.push(plain.block);
          append(step.id, plain.exits);
        } else {
          append(...this.parallel(step, index, wait, policy));
        }
        index = wait;
        continue;
      }

      const plain = this.blockFor(step, step.type === 'wait-for-time' ? undefined : step.onFailure);
      this.blocks.push(plain.block);
      append(step.id, plain.exits);
    }
    return { first, exits };
  }

  /** A Parallel of the background step and what runs beside it, ended by a Join. */
  private parallel(
    step: Extract<AutomationV1Step, { type: 'run' }>,
    index: number,
    wait: number,
    policy: 'stop' | 'continue' | undefined,
  ): [string, readonly Exit[]] {
    const parallel = this.unique(`${step.id}-parallel`);
    this.blocks.push({ id: parallel, type: 'parallel' });
    const background = this.blockFor(step, policy);
    this.blocks.push(background.block);
    const beside = this.sequence(index + 1, wait);
    const first = beside.first;
    if (first === undefined) throw new Unconvertible(`Nothing runs beside "${step.id}"`);
    const join = this.unique(`${step.id}-join`);
    this.blocks.push({ id: join, type: 'join', parallel });
    this.link([{ id: parallel, output: 'next' }], step.id);
    this.link([{ id: parallel, output: 'next' }], first);
    this.link(background.exits, join);
    this.link(beside.exits, join);
    return [parallel, [{ id: join, output: 'next' }]];
  }

  private blockFor(
    step: AutomationV1Step,
    policy:
      | 'stop'
      | 'continue'
      | { readonly retry: { attempts: number; delaySeconds?: number | undefined } }
      | undefined,
  ): { block: Block; exits: Exit[] } {
    const next: Exit = { id: step.id, output: 'next' };
    const onError: Exit = { id: step.id, output: 'error' };
    switch (step.type) {
      case 'run': {
        const kept = policy === 'continue' || policy === undefined ? {} : { onFailure: policy };
        const block: Block = {
          id: step.id,
          type: 'run',
          tool: step.tool,
          ...(step.profile === undefined ? {} : { profile: step.profile }),
          ...(step.values === undefined ? {} : { values: step.values }),
          ...kept,
        };
        return { block, exits: policy === 'continue' ? [next, onError] : [next] };
      }
      case 'wait-for-time':
        return { block: step, exits: [next] };
      case 'wait-for-manual-action':
        return {
          block: { id: step.id, type: step.type, message: step.message },
          exits: policy === 'continue' ? [next, onError] : [next],
        };
      case 'wait-for-completion':
        throw new Unconvertible(`Step "${step.id}" waits for a step that is not a background step`);
    }
  }
}
