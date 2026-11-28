import { isDisableable } from '@bildora/protocol';
import type { AutomationBlock } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { MenuCommand, MenuEntry } from '../../shell/menu-model.js';
import { commandItem, toggleDisabledItem } from './canvas-commands.js';
import type { CanvasCommands } from './canvas-commands.js';

/** What a block's menu does beyond the canvas commands, which acts on that block alone. */
export interface BlockMenuActions {
  /** The blocks Add after offers. */
  readonly addAfter: readonly MenuEntry[];
  /** The outputs Connect offers, or undefined for a block with none. */
  readonly connect?: readonly MenuEntry[] | undefined;
  /** The tools Replace offers, or undefined when the block cannot be replaced. */
  readonly replace?: readonly MenuEntry[] | undefined;
  readonly rename: () => void;
  /** Opens what the block runs: its tool, or the automation it calls. Disabled without `run`. */
  readonly open?: { readonly label: string; readonly run?: (() => void) | undefined } | undefined;
  /** Tests the block alone, where that is offered for its kind. */
  readonly test?: (() => void) | undefined;
  /** Runs the automation from the block onward, where that is offered. */
  readonly runFrom?: (() => void) | undefined;
  /** Chooses the blocks inside a loop. */
  readonly selectInside?: (() => void) | undefined;
  readonly copyId: () => void;
  /** Brings the block into view, offered from its card, away from the canvas. */
  readonly showOnCanvas?: (() => void) | undefined;
}

/**
 * The one menu of a block, from a right-click on the canvas or from the ⋯ button on its card. The
 * commands act on every chosen block; while several are chosen, what needs one block is greyed,
 * so the menu keeps its shape.
 */
export function blockMenu(
  block: AutomationBlock,
  commands: CanvasCommands | undefined,
  actions: BlockMenuActions,
  several: boolean,
): MenuEntry[] {
  const one = (entry: MenuCommand): MenuCommand => (several ? { ...entry, disabled: true } : entry);
  const submenu = (label: string, items: readonly MenuEntry[], shortcut?: string): MenuCommand =>
    one({
      label,
      ...(shortcut === undefined ? {} : { shortcut }),
      items,
      ...(items.length === 0 ? { disabled: true } : {}),
    });
  const start = block.type === 'start';
  const { connect, replace, open, test, runFrom, selectInside, showOnCanvas } = actions;
  const testing: MenuEntry[] = [
    ...(test === undefined ? [] : [one({ label: t('test.menuBlock'), run: test })]),
    ...(runFrom === undefined ? [] : [one({ label: t('test.menuFrom'), run: runFrom })]),
  ];
  return [
    submenu(t('canvas.menuAdd'), actions.addAfter, 'A'),
    ...(connect === undefined ? [] : [submenu(t('canvas.menuConnect'), connect, 'C')]),
    ...(replace === undefined ? [] : [submenu(t('canvas.menuReplace'), replace)]),
    one({ label: t('canvas.rename'), shortcut: 'F2', run: actions.rename }),
    ...(open === undefined
      ? []
      : [
          one(
            open.run === undefined
              ? { label: open.label, disabled: true }
              : { label: open.label, run: open.run },
          ),
        ]),
    ...(testing.length === 0 ? [] : ['separator' as const, ...testing]),
    ...(start
      ? []
      : [
          'separator' as const,
          commandItem(t('command.cut'), commands?.cut, 'Ctrl+X'),
          commandItem(t('command.copy'), commands?.copy, 'Ctrl+C'),
          commandItem(t('command.duplicate'), commands?.duplicate, 'Ctrl+D'),
          'separator' as const,
          ...(isDisableable(block.type) ? [toggleDisabledItem(commands)] : []),
          commandItem(t('command.takeOut'), commands?.takeOut),
          commandItem(t('command.group'), commands?.group, 'Ctrl+G'),
        ]),
    'separator',
    start
      ? commandItem(t('command.selectDownstream'), commands?.selectDownstream)
      : {
          label: t('canvas.menuSelect'),
          items: [
            commandItem(t('canvas.menuUpstream'), commands?.selectUpstream),
            commandItem(t('canvas.menuDownstream'), commands?.selectDownstream),
            ...(selectInside === undefined
              ? []
              : [one({ label: t('canvas.menuInside'), run: selectInside })]),
          ],
        },
    commandItem(t('canvas.menuShowUses'), commands?.showUses),
    one({ label: t('canvas.menuCopyId'), run: actions.copyId }),
    ...(showOnCanvas === undefined
      ? []
      : [one({ label: t('canvas.menuShowOnCanvas'), run: showOnCanvas })]),
    ...(start
      ? []
      : [
          'separator' as const,
          commandItem(t('canvas.menuDelete'), commands?.delete, 'Del', { danger: true }),
        ]),
  ];
}

/** A note's menu, whose commands act on every chosen item. */
export function noteMenu(
  commands: CanvasCommands | undefined,
  write: () => void,
  several: boolean,
): MenuEntry[] {
  return [
    { label: t('canvas.menuWrite'), run: write, ...(several ? { disabled: true } : {}) },
    'separator',
    commandItem(t('command.cut'), commands?.cut, 'Ctrl+X'),
    commandItem(t('command.copy'), commands?.copy, 'Ctrl+C'),
    commandItem(t('command.duplicate'), commands?.duplicate, 'Ctrl+D'),
    'separator',
    commandItem(t('canvas.menuDelete'), commands?.delete, 'Del', { danger: true }),
  ];
}
