import {
  automationProblem,
  automationRuleIssues,
  blockingProblems,
  comparable,
  comparedType,
  endGuarantee,
  findStepOutputReferences,
  findUnknownReferences,
  guarantees,
  isExpressionValue,
  operatorsFor,
  typeOfParameter,
  typeWord,
} from '@bildora/protocol';
import type {
  AutomationBlock,
  AutomationCondition,
  Automation,
  AutomationProblem,
  ForBlock,
  Guarantee,
  RunAutomationBlock,
  RunBlock,
  ToolParameter,
  ValueType,
} from '@bildora/protocol';
import { getProfile, isSecretParameter } from '../profiles/profile-store.js';
import type { Profile } from '../profiles/profile-store.js';
import type { RegisteredTool, ToolRegistry } from '../registry/tool-registry.js';
import { findVisibleTool } from '../workspaces/visible-tools.js';
import {
  checkExpression,
  found,
  insideLoop,
  isDisabledBlock,
  linkCycleProblems,
  loopsBetween,
  parametersOf,
  readerOf,
} from './automation-values.js';
import type { Found, Reader, ValueContext } from './automation-values.js';
import { leafTree } from './call-tree.js';
import type { CallTree } from './call-tree.js';

export type { AutomationProblem } from '@bildora/protocol';

type StepValue = NonNullable<RunBlock['values']>[string];

function hasRightType(
  parameter: Pick<ToolParameter, 'type'> & { readonly choices?: readonly string[] },
  value: StepValue,
): boolean {
  switch (parameter.type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'choice':
      return typeof value === 'string' && (parameter.choices ?? []).includes(value);
    default:
      return typeof value === 'string';
  }
}

/** References in text, `{{steps.<id>.outputs.<name>}}`, which text and path values can hold. */
function checkReferences(
  context: ValueContext,
  certain: Guarantee,
  text: string,
  label: string,
  reader: Reader,
): readonly Found[] {
  const { automation, tools } = context;
  const problems = findUnknownReferences(text).map((reference) =>
    found('reference-unknown', { reference }),
  );
  for (const { step, output, field } of findStepOutputReferences(text)) {
    const source = automation.blocks.find(({ id }) => id === step);
    if (source?.type !== 'run') {
      problems.push(found('reference-not-run', { source: step }));
      continue;
    }
    const manifest = tools.get(step)?.manifest;
    if (manifest?.level === 1) {
      const declared = manifest.outputs.find(({ name }) => name === output);
      const params = { label: output, source: step, output, field: field ?? '' };
      if (declared === undefined) {
        problems.push(found('reference-output-unknown', params));
      } else if (field !== undefined) {
        const known =
          'json' in declared ? declared.fields.find(({ name }) => name === field) : undefined;
        if (known === undefined) problems.push(found('output-field-unknown', params));
        else if (known.secret) problems.push(found('output-field-secret', params));
      }
    }
    if (manifest?.level === 0) {
      problems.push(found('reference-level-0', { source: step }));
    }
    if (isDisabledBlock(automation, step)) {
      problems.push(found('output-from-disabled', { label, source: step }));
    }
    // A reference in text reads one value, so it cannot read a block of another loop's rounds.
    const inLoop = (source.loop ?? '') !== '' && !reader.loops.includes(source.loop ?? '');
    if (inLoop || !certain.completed.has(step)) {
      problems.push(found('reference-not-certain', { source: step }));
    }
  }
  return problems;
}

