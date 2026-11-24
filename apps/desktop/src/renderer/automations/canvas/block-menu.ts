import { isDisableable } from '@bildora/protocol';
import type { AutomationBlock } from '@bildora/protocol';
import { t } from '../../../shared/i18n/translate.js';
import type { MenuEntry } from '../../shell/menu-model.js';
import { commandItem, toggleDisabledItem } from './canvas-commands.js';
import type { CanvasCommands } from './canvas-commands.js';

/** What the block card does itself, beyond the canvas commands. */
export interface BlockCardActions {
  readonly rename: () => void;
  readonly showOnCanvas: () => void;
  readonly copyId: () => void;
  /** Opens the program a Run block runs, when it is installed. */
  readonly openTool?: (() => void) | undefined;
}

/**
 * The menu of the selected block's card, opened from its ⋯ button or a right-click on its name.
 * The block is the only one selected, so the canvas commands act on it alone.
 */
export function blockCardMenu(
  block: AutomationBlock,
  commands: CanvasCommands | undefined,
  actions: BlockCardActions,
): MenuEntry[] {
  const run = block.type === 'run';
  return [
    { label: t('canvas.rename'), shortcut: 'F2', run: actions.rename },
    ...(run ? [commandItem(t('canvas.menuReplace'), commands?.replace)] : []),
    ...(block.type === 'start'
      ? []
      : [commandItem(t('command.duplicate'), commands?.duplicate, 'Ctrl+D')]),
    ...(isDisableable(block.type) ? [toggleDisabledItem(commands)] : []),
    'separator',
    { label: t('canvas.menuShowOnCanvas'), run: actions.showOnCanvas },
    commandItem(t('canvas.menuShowUses'), commands?.showUses),
    ...(run
      ? [
          actions.openTool === undefined
            ? { label: t('canvas.menuOpenTool'), disabled: true }
            : { label: t('canvas.menuOpenTool'), run: actions.openTool },
        ]
      : []),
    { label: t('canvas.menuCopyId', { id: block.id }), run: actions.copyId },
    ...(block.type === 'start'
      ? []
      : [
          'separator' as const,
          commandItem(t('canvas.menuDelete'), commands?.delete, 'Del', { danger: true }),
        ]),
  ];
}
