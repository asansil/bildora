import { useId, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SWITCH_CASES_MAX } from '@bildora/protocol';
import type { AutomationBlock } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { AutomationProblemView, ToolView } from '../../../shared/ipc-contract.js';
import { without } from '../automation-draft.js';
import { ContextMenu } from '../../shell/ContextMenu.js';
import { problemText } from '../problem-text.js';
import { blockKindText, ifRuleText } from './block-text.js';
import { ConditionEditor } from './ConditionEditor.js';
import { NumberField, Select } from './fields.js';
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
  readonly onChange: (block: AutomationBlock, renamed?: Readonly<Record<string, string>>) => void;
  /** Asks for the block's new name in links, in the Rename dialog. */
  readonly onRename: () => void;
  /** Gives focus back to the canvas, once Enter has applied a field. */
  readonly onDone: () => void;
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
  onChange,
  onRename,
  onDone,
  onGoTo,
  onError,
}: BlockSettingsProps) {
  const messageId = useId();
  /** Where the name's menu opened, while it is open. */
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number } | undefined>();
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

  return (
    <div
      className="block-settings"
      data-testid="block-settings"
      data-block-id={block.id}
      onKeyDown={(event) => {
        if (event.key === 'F2') {
          event.preventDefault();
          onRename();
          return;
        }
        // Enter applies a field and hands the keyboard back to the canvas. A field that uses
        // Enter itself, such as one picking a suggestion, has already prevented this.
        const field = event.target;
        if (
          event.key === 'Enter' &&
          !event.defaultPrevented &&
          !event.shiftKey &&
          (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) &&
          !(field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type))
        ) {
          event.preventDefault();
          field.blur();
          onDone();
        }
      }}
    >
      <header className="block-settings-header">
        <h2
          className="block-settings-name truncate"
          title={t('canvas.blockIdHint', { id: block.id })}
          data-testid="block-settings-name"
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          {nameOf(block.id)}
        </h2>
        <p className="muted truncate">{blockKindText(block, tools)}</p>
      </header>
      {menu === undefined ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('canvas.menu', { name: nameOf(block.id) })}
          items={[{ label: t('canvas.rename'), shortcut: 'F2', run: onRename }]}
          onClose={() => {
            setMenu(undefined);
          }}
        />
      )}
      {block.type === 'if' ? (
        <p className="field-hint" data-testid="if-rule">
          {ifRuleText(block.condition, nameOf)}
        </p>
      ) : null}
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