function checkValues(
  context: ValueContext,
  certain: Guarantee,
  step: RunBlock,
  tool: RegisteredTool,
  reader: Reader,
): readonly Found[] {
  const parameters = parametersOf(tool);
  const problems: Found[] = [];
  for (const [name, value] of Object.entries(step.values ?? {})) {
    const parameter = parameters.find((candidate) => candidate.name === name);
    if (parameter === undefined) {
      problems.push(found('parameter-unknown', { parameter: name }));
    } else if (isSecretParameter(parameter)) {
      // The problem does not repeat the value, which should not be in a shared file at all.
      problems.push(found('parameter-secret', { parameter: name, label: parameter.label }));
    } else if (isExpressionValue(value)) {
      problems.push(
        ...checkExpression(
          context,
          certain,
          value.expression,
          parameter.label,
          reader,
          parameter.type,
        ).problems,
      );
    } else if (!hasRightType(parameter, value)) {
      problems.push(
        found('parameter-type', { parameter: name, label: parameter.label, type: parameter.type }),
      );
    } else if (
      typeof value === 'string' &&
      (parameter.type === 'path' || parameter.type === 'string')
    ) {
      problems.push(...checkReferences(context, certain, value, parameter.label, reader));
    }
  }
  return problems;
}

function checkRequired(step: RunBlock, tool: RegisteredTool, profile?: Profile): readonly Found[] {
  return parametersOf(tool)
    .filter(
      ({ name, required, default: fallback }) =>
        required &&
        fallback === undefined &&
        step.values?.[name] === undefined &&
        profile?.values[name] === undefined &&
        profile?.secrets.includes(name) !== true,
    )
    .map(({ name, label }) => found('parameter-required', { parameter: name, label }));
}

/** The items of a For: a list, a folder, or a whole number of times. */
function checkItems(
  context: ValueContext,
  certain: Guarantee,
  block: ForBlock,
  reader: Reader,
): readonly Found[] {
  const { items } = block;
  const label = block.id;
  const source =
    items.kind === 'list' ? items.list : items.kind === 'folder' ? items.folder : items.count;
  if (!isExpressionValue(source)) {
    return typeof source === 'string'
      ? checkReferences(context, certain, source, label, reader)
      : [];
  }
  const checked = checkExpression(context, certain, source.expression, label, reader);
  const wanted: Record<typeof items.kind, (type: ValueType) => boolean> = {
    list: (type) => type === 'list',
    folder: (type) => type === 'path' || type === 'text',
    count: (type) => type === 'integer',
  };
  const words = { list: 'a list', folder: 'a folder', count: 'a whole number' };
  if (checked.type === undefined || wanted[items.kind](checked.type)) return checked.problems;
  return [
    ...checked.problems,
    found('loop-items-type', {
      label,
      detail: `they need ${words[items.kind]}, and this is ${typeWord(checked.type)}`,
    }),
  ];
}

/** The values a Run automation block gives the inputs of the automation it calls. */
function checkCallInputs(
  context: ValueContext,
  certain: Guarantee,
  block: RunAutomationBlock,
  called: Automation,
  reader: Reader,
): readonly Found[] {
  const start = called.blocks.find(({ type }) => type === 'start');
  const declared = start?.type === 'start' ? (start.inputs ?? []) : [];
  const problems: Found[] = [];
  for (const [name, value] of Object.entries(block.inputs ?? {})) {
    const input = declared.find((candidate) => candidate.name === name);
    if (input === undefined) {
      problems.push(found('call-input-unknown', { automation: called.name, input: name }));
    } else if (isExpressionValue(value)) {
      const label = input.label ?? input.name;
      problems.push(
        ...checkExpression(context, certain, value.expression, label, reader, input.type).problems,
      );
    } else if (!hasRightType(input, value)) {
      const type = typeWord(typeOfParameter(input.type));
      problems.push(found('call-input-type', { input: input.label ?? input.name, type }));
    } else if (typeof value === 'string' && (input.type === 'path' || input.type === 'string')) {
      problems.push(...checkReferences(context, certain, value, input.label ?? input.name, reader));
    }
  }
  for (const input of declared) {
    if (
      input.required === true &&
      input.default === undefined &&
      block.inputs?.[input.name] === undefined
    ) {
      problems.push(
        found('call-input-required', {
          automation: called.name,
          input: input.name,
          label: input.label ?? input.name,
        }),
      );
    }
  }
  return problems;
}

async function findTool(
  registry: ToolRegistry,
  workspaceId: string,
  id: string,
): Promise<RegisteredTool | undefined> {
  try {
    return await findVisibleTool(registry, workspaceId, id);
  } catch {
    return undefined;
  }
}

