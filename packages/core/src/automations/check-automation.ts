import {
  automationProblem,
  automationRuleIssues,
  comparable,
  comparedType,
  findStepOutputReferences,
  findUnknownReferences,
  guarantees,
  isExpressionValue,
  operatorsFor,
  typeWord,
} from '@bildora/protocol';
import type {
  AutomationCondition,
  Automation,
  AutomationProblem,
  Guarantee,
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
  isDisabledBlock,
  linkCycleProblems,
  parametersOf,
} from './automation-values.js';
import type { Found, ValueContext } from './automation-values.js';

export type { AutomationProblem } from '@bildora/protocol';

type StepValue = NonNullable<RunBlock['values']>[string];

function hasRightType(parameter: ToolParameter, value: StepValue): boolean {
  switch (parameter.type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'choice':
      return typeof value === 'string' && parameter.choices.includes(value);
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
    if (!certain.completed.has(step)) {
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
        ...checkExpression(context, certain, value.expression, parameter.label, parameter.type)
          .problems,
      );
    } else if (!hasRightType(parameter, value)) {
      problems.push(
        found('parameter-type', { parameter: name, label: parameter.label, type: parameter.type }),
      );
    } else if (
      typeof value === 'string' &&
      (parameter.type === 'path' || parameter.type === 'string')
    ) {
      problems.push(...checkReferences(context, certain, value, parameter.label));
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
  caseId?: string,
): readonly Found[] {
  const { automation } = context;
  const problems: Found[] = [];
  condition.rules.forEach((rule, index) => {
    const label = ruleLabel(index, caseId);
    if (rule.field === 'value') {
      const read = checkExpression(context, certain, rule.read.expression, label);
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
        const value = checkExpression(context, certain, rule.value.expression, label);
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
    if (rule.field !== 'exit-code') return;
    const source = automation.blocks.find(({ id }) => id === rule.block);
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

/**
 * Checks an automation against what is installed in its Workspace. It only reports: an automation
 * whose tool has gone stays as it was, and works again if the tool comes back.
 */
export async function checkAutomation(
  automation: Automation,
  registry: ToolRegistry,
  workspaceId: string,
): Promise<readonly AutomationProblem[]> {
  const known = guarantees(automation);
  const nobody: Guarantee = { completed: new Set(), ran: new Set() };
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
  const context: ValueContext = { automation, tools, profiles };

  // Rules a half-built flow may break: saved as it is, but not run.
  const problems: AutomationProblem[] = automationRuleIssues(automation).map(
    ({ code, params, blockId, message }) => ({
      code,
      params,
      ...(blockId === undefined ? {} : { blockId }),
      message,
    }),
  );
  for (const block of automation.blocks) {
    const certain = known.get(block.id) ?? nobody;
    const report = ({ code, params }: Found): void => {
      problems.push(automationProblem(code, params, block.id));
    };
    if (block.type === 'if') {
      checkConditions(context, block.id, block.condition, certain).forEach(report);
    }
    if (block.type === 'switch') {
      block.cases
        .flatMap(({ id, condition }) => checkConditions(context, block.id, condition, certain, id))
        .forEach(report);
    }
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
    checkValues(context, certain, block, tool).forEach(report);
    checkRequired(block, tool, profiles.get(block.id)).forEach(report);
  }
  for (const { blockId, problem } of linkCycleProblems(context)) {
    problems.push(automationProblem(problem.code, problem.params, blockId));
  }
  return problems;
}
