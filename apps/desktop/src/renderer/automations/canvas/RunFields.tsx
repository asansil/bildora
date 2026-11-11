import { useEffect, useId, useMemo, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Crosshair } from 'lucide-react';
import { fitsParameter, isExpressionValue, parseCached, targetOf } from '@bildora/protocol';
import type { LiteralValue, RunBlock } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { MessageKey } from '../../../shared/i18n/translate.js';
import type { ParameterView, ProfileView, ToolView } from '../../../shared/ipc-contract.js';
import { ContextMenu } from '../../shell/ContextMenu.js';
import type { MenuEntry } from '../../shell/menu-model.js';
import { ParameterForm } from '../../tools/ParameterForm.js';
import { parameterProblem, submittedValues } from '../../tools/parameter-form.js';
import type { FormValue, FormValues } from '../../tools/parameter-form.js';
import { without } from '../automation-draft.js';
import { ExpressionField } from './ExpressionField.js';
import { NumberField, Select } from './fields.js';
import { blockMenuItems, linkMenuItems } from './value-menu.js';
import { asExpression, shownValue, unlinkedValue, valueChoices } from './values.js';
import type { ValueChoice, ValueContext } from './values.js';

const api = window.bildora;

/** The plain values of a block, as a form holds them. Linked ones are left to their own field. */
function formFrom(parameters: readonly ParameterView[], values: RunBlock['values']): FormValues {
  return Object.fromEntries(
    parameters.map(({ name, type }) => {
      const value = values?.[name];
      if (isExpressionValue(value)) return [name, type === 'boolean' ? false : ''];
      return [name, type === 'boolean' ? value === true : String(value ?? '')];
    }),
  );
}

/** The expressions of a block, by parameter, without their `=`. */
function expressionsFrom(values: RunBlock['values']): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(values ?? {}).flatMap(([name, value]) =>
      isExpressionValue(value) ? [[name, value.expression]] : [],
    ),
  );
}

/** What a form holds, as a block stores it: only what was set, so the rest stays as the tool has it. */
function plainValues(
  parameters: readonly ParameterView[],
  form: FormValues,
): Record<string, LiteralValue> {
  const usable = parameters.filter(
    (parameter) => parameterProblem(parameter, form[parameter.name], false) === undefined,
  );
  const { plain } = submittedValues(usable, form);
  return Object.fromEntries(Object.entries(plain).filter(([, value]) => value !== false));
}

/** A form value as a plain value of its parameter, for turning it into an expression. */
function literalOf(
  parameter: ParameterView,
  value: FormValue | undefined,
): LiteralValue | undefined {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value.trim() === '') return undefined;
  if (parameter.type === 'integer' || parameter.type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  return value;
}

/** The block a bare link points at, such as `convert` for `convert.file`. */
function sourceOf(expression: string): string | undefined {
  const tree = parseCached(expression);
  if (tree instanceof Error || tree.kind !== 'name') return undefined;
  try {
    const target = targetOf(tree);
    return target.kind === 'link' || target.kind === 'output' ? target.block : undefined;
  } catch {
    return undefined;
  }
}

interface Whip {
  readonly name: string;
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
}

/** The canvas node of the block under a point of the window, with the block's id. */
function nodeAt(x: number, y: number): { readonly id: string; readonly node: Element } | undefined {
  for (const element of document.elementsFromPoint(x, y)) {
    const node = element.closest('.react-flow__node');
    const id = node?.getAttribute('data-id');
    if (id !== null && id !== undefined && node?.classList.contains('react-flow__node-block')) {
      return { id, node };
    }
  }
  return undefined;
}

/** The block under a point of the window. */
function blockAt(x: number, y: number): string | undefined {
  return nodeAt(x, y)?.id;
}

const WHIP_TARGET = 'is-whip-target';

interface Menu {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly items: readonly MenuEntry[];
}

export interface RunFieldsProps {
  readonly block: RunBlock;
  readonly tools: readonly ToolView[];
  readonly context: ValueContext;
  /** Problems of the flow about this block's values, worded, by parameter label. */
  readonly problems: ReadonlyMap<string, string>;
  readonly nameOf: (id: string) => string;
  readonly onChange: (block: RunBlock) => void;
  /** Selects another block on the canvas. */
  readonly onGoTo: (blockId: string) => void;
  readonly onError: (error: unknown) => void;
}

