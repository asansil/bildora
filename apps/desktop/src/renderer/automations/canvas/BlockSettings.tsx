import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SWITCH_CASES_MAX } from '@bildora/protocol';
import type { AutomationBlock } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { AutomationProblemView, ToolView } from '../../../shared/ipc-contract.js';
import { without } from '../automation-draft.js';
import { problemText } from '../problem-text.js';
import { kindLabel } from './block-text.js';
import { ConditionEditor } from './ConditionEditor.js';
import { NameField, NumberField, Select } from './fields.js';
import type { BlockIdProblem } from './flow-document.js';
import { InputsEditor } from './InputsEditor.js';
import { RunFields } from './RunFields.js';
import { valueChoices } from './values.js';
import type { ValueContext } from './values.js';

/** What a case can be named: a name a connection can hold, and not one another output has. */
const CASE_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const RESERVED_CASES = new Set(['next', 'error', 'true', 'false', 'default']);

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
  /** What links and rules can read, and what linked values resolve to. */
  readonly context: ValueContext;
  /** Problems of the flow about this block. */
  readonly problems: readonly AutomationProblemView[];
  /** The block's name in links should take the caret, as Rename asks. */
  readonly focusName?: boolean;
  /** Called once the name has taken the caret, so that it does not again. */
  readonly onNameFocused?: () => void;
  /** Why another id cannot name this block, or undefined when it can. */
  readonly idProblem: (next: string) => BlockIdProblem | undefined;
  readonly onChange: (block: AutomationBlock, renamed?: Readonly<Record<string, string>>) => void;
  /** Gives the block another id, which everything that names it follows. */
  readonly onRename: (from: string, to: string) => void;
  /** Selects another block on the canvas. */
  readonly onGoTo: (blockId: string) => void;
  readonly onError: (error: unknown) => void;
}

/** The settings of the selected block, in the same terms as a tool's form. */
export function BlockSettings({
  block,
  blocks,
  tools,
  names,
  context,
  problems,
  focusName = false,
  onNameFocused,
  idProblem,
  onChange,
  onRename,
  onGoTo,
  onError,
}: BlockSettingsProps) {
  const messageId = useId();
  const idField = useRef<HTMLInputElement>(null);
  const nameOf = (id: string): string => names.get(id) ?? id;
  const sources = blocks
    .filter(({ id, type }) => id !== block.id && type !== 'start')
    .map(({ id }) => ({ id, name: nameOf(id) }));
  const choices = useMemo(() => valueChoices(context, block.id), [context, block.id]);
  /** Problems about a value, worded, by the label of the field or rule they name. */
  const fieldProblems = new Map(
    problems.flatMap((problem) => {
      const label = problem.params['label'];
      return label === undefined ? [] : [[label, problemText(problem, nameOf).what] as const];
    }),
  );

  useEffect(() => {
    if (!focusName) return;
    idField.current?.focus();
    idField.current?.select();
    onNameFocused?.();
  }, [focusName, onNameFocused]);

  return (
    <div className="block-settings" data-testid="block-settings" data-block-id={block.id}>
      <h2>{kindLabel(block.type)}</h2>
      <NameField
        label={t('canvas.blockId')}
        value={block.id}
        hint={t('canvas.blockIdHint', { id: block.id })}
        applyOnBlur
        inputRef={idField}
        problemOf={(next) => {
          const problem = idProblem(next);
          return problem === undefined ? undefined : t(`canvas.blockIdProblem.${problem}`);
        }}
        onRename={(next) => {
          onRename(block.id, next);
        }}
      />
      {block.type === 'start' ? (
        <>
          <p className="field-hint">{t('canvas.startHint')}</p>
          <InputsEditor
            inputs={block.inputs ?? []}
            onChange={(inputs) => {
              const rest = without(block, 'inputs');
              onChange(inputs.length === 0 ? rest : { ...rest, inputs: [...inputs] });
            }}
          />
        </>
      ) : null}
      {block.type === 'run' ? (
        <RunFields
          key={block.tool}
          block={block}
          tools={tools}
          context={context}
          problems={fieldProblems}
          nameOf={nameOf}
          onChange={onChange}
          onGoTo={onGoTo}
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
          choices={choices}
          context={context}
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
                choices={choices}
                context={context}
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
