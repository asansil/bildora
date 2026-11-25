import { useId, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import {
  LOOP_PATTERN_MAX_LENGTH,
  LOOP_ROUNDS_MAX,
  WAIT_SECONDS_MAX,
  isExpressionValue,
  isLoopType,
  loopChain,
} from '@bildora/protocol';
import type { ForBlock, ForItems, LoopBlock, WhileBlock } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import { without } from '../automation-draft.js';
import { expressionSentence } from './block-text.js';
import { ExpressionField } from './ExpressionField.js';
import { NumberField, Select } from './fields.js';
import { PanelSection } from './PanelSection.js';
import { shownValue } from './values.js';
import type { ValueChoice, ValueContext } from './values.js';

const api = window.bildora;

/** What every loop panel needs to read values and name blocks. */
interface LoopFieldsProps<Block extends LoopBlock> {
  readonly block: Block;
  readonly sources: readonly { readonly id: string; readonly name: string }[];
  readonly choices: readonly ValueChoice[];
  readonly context: ValueContext;
  /** Problems of the flow about this block's values, worded, by the label they name. */
  readonly problems: ReadonlyMap<string, string>;
  readonly nameOf: (id: string) => string;
  readonly onChange: (block: Block) => void;
  readonly onError: (error: unknown) => void;
}

/** What a failed round does: end the loop, or go on with the next round. */
function RoundFailure<Block extends LoopBlock>({
  block,
  onChange,
}: Pick<LoopFieldsProps<Block>, 'block' | 'onChange'>) {
  return (
    <PanelSection id="loop.failure" title={t('canvas.sectionRoundFailure')}>
      <Select
        label={t('canvas.roundFailure')}
        value={block.onRoundFailure ?? 'stop'}
        options={[
          { value: 'stop', label: t('canvas.roundFailureStop') },
          { value: 'continue', label: t('canvas.roundFailureContinue') },
        ]}
        onChange={(choice) => {
          const rest = without(block, 'onRoundFailure') as Block;
          onChange(choice === 'stop' ? rest : { ...rest, onRoundFailure: choice });
        }}
      />
    </PanelSection>
  );
}

/**
 * The items of a new kind, keeping what can be kept. A list needs its expression first, so it has
 * none until one is written.
 */
function itemsOfKind(kind: ForItems['kind'], current: ForItems): ForItems | undefined {
  if (kind === current.kind) return current;
  switch (kind) {
    case 'count':
      return { kind, count: 3 };
    case 'list':
      return undefined;
    case 'folder':
      return { kind, folder: '' };
  }
}

/** A For: what it goes through, one round each, and what a failed round does. */
export function ForSettings({
  block,
  choices,
  context,
  problems,
  nameOf,
  onChange,
  onError,
}: LoopFieldsProps<ForBlock>) {
  const folderId = useId();
  const patternId = useId();
  const subfoldersId = useId();
  const { items } = block;
  /** The kind chosen, which a list keeps before its expression is written. */
  const [kind, setKind] = useState(items.kind);
  if (kind !== items.kind && kind !== 'list') setKind(items.kind);
  const setItems = (next: ForItems): void => {
    setKind(next.kind);
    onChange({ ...block, items: next });
  };
  /** The folder, as typed; text starting with `=` turns it into an expression. */
  const [folderText, setFolderText] = useState(
    items.kind === 'folder' && typeof items.folder === 'string' ? items.folder : '',
  );
  const listLabel = t('canvas.loopItemsList');
  const folderLabel = t('canvas.loopItemsFolder');
  return (
    <>
      <PanelSection id="loop.items" title={t('canvas.sectionItems')}>
        <Select
          label={t('canvas.loopItemsKind')}
          value={kind}
          options={[
            { value: 'count', label: t('canvas.loopKindCount') },
            { value: 'list', label: t('canvas.loopKindList') },
            { value: 'folder', label: t('canvas.loopKindFolder') },
          ]}
          onChange={(chosen) => {
            const next = itemsOfKind(chosen, items);
            if (next === undefined) setKind(chosen);
            else setItems(next);
          }}
        />
        {kind === 'count' && items.kind === 'count' ? (
          typeof items.count === 'number' ? (
            <NumberField
              label={t('canvas.loopTimes')}
              value={items.count}
              min={0}
              max={LOOP_ROUNDS_MAX}
              onChange={(count) => {
                setItems({ kind: 'count', count });
              }}
            />
          ) : (
            <ExpressionField
              label={t('canvas.loopTimes')}
              text={items.count.expression}
              shown={shownValue(context, items.count.expression)}
              problem={problems.get(t('canvas.loopTimes'))}
              choices={choices}
              nameOf={nameOf}
              onChange={(expression) => {
                setItems({ kind: 'count', count: { expression } });
              }}
              onUnlink={() => {
                setItems({ kind: 'count', count: 3 });
              }}
            />
          )
        ) : null}
        {kind === 'list' ? (
          <ExpressionField
            label={listLabel}
            text={items.kind === 'list' ? items.list.expression : ''}
            shown={shownValue(context, items.kind === 'list' ? items.list.expression : '')}
            problem={problems.get(listLabel)}
            choices={choices}
            nameOf={nameOf}
            autoFocus={items.kind !== 'list'}
            onChange={(expression) => {
              if (expression.trim() === '') return;
              setItems({ kind: 'list', list: { expression } });
            }}
            onUnlink={() => undefined}
          />
        ) : null}
        {kind === 'folder' && items.kind === 'folder' ? (
          <>
            {isExpressionValue(items.folder) ? (
              <ExpressionField
                label={folderLabel}
                text={items.folder.expression}
                shown={shownValue(context, items.folder.expression)}
                problem={problems.get(folderLabel)}
                choices={choices}
                nameOf={nameOf}
                onChange={(expression) => {
                  setItems({ ...items, folder: { expression } });
                }}
                onUnlink={() => {
                  setFolderText('');
                  setItems({ ...items, folder: '' });
                }}
              />
            ) : (
              <div className="field">
                <label className="field-label" htmlFor={folderId}>
                  {folderLabel}
                </label>
                <div className="field-row">
                  <input
                    id={folderId}
                    value={folderText}
                    aria-invalid={problems.has(folderLabel)}
                    onChange={(event) => {
                      const text = event.target.value;
                      if (text.trimStart().startsWith('=')) {
                        const expression = text.trimStart().slice(1).trimStart();
                        setItems({ ...items, folder: { expression } });
                        return;
                      }
                      setFolderText(text);
                      setItems({ ...items, folder: text });
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('canvas.browseFolder')}
                    title={t('canvas.browseFolder')}
                    onClick={() => {
                      void api
                        .pickPath()
                        .then((path) => {
                          if (path === undefined) return;
                          setFolderText(path);
                          setItems({ ...items, folder: path });
                        })
                        .catch(onError);
                    }}
                  >
                    <FolderOpen className="icon" aria-hidden="true" />
                  </button>
                </div>
                {problems.has(folderLabel) ? (
                  <p className="field-problem">{problems.get(folderLabel)}</p>
                ) : null}
              </div>
            )}
            <div className="field">
              <label className="field-label" htmlFor={patternId}>
                {t('canvas.loopPattern')}
              </label>
              <input
                id={patternId}
                value={items.pattern ?? ''}
                placeholder="*.pdf"
                maxLength={LOOP_PATTERN_MAX_LENGTH}
                onChange={(event) => {
                  const pattern = event.target.value.trim();
                  const rest = without(items, 'pattern');
                  setItems(pattern === '' ? rest : { ...rest, pattern });
                }}
              />
            </div>
            <div className="field field-check">
              <input
                id={subfoldersId}
                type="checkbox"
                checked={items.subfolders === true}
                onChange={(event) => {
                  const rest = without(items, 'subfolders');
                  setItems(event.target.checked ? { ...rest, subfolders: true } : rest);
                }}
              />
              <label htmlFor={subfoldersId}>{t('canvas.loopSubfolders')}</label>
            </div>
          </>
        ) : null}
      </PanelSection>
      <RoundFailure block={block} onChange={onChange} />
    </>
  );
}

/** Where a piece goes in a condition: alone, or joined to what is there with `and`. */
function withPiece(text: string, piece: string): string {
  const base = text.trimEnd();
  if (base === '') return piece;
  return /(\band|\bor|\bnot|\()$/.test(base) ? `${base} ${piece}` : `${base} and ${piece}`;
}

/**
 * The yes/no expression a While checks before each round, with what it reads back as and quick
 * pieces to add. Its suggestions offer values from before the loop, what the last round left, which
 * is empty on the first check, and the rounds done.
 */
function WhileCondition({
  block,
  choices,
  context,
  problems,
  nameOf,
  onChange,
}: Omit<LoopFieldsProps<WhileBlock>, 'sources' | 'onError'>) {
  const [text, setText] = useState(block.condition.expression);
  const set = (next: string): void => {
    setText(next);
    // A condition cannot be empty; the last one written stays until a new one is.
    if (next.trim() !== '') onChange({ ...block, condition: { expression: next } });
  };
  const body = context.blocks.filter(({ id }) => loopChain(context.blocks, id).includes(block.id));
  const inBody = new Set(body.map(({ id }) => id));
  const results = body
    .filter(({ type }) => !isLoopType(type))
    .map((inner): ValueChoice => ({
      group: 'result',
      block: inner.id,
      label: t('canvas.whileResult'),
      expression: `steps.${inner.id}.result`,
      type: 'text',
      fits: true,
    }));
  const own = (choice: ValueChoice): boolean =>
    choice.group === 'loop' && choice.block === block.id;
  const lastRound = [
    ...results,
    ...choices.filter(
      (choice) =>
        choice.group === 'result' && choice.block !== undefined && inBody.has(choice.block),
    ),
  ];
  const rounds = choices
    .filter((choice) => own(choice) && choice.expression === 'loop.index')
    .map((choice) => ({ ...choice, label: t('canvas.says.rounds') }));
  const before = choices.filter(
    (choice) =>
      !own(choice) &&
      choice.group !== 'setting' &&
      !(choice.block !== undefined && inBody.has(choice.block)),
  );
  const offered = [...before, ...lastRound, ...rounds];
  const firstResult = results[0]?.expression;
  const pick = (expression: string): void => {
    set(withPiece(text, expression));
  };
  const problem = problems.get(block.id);
  return (
    <>
      <ExpressionField
        label={t('canvas.whileCondition')}
        text={text}
        shown={{ kind: 'unknown' }}
        problem={problem}
        choices={offered}
        nameOf={nameOf}
        onChange={set}
        onUnlink={() => undefined}
      />
      {problem === undefined && text.trim() !== '' ? (
        <p className="while-readback" data-testid="while-readback">
          {t('canvas.whileReadBack', { sentence: expressionSentence(text, nameOf, true) })}
        </p>
      ) : null}
      <div className="while-inserts" role="group" aria-label={t('canvas.whileInserts')}>
        <button
          type="button"
          disabled={firstResult === undefined}
          onClick={() => {
            if (firstResult !== undefined) pick(`${firstResult} == "failed"`);
          }}
        >
          {t('canvas.whileInsertFailed')}
        </button>
        <button
          type="button"
          onClick={() => {
            pick('exists("")');
          }}
        >
          {t('canvas.whileInsertExists')}
        </button>
        <button
          type="button"
          onClick={() => {
            pick('loop.index < 5');
          }}
        >
          {t('canvas.whileInsertRounds')}
        </button>
        <button
          type="button"
          onClick={() => {
            set(`${text.trimEnd()} and `);
          }}
        >
          {t('canvas.whileInsertAnd')}
        </button>
      </div>
    </>
  );
}

/** A While: its condition, checked before each round, its maximum and its wait. */
export function WhileSettings({
  block,
  choices,
  context,
  problems,
  nameOf,
  onChange,
}: LoopFieldsProps<WhileBlock>) {
  return (
    <>
      <PanelSection id="loop.condition" title={t('canvas.sectionWhile')}>
        <WhileCondition
          block={block}
          choices={choices}
          context={context}
          problems={problems}
          nameOf={nameOf}
          onChange={onChange}
        />
      </PanelSection>
      <PanelSection id="loop.rounds" title={t('canvas.sectionRounds')}>
        <NumberField
          label={t('canvas.loopMaxRounds')}
          value={block.maxRounds}
          min={1}
          max={LOOP_ROUNDS_MAX}
          onChange={(maxRounds) => {
            onChange({ ...block, maxRounds });
          }}
        />
        <NumberField
          label={t('canvas.loopWait')}
          value={block.waitSeconds ?? 0}
          min={0}
          max={WAIT_SECONDS_MAX}
          onChange={(waitSeconds) => {
            const rest = without(block, 'waitSeconds');
            onChange(waitSeconds === 0 ? rest : { ...rest, waitSeconds });
          }}
        />
      </PanelSection>
      <RoundFailure block={block} onChange={onChange} />
    </>
  );
}
