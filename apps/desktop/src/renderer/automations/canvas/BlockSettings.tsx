import { useEffect, useId, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { CONDITION_RULES_MAX, SWITCH_CASES_MAX } from '@bildora/protocol';
import type {
  AutomationBlock,
  AutomationCondition,
  AutomationRule,
  RunBlock,
} from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { MessageKey } from '../../../shared/i18n/translate.js';
import type { ParameterView, ProfileView, ToolView } from '../../../shared/ipc-contract.js';
import { ParameterForm } from '../../tools/ParameterForm.js';
import { parameterProblem, submittedValues } from '../../tools/parameter-form.js';
import type { FormValue, FormValues } from '../../tools/parameter-form.js';
import { without } from '../automation-draft.js';
import { conditionSentence, kindLabel } from './block-text.js';
import type { ReferenceOption } from './references.js';

const api = window.bildora;

/** What a case can be named: a name a connection can hold, and not one another output has. */
const CASE_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RESERVED_CASES = new Set(['next', 'error', 'true', 'false', 'default']);

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max?: number;
  readonly onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        {...(max === undefined ? {} : { max })}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isInteger(next) && next >= min && (max === undefined || next <= max)) {
            onChange(next);
          }
        }}
      />
    </div>
  );
}

function Select<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly onChange: (value: Value) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value as Value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function formFrom(parameters: readonly ParameterView[], values: RunBlock['values']): FormValues {
  return Object.fromEntries(
    parameters.map(({ name, type }) => {
      const value = values?.[name];
      return [name, type === 'boolean' ? value === true : String(value ?? '')];
    }),
  );
}

/** What a form holds, as a block stores it: only what was set, so the rest stays as the tool has it. */
function blockValues(
  parameters: readonly ParameterView[],
  form: FormValues,
): NonNullable<RunBlock['values']> {
  const usable = parameters.filter(
    (parameter) => parameterProblem(parameter, form[parameter.name], false) === undefined,
  );
  const { plain } = submittedValues(usable, form);
  return Object.fromEntries(Object.entries(plain).filter(([, value]) => value !== false));
}

interface RunFieldsProps {
  readonly block: RunBlock;
  readonly tools: readonly ToolView[];
  readonly references: readonly ReferenceOption[];
  readonly onChange: (block: RunBlock) => void;
  readonly onError: (error: unknown) => void;
}

