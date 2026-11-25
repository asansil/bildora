import { useId, useMemo, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Ellipsis, Plus, Trash2 } from 'lucide-react';
import {
  DEFAULT_CASE,
  ERROR_OUTPUT,
  SWITCH_CASES_MAX,
  connectionOutput,
  outputsOf,
} from '@bildora/protocol';
import type { AutomationBlock, AutomationConnection } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { MessageKey } from '../../../shared/i18n/translate.js';
import type {
  AutomationProblemView,
  AutomationView,
  ToolView,
} from '../../../shared/ipc-contract.js';
import { without } from '../automation-draft.js';
import { ContextMenu } from '../../shell/ContextMenu.js';
import type { MenuEntry } from '../../shell/menu-model.js';
import { problemText } from '../problem-text.js';
import { BlockSwatch, familyOf } from './BlockIcon.js';
import { blockKindText, ifRuleText, outputLabel } from './block-text.js';
import { ConditionEditor } from './ConditionEditor.js';
import { NumberField, Select } from './fields.js';
import { InputsEditor } from './InputsEditor.js';
import { isDisabled } from './flow-document.js';
import { ForSettings, WhileSettings } from './LoopSettings.js';
import { PanelSection } from './PanelSection.js';
import { StartSettings } from './StartSettings.js';
import { RunFields } from './RunFields.js';
import { sharedValues, usersOf, valueChoices } from './values.js';
import type { ValueContext } from './values.js';

/** The tabs of a block's panel, in order. */
export const BLOCK_TABS = ['settings', 'outputs', 'data', 'help'] as const;
export type BlockTab = (typeof BLOCK_TABS)[number];

const TAB_LABELS: Readonly<Record<BlockTab, MessageKey>> = {
  settings: 'canvas.tabSettings',
  outputs: 'canvas.tabOutputs',
  data: 'canvas.tabData',
  help: 'canvas.tabHelp',
};

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
  readonly connections: readonly AutomationConnection[];
  /** The tab on view, kept while other blocks are chosen. */
  readonly tab: BlockTab;
  readonly onTab: (tab: BlockTab) => void;
  readonly tools: readonly ToolView[];
  /** The automations of the Workspace, which a Run automation block calls. */
  readonly automations: readonly AutomationView[];
  /** Opens the automation a Run automation block calls. */
  readonly onOpenAutomation: (id: string) => void;
  readonly names: ReadonlyMap<string, string>;
  /** What links and rules can read, and what linked values resolve to. */
  readonly context: ValueContext;
  /** Problems of the flow about this block. */
  readonly problems: readonly AutomationProblemView[];
  readonly onChange: (block: AutomationBlock, renamed?: Readonly<Record<string, string>>) => void;
  /** Asks for the block's new name in links, in the Rename dialog. */
  readonly onRename: () => void;
  /** What the card's ⋯ button and a right-click on the name offer. */
  readonly menu: readonly MenuEntry[];
  /** Gives focus back to the canvas, once Enter has applied a field. */
  readonly onDone: () => void;
  /** Selects another block on the canvas. */
  readonly onGoTo: (blockId: string) => void;
  readonly onError: (error: unknown) => void;
}

/**
 * The selected block: a card naming it, then its settings, its outputs, the values it shares and
 * help about it, one tab each. Explanations sit in tooltips and in Help, not between the fields.
 */
