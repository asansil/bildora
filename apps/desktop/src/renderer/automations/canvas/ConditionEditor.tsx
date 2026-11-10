import { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  CONDITION_RULES_MAX,
  VALUE_RULE_OPERATORS,
  comparedType,
  isExpressionValue,
  operatorsFor,
} from '@bildora/protocol';
import type {
  AutomationCondition,
  AutomationRule,
  BlockValue,
  ValueRule,
  ValueRuleOperator,
  ValueType,
} from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import { without } from '../automation-draft.js';
import { conditionSentence, readableValue } from './block-text.js';
import { NumberField, Select } from './fields.js';
import { expressionType } from './values.js';
import type { ValueChoice, ValueContext } from './values.js';

const RESULT_OPERATORS = ['is', 'is-not'] as const;
const EXIT_OPERATORS = ['equals', 'not-equals', 'greater-than', 'less-than'] as const;
const RESULTS = ['completed', 'failed', 'skipped'] as const;
/** The value of the Value list that stands for an expression typed by hand. */
const TYPED = '=';

type BlockRule = Exclude<AutomationRule, { field: 'value' }>;

/** A choice as a list names it, with where it comes from. */
export function choiceLabel(choice: ValueChoice, nameOf: (id: string) => string): string {
  if (choice.group === 'run') return choice.label;
  if (choice.block === undefined) return t('canvas.choiceInput', { label: choice.label });
  return t('canvas.choiceOf', { block: nameOf(choice.block), label: choice.label });
}

/** What a value reads as in a rule's sentence: the name of a choice, or the expression itself. */
export function valueNamer(
  choices: readonly ValueChoice[],
  nameOf: (id: string) => string,
): (expression: string) => string {
  return (expression) => {
    const choice = choices.find((candidate) => candidate.expression === expression);
    return choice === undefined ? readableValue(expression, nameOf) : choiceLabel(choice, nameOf);
  };
}

/** What a rule compares with when it is first made, by the type it compares. */
function startingValue(type: ValueType | undefined): BlockValue | undefined {
  switch (type) {
    case undefined:
      return undefined;
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return true;
    default:
      return '';
  }
}

/** A rule reading a value, with the first operator its type allows. */
export function valueRule(expression: string, type: ValueType | undefined): ValueRule {
  const operator = type === undefined ? 'equals' : (operatorsFor(type)[0] ?? 'equals');
  const value = startingValue(comparedType(type ?? 'text', operator));
  return {
    field: 'value',
    read: { expression },
    operator,
    ...(value === undefined ? {} : { value }),
  };
}

/** A rule on what a block left: its result, or its exit code. */
function BlockRuleFields({
  rule,
  sources,
  nameOf,
  onChange,
}: {
  readonly rule: BlockRule;
  readonly sources: readonly { readonly id: string; readonly name: string }[];
  readonly nameOf: (id: string) => string;
  readonly onChange: (rule: BlockRule) => void;
}) {
  return (
    <>
      <Select
        label={t('canvas.ruleBlock')}
        value={rule.block}
        options={[
          ...(sources.some(({ id }) => id === rule.block)
            ? []
            : [{ value: rule.block, label: nameOf(rule.block) }]),
          ...sources.map(({ id, name }) => ({ value: id, label: name })),
        ]}
        onChange={(block) => {
          onChange({ ...rule, block });
        }}
      />
      {rule.field === 'result' ? (
        <>
          <Select
            label={t('canvas.ruleOperator')}
            value={rule.operator}
            options={RESULT_OPERATORS.map((value) => ({
              value,
              label: t(`canvas.operator.${value}`),
            }))}
            onChange={(operator) => {
              onChange({ ...rule, operator });
            }}
          />
          <Select
            label={t('canvas.ruleValue')}
            value={rule.value}
            options={RESULTS.map((value) => ({ value, label: t(`canvas.result.${value}`) }))}
            onChange={(value) => {
              onChange({ ...rule, value });
            }}
          />
        </>
      ) : (
        <>
          <Select
            label={t('canvas.ruleOperator')}
            value={rule.operator}
            options={EXIT_OPERATORS.map((value) => ({
              value,
              label: t(`canvas.operator.${value}`),
            }))}
            onChange={(operator) => {
              onChange({ ...rule, operator });
            }}
          />
          <NumberField
            label={t('canvas.ruleValue')}
            value={rule.value}
            min={-2_147_483_648}
            onChange={(value) => {
              onChange({ ...rule, value });
            }}
          />
        </>
      )}
    </>
  );
}