/** A Run tool block. Secrets have no field here: they only ever come from a profile. */
function RunFields({ block, tools, references, onChange, onError }: RunFieldsProps) {
  const toolId = useId();
  const profileId = useId();
  const tool = tools.find(({ id }) => id === block.tool);
  const parameters = useMemo(
    // All optional here: a value can also come from a profile or from the tool's default.
    () =>
      (tool?.parameters ?? [])
        .filter(({ secret }) => secret !== true)
        .map((parameter) => ({ ...parameter, required: false })),
    [tool],
  );
  const [form, setForm] = useState<FormValues>(() => formFrom(parameters, block.values));
  const [profiles, setProfiles] = useState<readonly ProfileView[]>([]);
  const toolLevel = tool?.level;

  useEffect(() => {
    let current = true;
    if (toolLevel === 1) {
      void api
        .listProfiles(block.tool)
        .then((list) => {
          if (current) setProfiles(list);
        })
        .catch(onError);
    }
    return () => {
      current = false;
    };
  }, [block.tool, toolLevel, onError]);

  function setValue(name: string, value: FormValue): void {
    const next = { ...form, [name]: value };
    setForm(next);
    const rest: RunBlock = without(block, 'values');
    const values = blockValues(parameters, next);
    onChange(Object.keys(values).length === 0 ? rest : { ...rest, values });
  }

  const problems = Object.fromEntries(
    parameters.flatMap((parameter) => {
      const problem = parameterProblem(parameter, form[parameter.name], false);
      return problem === undefined ? [] : [[parameter.name, problem]];
    }),
  ) as Readonly<Record<string, MessageKey>>;
  const retry = typeof block.onFailure === 'object' ? block.onFailure.retry : undefined;

  return (
    <>
      <div className="field">
        <label className="field-label" htmlFor={toolId}>
          {t('automation.tool')}
        </label>
        <select
          id={toolId}
          value={block.tool}
          onChange={(event) => {
            onChange({ ...without(block, 'profile', 'values'), tool: event.target.value });
          }}
        >
          {tool === undefined ? (
            <option value={block.tool}>{t('automation.toolMissing', { id: block.tool })}</option>
          ) : null}
          {tools.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {toolLevel === 1 ? (
        <div className="field">
          <label className="field-label" htmlFor={profileId}>
            {t('automation.profile')}
          </label>
          <select
            id={profileId}
            value={block.profile ?? ''}
            onChange={(event) => {
              const rest: RunBlock = without(block, 'profile');
              onChange(event.target.value === '' ? rest : { ...rest, profile: event.target.value });
            }}
          >
            <option value="">{t('automation.noProfile')}</option>
            {profiles.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {parameters.length === 0 ? null : (
        <>
          <p className="field-hint">{t('automation.valuesHint')}</p>
          <ParameterForm
            parameters={parameters}
            values={form}
            problems={problems}
            savedSecrets={[]}
            disabled={false}
            onChange={setValue}
            onBrowse={(name) => {
              void api
                .pickPath()
                .then((path) => {
                  if (path !== undefined) setValue(name, path);
                })
                .catch(onError);
            }}
            onForget={() => undefined}
            pathControl={(name) => (
              <select
                className="reference-select"
                aria-label={t('automation.insertReference')}
                value=""
                onChange={(event) => {
                  setValue(name, event.target.value);
                }}
              >
                <option value="">{t('automation.reference')}</option>
                {references.map(({ label, value }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          />
        </>
      )}
      <Select
        label={t('canvas.onFailure')}
        value={retry === undefined ? 'stop' : 'retry'}
        options={[
          { value: 'stop', label: t('canvas.failureStop') },
          { value: 'retry', label: t('automation.failureRetry') },
        ]}
        onChange={(choice) => {
          const rest: RunBlock = without(block, 'onFailure');
          onChange(
            choice === 'stop'
              ? rest
              : { ...rest, onFailure: { retry: { attempts: 3, delaySeconds: 30 } } },
          );
        }}
      />
      {retry === undefined ? null : (
        <div className="automation-retry">
          <NumberField
            label={t('automation.attempts')}
            value={retry.attempts}
            min={2}
            max={20}
            onChange={(attempts) => {
              onChange({ ...block, onFailure: { retry: { ...retry, attempts } } });
            }}
          />
          <NumberField
            label={t('automation.retryDelay')}
            value={retry.delaySeconds ?? 0}
            min={0}
            max={86_400}
            onChange={(delaySeconds) => {
              onChange({ ...block, onFailure: { retry: { ...retry, delaySeconds } } });
            }}
          />
        </div>
      )}
      <p className="field-hint">{t('canvas.errorOutputHint')}</p>
    </>
  );
}

const RESULT_OPERATORS = ['is', 'is-not'] as const;
const EXIT_OPERATORS = ['equals', 'not-equals', 'greater-than', 'less-than'] as const;
const RESULTS = ['completed', 'failed', 'skipped'] as const;

interface ConditionEditorProps {
  readonly condition: AutomationCondition;
  /** Blocks a rule can read, by id, with their names. */
  readonly sources: readonly { readonly id: string; readonly name: string }[];
  readonly nameOf: (id: string) => string;
  readonly onChange: (condition: AutomationCondition) => void;
}

/** One row per rule: block, what to read, how to compare and with what, and the rule read back. */
function ConditionEditor({ condition, sources, nameOf, onChange }: ConditionEditorProps) {
  const setRule = (index: number, rule: AutomationRule): void => {
    onChange({
      ...condition,
      rules: condition.rules.map((item, position) => (position === index ? rule : item)),
    });
  };
  const fallback = sources[0]?.id ?? 'start';
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
            label={t('canvas.ruleBlock')}
            value={rule.block}
            options={[
              ...(sources.some(({ id }) => id === rule.block)
                ? []
                : [{ value: rule.block, label: nameOf(rule.block) }]),
              ...sources.map(({ id, name }) => ({ value: id, label: name })),
            ]}
            onChange={(block) => {
              setRule(index, { ...rule, block });
            }}
          />
          <Select
            label={t('canvas.ruleField')}
            value={rule.field}
            options={[
              { value: 'result', label: t('canvas.fieldResult') },
              { value: 'exit-code', label: t('canvas.fieldExitCode') },
            ]}
            onChange={(field) => {
              setRule(
                index,
                field === 'result'
                  ? { block: rule.block, field, operator: 'is', value: 'completed' }
                  : { block: rule.block, field, operator: 'equals', value: 0 },
              );
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
                  setRule(index, { ...rule, operator });
                }}
              />
              <Select
                label={t('canvas.ruleValue')}
                value={rule.value}
                options={RESULTS.map((value) => ({ value, label: t(`canvas.result.${value}`) }))}
                onChange={(value) => {
                  setRule(index, { ...rule, value });
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
                  setRule(index, { ...rule, operator });
                }}
              />
              <NumberField
                label={t('canvas.ruleValue')}
                value={rule.value}
                min={-2_147_483_648}
                onChange={(value) => {
                  setRule(index, { ...rule, value });
                }}
              />
            </>
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
        {t('canvas.ifName', { rule: conditionSentence(condition, nameOf) })}
      </p>
    </div>
  );
}

/** A case name being typed, applied once it is one a connection can hold. */
function CaseName({
  value,
  others,
  onRename,
}: {
  readonly value: string;
  readonly others: readonly string[];
  readonly onRename: (name: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const valid = CASE_NAME.test(text) && !RESERVED_CASES.has(text) && !others.includes(text);
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('canvas.caseName')}
      </label>
      <input
        id={id}
        value={text}
        aria-invalid={!valid}
        onChange={(event) => {
          setText(event.target.value);
          const next = event.target.value;
          if (CASE_NAME.test(next) && !RESERVED_CASES.has(next) && !others.includes(next)) {
            onRename(next);
          }
        }}
      />
      {valid ? null : <p className="field-problem">{t('canvas.caseNameProblem')}</p>}
    </div>
  );
}

export interface BlockSettingsProps {
  readonly block: AutomationBlock;
  readonly blocks: readonly AutomationBlock[];
  readonly tools: readonly ToolView[];
  readonly names: ReadonlyMap<string, string>;
  readonly references: readonly ReferenceOption[];
  readonly onChange: (block: AutomationBlock, renamed?: Readonly<Record<string, string>>) => void;
  readonly onError: (error: unknown) => void;
}

/** The settings of the selected block, in the same terms as a tool's form. */
export function BlockSettings({
  block,
  blocks,
  tools,
  names,
  references,
  onChange,
  onError,
}: BlockSettingsProps) {
  const messageId = useId();
  const nameOf = (id: string): string => names.get(id) ?? id;
  const sources = blocks
    .filter(({ id, type }) => id !== block.id && type !== 'start')
    .map(({ id }) => ({ id, name: nameOf(id) }));
  return (
    <div className="block-settings" data-testid="block-settings" data-block-id={block.id}>
      <h2>{kindLabel(block.type)}</h2>
      {block.type === 'start' ? <p className="field-hint">{t('canvas.startHint')}</p> : null}
      {block.type === 'run' ? (
        <RunFields
          key={block.tool}
          block={block}
          tools={tools}
          references={references}
          onChange={onChange}
          onError={onError}
        />
      ) : null}
      {block.type === 'wait-for-time' ? (
        <NumberField
          label={t('automation.seconds')}
          value={block.seconds}
          min={1}
          max={604_800}
          onChange={(seconds) => {
            onChange({ ...block, seconds });
          }}
        />
      ) : null}
      {block.type === 'wait-for-manual-action' ? (
        <div className="field">
          <label className="field-label" htmlFor={messageId}>
            {t('automation.message')}
          </label>
          <input
            id={messageId}
            value={block.message}
            onChange={(event) => {
              onChange({ ...block, message: event.target.value });
            }}
          />
          <p className="field-hint">{t('canvas.errorOutputHint')}</p>
        </div>
      ) : null}
      {block.type === 'if' ? (
        <ConditionEditor
          condition={block.condition}
          sources={sources}
          nameOf={nameOf}
          onChange={(condition) => {
            onChange({ ...block, condition });
          }}
        />
      ) : null}
      {block.type === 'switch' ? (
        <>
          <p className="field-hint">{t('canvas.switchHint')}</p>
          {block.cases.map((branch, index) => (
            <section key={index} className="switch-case" data-testid="switch-case">
              <CaseName
                value={branch.id}
                others={block.cases
                  .filter((_case, position) => position !== index)
                  .map(({ id }) => id)}
                onRename={(name) => {
                  onChange(
                    {
                      ...block,
                      cases: block.cases.map((item, position) =>
                        position === index ? { ...item, id: name } : item,
                      ),
                    },
                    { [branch.id]: name },
                  );
                }}
              />
              <ConditionEditor
                condition={branch.condition}
                sources={sources}
                nameOf={nameOf}
                onChange={(condition) => {
                  onChange({
                    ...block,
                    cases: block.cases.map((item, position) =>
                      position === index ? { ...item, condition } : item,
                    ),
                  });
                }}
              />
              {block.cases.length > 1 ? (
                <button
                  type="button"
                  onClick={() => {
                    onChange({
                      ...block,
                      cases: block.cases.filter((_case, position) => position !== index),
                    });
                  }}
                >
                  <Trash2 className="icon" aria-hidden="true" />
                  {t('canvas.removeCase')}
                </button>
              ) : null}
            </section>
          ))}
          {block.cases.length < SWITCH_CASES_MAX ? (
            <button
              type="button"
              onClick={() => {
                const taken = new Set(block.cases.map(({ id }) => id));
                let number = block.cases.length + 1;
                while (taken.has(`case-${String(number)}`)) number += 1;
                const [first] = block.cases;
                onChange({
                  ...block,
                  cases: [
                    ...block.cases,
                    {
                      id: `case-${String(number)}`,
                      condition: first?.condition ?? {
                        match: 'all',
                        rules: [
                          { block: 'start', field: 'result', operator: 'is', value: 'completed' },
                        ],
                      },
                    },
                  ],
                });
              }}
            >
              <Plus className="icon" aria-hidden="true" />
              {t('canvas.addCase')}
            </button>
          ) : null}
        </>
      ) : null}
      {block.type === 'parallel' ? <p className="field-hint">{t('canvas.parallelHint')}</p> : null}
      {block.type === 'join' ? (
        <>
          <p className="field-hint">{t('canvas.joinHint')}</p>
          <Select
            label={t('canvas.branchFailure')}
            value={block.onBranchFailure ?? 'stop-others'}
            options={[
              { value: 'stop-others', label: t('canvas.stopOthers') },
              { value: 'let-finish', label: t('canvas.letFinish') },
            ]}
            onChange={(choice) => {
              const rest = without(block, 'onBranchFailure');
              onChange(choice === 'stop-others' ? rest : { ...rest, onBranchFailure: choice });
            }}
          />
        </>
      ) : null}
    </div>
  );
}