/**
 * A Run tool block. Each value is the block's own, or worked out from others after `=`: typing `=`,
 * the field's menu, or dragging its pick-whip onto a block links it. Secrets have no field here:
 * they only ever come from a profile.
 */
export function RunFields({
  block,
  tools,
  context,
  problems: flowProblems,
  nameOf,
  onChange,
  onGoTo,
  onError,
}: RunFieldsProps) {
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
  const [linked, setLinked] = useState(() => expressionsFrom(block.values));
  /** The field just linked, which takes the caret. */
  const [justLinked, setJustLinked] = useState<string | undefined>();
  const [profiles, setProfiles] = useState<readonly ProfileView[]>([]);
  const [menu, setMenu] = useState<Menu | undefined>();
  const [whip, setWhip] = useState<Whip | undefined>();
  const toolLevel = tool?.level;
  const choices = useMemo(() => valueChoices(context, block.id), [context, block.id]);

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

  function commit(nextForm: FormValues, nextLinked: Readonly<Record<string, string>>): void {
    setForm(nextForm);
    setLinked(nextLinked);
    const plain = plainValues(
      parameters.filter(({ name }) => !Object.hasOwn(nextLinked, name)),
      nextForm,
    );
    const worked = Object.fromEntries(
      Object.entries(nextLinked)
        .filter(([, text]) => text.trim() !== '')
        .map(([name, text]) => [name, { expression: text.trim() }]),
    );
    const values = { ...plain, ...worked };
    const rest: RunBlock = without(block, 'values');
    onChange(Object.keys(values).length === 0 ? rest : { ...rest, values });
  }

  function link(name: string, expression: string): void {
    setJustLinked(name);
    commit(form, { ...linked, [name]: expression });
  }

  /** Removes a link, keeping what it resolved to when `keep` says so and that value is known. */
  function unlink(parameter: ParameterView, keep: boolean): void {
    const text = linked[parameter.name] ?? '';
    const value = keep ? unlinkedValue(shownValue(context, text), parameter.type) : undefined;
    const rest = Object.fromEntries(
      Object.entries(linked).filter(([name]) => name !== parameter.name),
    );
    const formValue =
      parameter.type === 'boolean' ? value === true : value === undefined ? '' : String(value);
    commit({ ...form, [parameter.name]: formValue }, rest);
  }

  function setValue(name: string, value: FormValue): void {
    if (typeof value === 'string' && value.trimStart().startsWith('=')) {
      link(name, value.trimStart().slice(1).trimStart());
      return;
    }
    commit({ ...form, [name]: value }, linked);
  }

  /** What a parameter can link to, each marked by whether it fits. */
  function fittingChoices(parameter: ParameterView): readonly ValueChoice[] {
    return choices.map((choice) => ({
      ...choice,
      fits: fitsParameter(choice.type, parameter.type),
    }));
  }

  function fieldMenu(parameter: ParameterView, x: number, y: number): void {
    const { name, label } = parameter;
    const expression = linked[name];
    const pick = (choice: ValueChoice): void => {
      link(name, choice.expression);
    };
    const source = expression === undefined ? undefined : sourceOf(expression);
    const items: MenuEntry[] = [
      { label: t('canvas.linkTo'), items: linkMenuItems(fittingChoices(parameter), nameOf, pick) },
      expression === undefined
        ? {
            label: t('canvas.useExpression'),
            run: () => {
              link(name, asExpression(literalOf(parameter, form[name])));
            },
          }
        : {
            label: t('canvas.unlink'),
            run: () => {
              unlink(parameter, true);
            },
          },
      ...(source === undefined
        ? []
        : [
            {
              label: t('canvas.goToSource', { name: nameOf(source) }),
              run: () => {
                onGoTo(source);
              },
            },
          ]),
    ];
    setMenu({ x, y, label: t('canvas.fieldMenu', { label }), items });
  }

  function startWhip(parameter: ParameterView, event: ReactPointerEvent<HTMLButtonElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const from = { x: event.clientX, y: event.clientY };
    setWhip({ name: parameter.name, from, to: from });
    const fitting = fittingChoices(parameter);
    /** The block under the tip, highlighted because one of its values fits the field. */
    let marked: Element | undefined;
    const mark = (node: Element | undefined): void => {
      if (node === marked) return;
      marked?.classList.remove(WHIP_TARGET);
      node?.classList.add(WHIP_TARGET);
      marked = node;
    };
    const move = (moved: PointerEvent): void => {
      setWhip((current) =>
        current === undefined
          ? undefined
          : { ...current, to: { x: moved.clientX, y: moved.clientY } },
      );
      const under = nodeAt(moved.clientX, moved.clientY);
      const fits =
        under !== undefined &&
        fitting.some(
          (choice) =>
            choice.block === under.id && (choice.group === 'setting' || choice.group === 'result'),
        );
      mark(fits ? under.node : undefined);
    };
    const stop = (): void => {
      mark(undefined);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', cancel);
      setWhip(undefined);
    };
    const up = (released: PointerEvent): void => {
      stop();
      const target = blockAt(released.clientX, released.clientY);
      if (target === undefined) return;
      const items = blockMenuItems(fitting, target, (choice) => {
        link(parameter.name, choice.expression);
      });
      setMenu({
        x: released.clientX,
        y: released.clientY,
        label: t('canvas.fieldMenu', { label: parameter.label }),
        items,
      });
    };
    const cancel = (key: KeyboardEvent): void => {
      if (key.key === 'Escape') stop();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', cancel);
  }

  const problems = Object.fromEntries(
    parameters.flatMap((parameter) => {
      if (Object.hasOwn(linked, parameter.name)) return [];
      const problem = parameterProblem(parameter, form[parameter.name], false);
      return problem === undefined ? [] : [[parameter.name, problem]];
    }),
  ) as Readonly<Record<string, MessageKey>>;
  const retry = typeof block.onFailure === 'object' ? block.onFailure.retry : undefined;

  const decorate = (parameter: ParameterView, field: ReactNode): ReactNode => (
    <div
      className="value-field"
      data-testid="value-field"
      data-parameter={parameter.name}
      onContextMenu={(event) => {
        event.preventDefault();
        fieldMenu(parameter, event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault();
          const box = event.currentTarget.getBoundingClientRect();
          fieldMenu(parameter, box.left + 16, box.top + 24);
        }
      }}
    >
      {field}
      <button
        type="button"
        className="pick-whip"
        aria-label={t('canvas.pickWhip', { label: parameter.label })}
        title={t('canvas.pickWhip', { label: parameter.label })}
        onPointerDown={(event) => {
          startWhip(parameter, event);
        }}
        onClick={(event) => {
          // From the keyboard, the menu offers the same links.
          if (event.detail === 0) {
            const box = event.currentTarget.getBoundingClientRect();
            fieldMenu(parameter, box.left, box.bottom);
          }
        }}
      >
        <Crosshair className="icon" aria-hidden="true" />
      </button>
    </div>
  );

  const replace = (parameter: ParameterView): ReactNode => {
    const text = linked[parameter.name];
    if (text === undefined) return undefined;
    return (
      <ExpressionField
        label={parameter.label}
        text={text}
        shown={shownValue(context, text)}
        problem={flowProblems.get(parameter.label)}
        choices={choices}
        nameOf={nameOf}
        autoFocus={justLinked === parameter.name}
        onChange={(next) => {
          commit(form, { ...linked, [parameter.name]: next });
        }}
        onUnlink={() => {
          unlink(parameter, false);
        }}
      />
    );
  };

  return (
    <>
      {tool === undefined ? (
        <p className="field-problem">{t('automation.toolMissing', { id: block.tool })}</p>
      ) : null}
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
            replace={replace}
            decorate={decorate}
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
      {menu === undefined ? null : (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.label}
          items={menu.items}
          onClose={() => {
            setMenu(undefined);
          }}
        />
      )}
      {whip === undefined ? null : (
        <svg className="pick-whip-line" aria-hidden="true">
          <line x1={whip.from.x} y1={whip.from.y} x2={whip.to.x} y2={whip.to.y} />
          <circle cx={whip.to.x} cy={whip.to.y} r={4} />
        </svg>
      )}
    </>
  );
}