export function BlockSettings({
  block,
  blocks,
  connections,
  tab,
  onTab,
  tools,
  automations,
  onOpenAutomation,
  names,
  context,
  problems,
  onChange,
  onRename,
  menu: menuItems,
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

  const tabsId = useId();
  const tool = block.type === 'run' ? tools.find(({ id }) => id === block.tool) : undefined;

  function onTabKey(event: KeyboardEvent<HTMLDivElement>): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = (BLOCK_TABS.indexOf(tab) + step + BLOCK_TABS.length) % BLOCK_TABS.length;
    const next = BLOCK_TABS[at];
    if (next !== undefined) {
      onTab(next);
      document.getElementById(`${tabsId}-${next}`)?.focus();
    }
  }

  function settingsOf(): ReactNode {
    switch (block.type) {
      case 'start':
        return (
          <>
            <StartSettings block={block} onChange={onChange} />
            <PanelSection id="start.inputs" title={t('canvas.sectionInputs')}>
              <InputsEditor
                inputs={block.inputs ?? []}
                onChange={(inputs) => {
                  const rest = without(block, 'inputs');
                  onChange(inputs.length === 0 ? rest : { ...rest, inputs: [...inputs] });
                }}
              />
            </PanelSection>
          </>
        );
      case 'run':
        return (
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
        );
      case 'wait-for-time':
        return (
          <PanelSection id="time.wait" title={t('canvas.sectionWait')}>
            <NumberField
              label={t('automation.seconds')}
              value={block.seconds}
              min={1}
              max={604_800}
              onChange={(seconds) => {
                onChange({ ...block, seconds });
              }}
            />
          </PanelSection>
        );
      case 'wait-for-manual-action':
        return (
          <PanelSection id="manual.message" title={t('canvas.sectionMessage')}>
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
            </div>
          </PanelSection>
        );
      case 'if':
        return (
          <PanelSection id="if.condition" title={t('canvas.sectionCondition')}>
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
          </PanelSection>
        );
      case 'switch':
        return (
          <PanelSection
            id="switch.cases"
            title={t('canvas.sectionCases')}
            count={block.cases.length}
          >
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
          </PanelSection>
        );
      case 'run-automation':
        return (
          <RunFields
            key={block.automation}
            block={block}
            tools={tools}
            automations={automations}
            onOpenAutomation={onOpenAutomation}
            context={context}
            problems={fieldProblems}
            nameOf={nameOf}
            onChange={onChange}
            onGoTo={onGoTo}
            onError={onError}
          />
        );
      case 'for':
        return (
          <ForSettings
            key={block.id}
            block={block}
            sources={sources}
            choices={choices}
            context={context}
            problems={fieldProblems}
            nameOf={nameOf}
            onChange={onChange}
            onError={onError}
          />
        );
      case 'while':
        return (
          <WhileSettings
            key={block.id}
            block={block}
            sources={sources}
            choices={choices}
            context={context}
            problems={fieldProblems}
            nameOf={nameOf}
            onChange={onChange}
            onError={onError}
          />
        );
      case 'parallel':
        return <p className="muted block-tab-empty">{t('canvas.noSettings')}</p>;
      case 'join':
        return (
          <PanelSection id="join.branches" title={t('canvas.sectionBranches')}>
            <Select
              label={t('canvas.joinEnds')}
              value={block.parallel}
              options={context.blocks
                .filter(
                  (other) =>
                    other.type === 'parallel' &&
                    (other.id === block.parallel ||
                      !context.blocks.some(
                        (join) => join.type === 'join' && join.parallel === other.id,
                      )),
                )
                .map(({ id }) => ({ value: id, label: nameOf(id) }))}
              onChange={(parallel) => {
                onChange({ ...block, parallel });
              }}
            />
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
          </PanelSection>
        );
    }
  }

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
      <header className="block-card">
        <BlockSwatch kind={block.type} tool={tool} size="large" />
        <div className="block-card-text">
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
          <span className="block-card-kind truncate">
            {isDisabled(block)
              ? t('canvas.disabledKind', { kind: blockKindText(block, tools, automations) })
              : blockKindText(block, tools, automations)}
          </span>
        </div>
        <div className="block-card-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t('canvas.moreActions')}
            title={t('canvas.moreActions')}
            aria-haspopup="menu"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setMenu({ x: box.left, y: box.bottom });
            }}
          >
            <Ellipsis className="icon" aria-hidden="true" />
          </button>
        </div>
      </header>
      {menu === undefined ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t('canvas.menu', { name: nameOf(block.id) })}
          items={menuItems}
          onClose={() => {
            setMenu(undefined);
          }}
        />
      )}
      <div
        className="block-tabs"
        role="tablist"
        aria-label={t('canvas.blockPanel')}
        onKeyDown={onTabKey}
      >
        {BLOCK_TABS.map((name) => (
          <button
            key={name}
            id={`${tabsId}-${name}`}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-controls={`${tabsId}-panel`}
            tabIndex={tab === name ? 0 : -1}
            data-testid={`block-tab-${name}`}
            onClick={() => {
              onTab(name);
            }}
          >
            {t(TAB_LABELS[name])}
          </button>
        ))}
      </div>
      <div
        className="block-tab-panel"
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${tab}`}
      >
        {tab === 'settings' ? settingsOf() : null}
        {tab === 'outputs' ? (
          <OutputsList block={block} connections={connections} nameOf={nameOf} onGoTo={onGoTo} />
        ) : null}
        {tab === 'data' ? (
          <SharedData
            block={block}
            blocks={blocks}
            context={context}
            nameOf={nameOf}
            onGoTo={onGoTo}
          />
        ) : null}
        {tab === 'help' ? <BlockHelp block={block} tool={tool} nameOf={nameOf} /> : null}
      </div>
    </div>
  );
}

/** A port as the canvas draws it, so an output reads the same here and there. */
function PortMark({ output, choice }: { readonly output: string; readonly choice: boolean }) {
  const kind = output === ERROR_OUTPUT ? 'error' : choice ? 'branch' : 'out';
  return <span className={`port-mark port-mark--${kind}`} aria-hidden="true" />;
}

/** Each output of the block and the blocks it leads to, which a click selects on the canvas. */
function OutputsList({
  block,
  connections,
  nameOf,
  onGoTo,
}: {
  readonly block: AutomationBlock;
  readonly connections: readonly AutomationConnection[];
  readonly nameOf: (id: string) => string;
  readonly onGoTo: (id: string) => void;
}) {
  const outputs = outputsOf(block);
  const choice = outputs.filter((output) => output !== ERROR_OUTPUT).length > 1;
  return (
    <ul className={`block-outputs family-${familyOf(block.type)}`} data-testid="block-outputs">
      {outputs.map((output) => {
        const targets = connections
          .filter(
            (connection) => connection.from === block.id && connectionOutput(connection) === output,
          )
          .map(({ to }) => to);
        const tip =
          output === ERROR_OUTPUT
            ? t('canvas.errorOutputHint')
            : output === DEFAULT_CASE && block.type === 'switch'
              ? t('canvas.defaultOutputTip')
              : undefined;
        return (
          <li key={output} className="block-output" data-output={output}>
            <PortMark output={output} choice={choice} />
            <span
              className="block-output-name"
              {...(tip === undefined ? {} : { 'data-tip': tip, tabIndex: 0 })}
            >
              {outputLabel(output)}
            </span>
            <span className="block-output-targets">
              {targets.length === 0 ? (
                <span className="muted">{t('canvas.outputNotConnected')}</span>
              ) : (
                targets.map((target) => (
                  <button
                    key={target}
                    type="button"
                    className="link-button"
                    onClick={() => {
                      onGoTo(target);
                    }}
                  >
                    {nameOf(target)}
                  </button>
                ))
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The values the block offers to later blocks, and the blocks that read them. */
function SharedData({
  block,
  blocks,
  context,
  nameOf,
  onGoTo,
}: {
  readonly block: AutomationBlock;
  readonly blocks: readonly AutomationBlock[];
  readonly context: ValueContext;
  readonly nameOf: (id: string) => string;
  readonly onGoTo: (id: string) => void;
}) {
  const values = useMemo(() => sharedValues(context, block.id), [context, block.id]);
  const readers = [...(usersOf(blocks).get(block.id) ?? [])];
  if (values.length === 0) {
    return <p className="muted block-tab-empty">{t('canvas.sharesNothing')}</p>;
  }
  return (
    <div className="block-data" data-testid="block-data">
      <PanelSection id="data.values" title={t('canvas.sharedValues')} count={values.length}>
        <dl className="shared-values">
          {values.map((value) => (
            <div key={value.expression} className="shared-value">
              <dt>{value.label}</dt>
              <dd>
                <code>{value.expression}</code>
                <span className="muted">{value.type}</span>
              </dd>
            </div>
          ))}
        </dl>
      </PanelSection>
      <PanelSection id="data.readers" title={t('canvas.readBy')} count={readers.length}>
        {readers.length === 0 ? (
          <p className="muted">{t('canvas.readByNobody')}</p>
        ) : (
          <ul className="block-readers">
            {readers.map((reader) => (
              <li key={reader}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    onGoTo(reader);
                  }}
                >
                  {nameOf(reader)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}

const KIND_HELP: Readonly<Record<AutomationBlock['type'], readonly MessageKey[]>> = {
  start: ['canvas.startHint'],
  run: ['automation.valuesHint', 'canvas.errorOutputHint'],
  if: ['canvas.helpIf'],
  switch: ['canvas.switchHint'],
  parallel: ['canvas.parallelHint'],
  join: ['canvas.joinHint'],
  'wait-for-time': ['canvas.helpTime'],
  'wait-for-manual-action': ['canvas.helpManual'],
  for: ['canvas.forHint'],
  while: ['canvas.whileHint'],
  'run-automation': ['canvas.callHint'],
};

/** What the block does and how to use it, kept out of the way of its fields. */
function BlockHelp({
  block,
  tool,
  nameOf,
}: {
  readonly block: AutomationBlock;
  readonly tool: ToolView | undefined;
  readonly nameOf: (id: string) => string;
}) {
  return (
    <div className="block-help" data-testid="block-help">
      {tool?.description === undefined ? null : <p>{tool.description}</p>}
      {block.type === 'if' ? (
        <p className="block-help-rule" data-testid="if-rule">
          {ifRuleText(block.condition, nameOf)}
        </p>
      ) : null}
      {KIND_HELP[block.type].map((key) => (
        <p key={key}>{t(key)}</p>
      ))}
      {block.type === 'run' || block.type === 'start' ? (
        <>
          <h3>{t('canvas.readAs')}</h3>
          <p>
            <code>{block.type === 'start' ? 'inputs.<name>' : `${block.id}.<setting>`}</code>
          </p>
        </>
      ) : null}
    </div>
  );
}
