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