/** The name of a rule in problems, such as `Rule 2` or `Rule 1 of case "big"`. */
function ruleLabel(index: number, caseId: string | undefined): string {
  const rule = `Rule ${String(index + 1)}`;
  return caseId === undefined ? rule : `${rule} of case "${caseId}"`;
}

/** Rules that read what a block left, which has to exist whichever way the run got there. */
function checkConditions(
  context: ValueContext,
  blockId: string,
  condition: AutomationCondition,
  certain: Guarantee,
  reader: Reader,
  caseId?: string,
): readonly Found[] {
  const { automation } = context;
  const problems: Found[] = [];
  condition.rules.forEach((rule, index) => {
    const label = ruleLabel(index, caseId);
    if (rule.field === 'value') {
      const read = checkExpression(context, certain, rule.read.expression, label, reader);
      problems.push(...read.problems);
      if (read.type === undefined) return;
      if (!operatorsFor(read.type).includes(rule.operator)) {
        problems.push(
          found('expression-type', {
            label,
            detail: `"${rule.operator}" does not work on ${typeWord(read.type)}`,
          }),
        );
        return;
      }
      const wanted = comparedType(read.type, rule.operator);
      if (wanted === undefined || rule.value === undefined) return;
      let given: ValueType | undefined;
      if (isExpressionValue(rule.value)) {
        const value = checkExpression(context, certain, rule.value.expression, label, reader);
        problems.push(...value.problems);
        given = value.type;
      } else {
        given =
          typeof rule.value === 'boolean'
            ? 'boolean'
            : typeof rule.value === 'number'
              ? Number.isInteger(rule.value)
                ? 'integer'
                : 'number'
              : 'text';
      }
      if (given !== undefined && !comparable(given, wanted)) {
        problems.push(
          found('expression-type', {
            label,
            detail: `it compares ${typeWord(read.type)} with ${typeWord(given)}`,
          }),
        );
      }
      return;
    }
    const source = automation.blocks.find(({ id }) => id === rule.block);
    // A result or exit code is one value, so it cannot come from another loop's rounds.
    if (source !== undefined && loopsBetween(automation, source.id, reader).length > 0) {
      problems.push(found('rule-block-in-loop', { source: rule.block }));
      return;
    }
    if (rule.field !== 'exit-code') return;
    if (source?.type !== 'run') {
      problems.push(found('exit-code-not-run', { source: rule.block }));
    } else if (source.disabled === true) {
      problems.push(found('exit-code-from-disabled', { label, source: rule.block }));
    } else if (!certain.ran.has(rule.block)) {
      problems.push(found('exit-code-not-certain', { source: rule.block, block: blockId }));
    }
  });
  return problems;
}

/** Reads the tools and profiles of an automation's run blocks, as its Workspace sees them. */
async function knownTools(
  automation: Automation,
  registry: ToolRegistry,
  workspaceId: string,
): Promise<{
  tools: Map<string, RegisteredTool>;
  profiles: Map<string, Profile>;
  missingProfiles: Set<string>;
}> {
  const tools = new Map<string, RegisteredTool>();
  const profiles = new Map<string, Profile>();
  const missingProfiles = new Set<string>();
  for (const block of automation.blocks) {
    if (block.type !== 'run') continue;
    const tool = await findTool(registry, workspaceId, block.tool);
    if (tool === undefined) continue;
    tools.set(block.id, tool);
    if (block.profile === undefined) continue;
    const profile = await getProfile(tool, block.profile).catch(() => undefined);
    if (profile === undefined) missingProfiles.add(block.id);
    else profiles.set(block.id, profile);
  }
  return { tools, profiles, missingProfiles };
}