/** Text a person types for what a rule compares with. `=` starts an expression. */
function CompareField({
  wanted,
  value,
  onChange,
}: {
  readonly wanted: ValueType;
  readonly value: BlockValue | undefined;
  readonly onChange: (value: BlockValue) => void;
}) {
  const id = useId();
  if (wanted === 'boolean' && !isExpressionValue(value)) {
    return (
      <Select
        label={t('canvas.ruleValue')}
        value={value === false ? 'false' : 'true'}
        options={[
          { value: 'true', label: t('canvas.yes') },
          { value: 'false', label: t('canvas.no') },
        ]}
        onChange={(choice) => {
          onChange(choice === 'true');
        }}
      />
    );
  }
  const text = isExpressionValue(value) ? `= ${value.expression}` : String(value ?? '');
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('canvas.ruleValue')}
      </label>
      <input
        id={id}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          if (next.trimStart().startsWith('=')) {
            const expression = next.trimStart().slice(1).trim();
            onChange(expression === '' ? next : { expression });
          } else if ((wanted === 'integer' || wanted === 'number') && next.trim() !== '') {
            const number = Number(next);
            onChange(Number.isFinite(number) ? number : next);
          } else {
            onChange(next);
          }
        }}
      />
    </div>
  );
}

/** A rule on a value: what it reads, how it compares, and with what. */
function ValueRuleFields({
  rule,
  choices,
  context,
  nameOf,
  onChange,
}: {
  readonly rule: ValueRule;
  readonly choices: readonly ValueChoice[];
  readonly context: ValueContext;
  readonly nameOf: (id: string) => string;
  readonly onChange: (rule: ValueRule) => void;
}) {
  const expressionId = useId();
  const read = rule.read.expression;
  const chosen = choices.find(({ expression }) => expression === read);
  const type = chosen?.type ?? expressionType(context, read);
  const operators: readonly ValueRuleOperator[] =
    type === undefined ? VALUE_RULE_OPERATORS : operatorsFor(type);
  const wanted = comparedType(type ?? 'text', rule.operator);

  /** Keeps the operator and the value when they still fit what is read, and starts them again if not. */
  const reading = (expression: string): void => {
    const next = choices.find((choice) => choice.expression === expression)?.type;
    const nextType = next ?? expressionType(context, expression);
    const fits = nextType === undefined || operatorsFor(nextType).includes(rule.operator);
    const sameCompare = comparedType(nextType ?? 'text', rule.operator) === wanted;
    onChange(
      fits && sameCompare ? { ...rule, read: { expression } } : valueRule(expression, nextType),
    );
  };

  return (
    <>
      <Select
        label={t('canvas.ruleValueChoice')}
        value={chosen === undefined ? TYPED : chosen.expression}
        options={[
          ...choices.map((choice) => ({
            value: choice.expression,
            label: choiceLabel(choice, nameOf),
          })),
          { value: TYPED, label: t('canvas.ruleExpression') },
        ]}
        onChange={(expression) => {
          if (expression !== TYPED) reading(expression);
        }}
      />
      {chosen === undefined ? (
        <div className="field">
          <label className="field-label" htmlFor={expressionId}>
            {t('canvas.ruleExpressionLabel')}
          </label>
          <div className="field-row expression-row">
            <span className="expression-equals" aria-hidden="true">
              =
            </span>
            <input
              id={expressionId}
              className="expression-input"
              value={read}
              spellCheck={false}
              onChange={(event) => {
                const next = event.target.value;
                if (next.trim() !== '') reading(next);
              }}
            />
          </div>
        </div>
      ) : null}
      <Select
        label={t('canvas.ruleOperator')}
        value={rule.operator}
        options={operators.map((operator) => ({
          value: operator,
          label: t(`canvas.valueOperator.${operator}`),
        }))}
        onChange={(operator) => {
          const nextWanted = comparedType(type ?? 'text', operator);
          const value = nextWanted === wanted ? rule.value : startingValue(nextWanted);
          const rest = without(rule, 'value');
          onChange({ ...rest, operator, ...(value === undefined ? {} : { value }) });
        }}
      />
      {wanted === undefined ? null : (
        <CompareField
          wanted={wanted}
          value={rule.value}
          onChange={(value) => {
            onChange({ ...rule, value });
          }}
        />
      )}
    </>
  );
}

