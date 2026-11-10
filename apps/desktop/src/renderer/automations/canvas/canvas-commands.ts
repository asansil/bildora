import { t } from '../../../shared/i18n/translate.js';
import type { MenuCommand, MenuEntry } from '../../shell/menu-model.js';

/** Something the canvas can do now, or cannot. */
export interface CanvasCommand {
  readonly enabled: boolean;
  readonly run: () => void;
}

/** A canvas option and a way to turn it the other way. */
export interface CanvasToggle {
  readonly on: boolean;
  readonly toggle: () => void;
}

/** What the automation tab around the canvas does: its undo history, groups and saving. */
export interface EditorCommands {
  readonly undo: CanvasCommand;
  readonly redo: CanvasCommand;
  readonly group: CanvasCommand;
  readonly ungroup: CanvasCommand;
  readonly save: CanvasCommand;
  readonly saveAndRun: CanvasCommand;
}

/**
 * Everything the menus offer on a flow, built by the canvas for its current state. The block
 * menu, the canvas menu and the app's menus all read this one object, so they never disagree.
 */
export interface CanvasCommands extends EditorCommands {
  readonly copy: CanvasCommand;
  readonly paste: CanvasCommand;
  readonly duplicate: CanvasCommand;
  readonly delete: CanvasCommand;
  readonly selectAll: CanvasCommand;
  readonly deselectAll: CanvasCommand;
  readonly invertSelection: CanvasCommand;
  readonly selectUpstream: CanvasCommand;
  readonly selectDownstream: CanvasCommand;
  readonly takeOut: CanvasCommand;
  readonly tidyAll: CanvasCommand;
  readonly tidySelected: CanvasCommand;
  readonly alignToGrid: CanvasCommand;
  /** The zoom now, 1 being 100%. */
  readonly zoom: number;
  readonly scaleTo: (zoom: number) => void;
  readonly scaleToFit: CanvasCommand;
  readonly scaleToRectangle: CanvasCommand;
  readonly zoomIn: CanvasCommand;
  readonly zoomOut: CanvasCommand;
  readonly showGrid: CanvasToggle;
  readonly snapToGrid: CanvasToggle;
  readonly rightAngles: CanvasToggle;
  readonly showNavigator: CanvasToggle;
}

/** The zooms Scale offers. */
export const SCALE_PRESETS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const;

function off(): void {
  // Nothing to do: the item is disabled.
}

const DISABLED: CanvasCommand = { enabled: false, run: off };

/** A menu item for a command, disabled when there is no canvas or the command cannot run now. */
export function commandItem(
  label: string,
  command: CanvasCommand | undefined,
  shortcut?: string,
  extra: Partial<MenuCommand> = {},
): MenuCommand {
  const { enabled, run } = command ?? DISABLED;
  return {
    label,
    ...(shortcut === undefined ? {} : { shortcut }),
    ...(enabled ? {} : { disabled: true }),
    run,
    ...extra,
  };
}

function toggleItem(label: string, toggle: CanvasToggle | undefined): MenuCommand {
  return toggle === undefined
    ? { label, checked: false, disabled: true }
    : { label, checked: toggle.on, run: toggle.toggle };
}

function percent(zoom: number): string {
  return `${String(Math.round(zoom * 100))}%`;
}

export function scaleEntries(commands: CanvasCommands | undefined): MenuEntry[] {
  const zoom = commands?.zoom ?? 1;
  const preset = SCALE_PRESETS.find((value) => Math.abs(value - zoom) < 0.005);
  return [
    commandItem(
      t('command.defaultScale'),
      commands && {
        enabled: true,
        run: () => {
          commands.scaleTo(1);
        },
      },
    ),
    commandItem(t('command.scaleToFit'), commands?.scaleToFit),
    commandItem(t('command.scaleToRectangle'), commands?.scaleToRectangle),
    'separator',
    ...SCALE_PRESETS.map((value) =>
      commandItem(
        percent(value),
        commands && {
          enabled: true,
          run: () => {
            commands.scaleTo(value);
          },
        },
        undefined,
        { checked: commands !== undefined && preset === value },
      ),
    ),
    {
      label: t('command.customScale', { percent: percent(zoom) }),
      checked: commands !== undefined && preset === undefined,
      disabled: true,
    },
    'separator',
    commandItem(t('command.zoomIn'), commands?.zoomIn),
    commandItem(t('command.zoomOut'), commands?.zoomOut),
  ];
}

export function optionsEntries(commands: CanvasCommands | undefined): MenuEntry[] {
  return [
    toggleItem(t('command.showGrid'), commands?.showGrid),
    toggleItem(t('canvas.snapToGrid'), commands?.snapToGrid),
    toggleItem(t('canvas.rightAngles'), commands?.rightAngles),
    toggleItem(t('command.showNavigator'), commands?.showNavigator),
  ];
}

export function arrangeEntries(commands: CanvasCommands | undefined): MenuEntry[] {
  return [
    commandItem(t('command.tidyAll'), commands?.tidyAll),
    commandItem(t('command.tidySelected'), commands?.tidySelected),
    commandItem(t('command.alignToGrid'), commands?.alignToGrid),
  ];
}

/** The Selection menu of the menu bar. */
export function selectionEntries(commands: CanvasCommands | undefined): MenuEntry[] {
  return [
    commandItem(t('command.selectAllBlocks'), commands?.selectAll, 'Ctrl+A'),
    commandItem(t('command.deselectAll'), commands?.deselectAll, 'Esc'),
    commandItem(t('command.invertSelection'), commands?.invertSelection),
    'separator',
    commandItem(t('command.selectUpstream'), commands?.selectUpstream),
    commandItem(t('command.selectDownstream'), commands?.selectDownstream),
    'separator',
    commandItem(t('command.group'), commands?.group, 'Ctrl+G'),
    commandItem(t('command.ungroup'), commands?.ungroup),
    commandItem(t('command.takeOut'), commands?.takeOut),
    'separator',
    commandItem(t('command.tidySelected'), commands?.tidySelected),
    commandItem(t('command.tidyAll'), commands?.tidyAll),
  ];
}
