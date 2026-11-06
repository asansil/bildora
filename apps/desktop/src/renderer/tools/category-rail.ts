import { t } from '../../shared/i18n/translate.js';
import type { ToolGroupView } from '../../shared/ipc-contract.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function groupKey(group: ToolGroupView): string {
  return group.category ?? '';
}

export function groupLabel(group: ToolGroupView): string {
  return group.category ?? t('nav.uncategorized');
}

/** The default logo of a category: its first character as the user sees it, in capitals. */
export function categoryInitial(label: string): string {
  const [first] = graphemes.segment(label.trim());
  return first?.segment.toUpperCase() ?? '';
}

/** Which category's panel is open after pressing one: pressing the open one closes it. */
export function toggleCategory(open: string | undefined, pressed: string): string | undefined {
  return open === pressed ? undefined : pressed;
}

/** Names differing only in case are one category, which core decides the same way. */
function categoryKey(category: string): string {
  return category.toLocaleLowerCase('en');
}

/**
 * The rail order after dropping a category on another, which it takes the place of. Categories
 * placed before that are not shown now keep their turn for when they return.
 */
export function placeCategory(
  groups: readonly ToolGroupView[],
  stored: readonly string[],
  dragged: string,
  target: string,
): readonly string[] {
  const shown = groups.flatMap(({ category }) =>
    category === undefined ? [] : [categoryKey(category)],
  );
  const from = shown.indexOf(categoryKey(dragged));
  const to = shown.indexOf(categoryKey(target));
  if (from === -1 || to === -1 || from === to) {
    return stored;
  }
  const others = shown.filter((_key, index) => index !== from);
  const placed = [...others.slice(0, to), shown[from] ?? '', ...others.slice(to)];
  return [...placed, ...stored.filter((key) => !shown.includes(key))];
}
