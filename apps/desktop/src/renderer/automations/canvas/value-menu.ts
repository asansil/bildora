import { t } from '../../../shared/i18n/translate.js';
import type { MenuEntry } from '../../shell/menu-model.js';
import type { ValueChoice } from './values.js';

/** Submenus, one per block, of the choices that come from blocks. */
function byBlock(
  choices: readonly ValueChoice[],
  nameOf: (id: string) => string,
  pick: (choice: ValueChoice) => void,
): MenuEntry[] {
  const blocks = [...new Set(choices.map(({ block }) => block ?? ''))];
  return blocks.map((block) => ({
    label: nameOf(block),
    items: choices.filter((choice) => choice.block === block).map((choice) => item(choice, pick)),
  }));
}

function item(choice: ValueChoice, pick: (choice: ValueChoice) => void): MenuEntry {
  return {
    label: choice.fits ? choice.label : t('canvas.linkDoesNotFit', { label: choice.label }),
    disabled: !choice.fits,
    run: () => {
      pick(choice);
    },
  };
}

/**
 * The Link to menu of a field: the automation's inputs, results of earlier blocks and settings of
 * other blocks, each group by block. What does not fit the field is shown, but cannot be chosen.
 */
export function linkMenuItems(
  choices: readonly ValueChoice[],
  nameOf: (id: string) => string,
  pick: (choice: ValueChoice) => void,
): MenuEntry[] {
  const run = choices.filter(({ group }) => group === 'run');
  const inputs = choices.filter(({ group }) => group === 'input');
  const results = choices.filter(({ group }) => group === 'result');
  const settings = choices.filter(({ group }) => group === 'setting');
  const groups: MenuEntry[] = run.map((choice) => item(choice, pick));
  if (inputs.length > 0) {
    groups.push({
      label: t('canvas.linkInputs'),
      items: inputs.map((choice) => item(choice, pick)),
    });
  }
  if (results.length > 0) {
    groups.push({ label: t('canvas.linkResults'), items: byBlock(results, nameOf, pick) });
  }
  if (settings.length > 0) {
    groups.push({ label: t('canvas.linkSettings'), items: byBlock(settings, nameOf, pick) });
  }
  return groups.length > 0 ? groups : [{ label: t('canvas.linkNothing'), disabled: true }];
}

/** The choices of one block, for the menu a pick-whip opens when it lands on that block. */
export function blockMenuItems(
  choices: readonly ValueChoice[],
  block: string,
  pick: (choice: ValueChoice) => void,
): MenuEntry[] {
  const own = choices.filter((choice) => choice.block === block);
  const settings = own
    .filter(({ group }) => group === 'setting')
    .map((choice) => item(choice, pick));
  const results = own.filter(({ group }) => group === 'result').map((choice) => item(choice, pick));
  if (settings.length === 0 && results.length === 0) {
    return [{ label: t('canvas.linkNothingHere'), disabled: true }];
  }
  return [
    ...settings,
    ...(settings.length > 0 && results.length > 0 ? ['separator' as const] : []),
    ...results,
  ];
}
