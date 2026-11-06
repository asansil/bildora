/** Scores how well a query fits a label. Lower is better, and undefined means no match. */
function score(label: string, query: string): number | undefined {
  const text = label.toLocaleLowerCase('en');
  const position = text.indexOf(query);
  if (position === 0) {
    return 0;
  }
  if (position > 0) {
    return /\s|[-_.]/.test(text.charAt(position - 1)) ? 1 : 2;
  }
  // Letters in order, so "lp" finds "Log Parser".
  let from = 0;
  for (const character of query) {
    const found = text.indexOf(character, from);
    if (found === -1) {
      return undefined;
    }
    from = found + 1;
  }
  return 3;
}

/** Filters items by a typed query, best matches first, keeping the given order among equals. */
export function matchCommands<Item extends { readonly label: string }>(
  items: readonly Item[],
  query: string,
): readonly Item[] {
  const needle = query.trim().toLocaleLowerCase('en');
  if (needle === '') {
    return items;
  }
  return items
    .flatMap((item, index) => {
      const value = score(item.label, needle);
      return value === undefined ? [] : [{ item, index, value }];
    })
    .sort((first, second) => first.value - second.value || first.index - second.index)
    .map(({ item }) => item);
}