/** Checks one automation of a call tree, with what is known of the ones it calls. */
async function checkTree(
  tree: CallTree,
  registry: ToolRegistry,
  workspaceId: string,
): Promise<{ problems: AutomationProblem[]; context: ValueContext }> {
  const { automation } = tree;
  const known = guarantees(automation);
  const nobody: Guarantee = { completed: new Set(), ran: new Set() };
  const { tools, profiles, missingProfiles } = await knownTools(automation, registry, workspaceId);
  const calls = new Map<string, ValueContext>();
  const calledProblems = new Map<string, number>();
  for (const [blockId, child] of tree.calls) {
    const checked = await checkTree(child, registry, workspaceId);
    calls.set(blockId, checked.context);
    calledProblems.set(blockId, blockingProblems(checked.problems).length);
  }
  const context: ValueContext = { automation, tools, profiles, calls };

  // Rules a half-built flow may break: saved as it is, but not run.
  const problems: AutomationProblem[] = automationRuleIssues(automation).map(
    ({ code, params, blockId, message }) => ({
      code,
      params,
      ...(blockId === undefined ? {} : { blockId }),
      message,
    }),
  );
  problems.push(...tree.problems);
  for (const block of automation.blocks) {
    const certain = known.get(block.id) ?? nobody;
    const reader = readerOf(automation, block.id);
    const report = ({ code, params }: Found): void => {
      problems.push(automationProblem(code, params, block.id));
    };
    checkBlock(context, block, certain, reader, tree, calledProblems).forEach(report);
    if (block.type !== 'run') {
      continue;
    }
    const tool = tools.get(block.id);
    if (tool === undefined) {
      report(found('tool-missing', { tool: block.tool }));
      continue;
    }
    if (block.profile !== undefined && missingProfiles.has(block.id)) {
      report(found('profile-missing', { profile: block.profile }));
    }
    checkValues(context, certain, block, tool, reader).forEach(report);
    checkRequired(block, tool, profiles.get(block.id)).forEach(report);
  }
  for (const { blockId, problem } of linkCycleProblems(context)) {
    problems.push(automationProblem(problem.code, problem.params, blockId));
  }
  return { problems, context };
}

/** What blocks other than Run tool check: conditions, loops and calls. */
function checkBlock(
  context: ValueContext,
  block: AutomationBlock,
  certain: Guarantee,
  reader: Reader,
  tree: CallTree,
  calledProblems: ReadonlyMap<string, number>,
): readonly Found[] {
  switch (block.type) {
    case 'if':
      return checkConditions(context, block.id, block.condition, certain, reader);
    case 'switch':
      return block.cases.flatMap(({ id, condition }) =>
        checkConditions(context, block.id, condition, certain, reader, id),
      );
    case 'while': {
      // Read with what the previous round left, as if from inside: every path of a round has ended.
      const inside = insideLoop(context.automation, block.id);
      const end = endGuarantee(context.automation, block.id);
      const checked = checkExpression(context, end, block.condition.expression, block.id, inside);
      if (checked.type === undefined || checked.type === 'boolean') return checked.problems;
      return [
        ...checked.problems,
        found('loop-condition-type', {
          label: block.id,
          detail: `it gives ${typeWord(checked.type)}`,
        }),
      ];
    }
    case 'for':
      return checkItems(context, certain, block, reader);
    case 'run-automation': {
      const called = tree.calls.get(block.id)?.automation;
      // A call that cannot be made is already in the tree's problems.
      if (called === undefined) return [];
      const problems = [...checkCallInputs(context, certain, block, called, reader)];
      const count = calledProblems.get(block.id) ?? 0;
      if (count > 0) {
        problems.push(
          found('called-automation-problems', { automation: called.name, count: String(count) }),
        );
      }
      return problems;
    }
    default:
      return [];
  }
}

/**
 * Checks an automation against what is installed in its Workspace. It only reports: an automation
 * whose tool has gone stays as it was, and works again if the tool comes back. `calls` holds the
 * automations it can call, read with `readCallTree`; without it, calls are not checked.
 */
export async function checkAutomation(
  automation: Automation,
  registry: ToolRegistry,
  workspaceId: string,
  calls?: CallTree,
): Promise<readonly AutomationProblem[]> {
  const tree = calls ?? leafTree(automation);
  return (await checkTree(tree, registry, workspaceId)).problems;
}