export interface ConditionEditorProps {
  readonly condition: AutomationCondition;
  /** Blocks a rule can read the result of, by id, with their names. */
  readonly sources: readonly { readonly id: string; readonly name: string }[];
  /** Values a rule can read: inputs, results of earlier blocks and settings of others. */
  readonly choices: readonly ValueChoice[];
  readonly context: ValueContext;
  readonly nameOf: (id: string) => string;
  readonly onChange: (condition: AutomationCondition) => void;
}

/** One row per rule: what to read, how to compare and with what, and the rule read back. */
export function ConditionEditor({
  condition,
  sources,
  choices,
  context,
  nameOf,
  onChange,
}: ConditionEditorProps) {
  const setRule = (index: number, rule: AutomationRule): void => {
    onChange({
      ...condition,
      rules: condition.rules.map((item, position) => (position === index ? rule : item)),
    });
  };
  const fallback = sources[0]?.id ?? 'start';
  const [firstChoice] = choices;
  return (
    <div className="condition">
      {condition.rules.length > 1 ? (
        <Select
          label={t('canvas.match')}
          value={condition.match}
          options={[
            { value: 'all', label: t('canvas.matchAll') },
            { value: 'any', label: t('canvas.matchAny') },
          ]}
          onChange={(match) => {
            onChange({ ...condition, match });
          }}
        />
      ) : null}
      {condition.rules.map((rule, index) => (
        <fieldset key={index} className="condition-rule" data-testid="condition-rule">
          <legend className="visually-hidden">
            {t('canvas.ruleNumber', { number: index + 1 })}
          </legend>
          <Select
            label={t('canvas.ruleField')}
            value={rule.field}
            options={[
              { value: 'result', label: t('canvas.fieldResult') },
              { value: 'exit-code', label: t('canvas.fieldExitCode') },
              {
                value: 'value',
                label: t('canvas.fieldValue'),
                disabled: firstChoice === undefined,
              },
            ]}
            onChange={(field) => {
              const block = rule.field === 'value' ? fallback : rule.block;
              if (field === 'value') {
                if (firstChoice !== undefined) {
                  setRule(index, valueRule(firstChoice.expression, firstChoice.type));
                }
              } else {
                setRule(
                  index,
                  field === 'result'
                    ? { block, field, operator: 'is', value: 'completed' }
                    : { block, field, operator: 'equals', value: 0 },
                );
              }
            }}
          />
          {rule.field === 'value' ? (
            <ValueRuleFields
              rule={rule}
              choices={choices}
              context={context}
              nameOf={nameOf}
              onChange={(next) => {
                setRule(index, next);
              }}
            />
          ) : (
            <BlockRuleFields
              rule={rule}
              sources={sources}
              nameOf={nameOf}
              onChange={(next) => {
                setRule(index, next);
              }}
            />
          )}
          {condition.rules.length > 1 ? (
            <button
              type="button"
              onClick={() => {
                onChange({
                  ...condition,
                  rules: condition.rules.filter((_rule, position) => position !== index),
                });
              }}
            >
              <Trash2 className="icon" aria-hidden="true" />
              {t('canvas.removeRule')}
            </button>
          ) : null}
        </fieldset>
      ))}
      {condition.rules.length < CONDITION_RULES_MAX ? (
        <button
          type="button"
          onClick={() => {
            onChange({
              ...condition,
              rules: [
                ...condition.rules,
                { block: fallback, field: 'result', operator: 'is', value: 'completed' },
              ],
            });
          }}
        >
          <Plus className="icon" aria-hidden="true" />
          {t('canvas.addRule')}
        </button>
      ) : null}
      <p className="condition-sentence" data-testid="condition-sentence">
        {t('canvas.ifName', {
          rule: conditionSentence(condition, nameOf, valueNamer(choices, nameOf)),
        })}
      </p>
    </div>
  );
}
