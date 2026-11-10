/** A copy without some fields, because a field left out and an undefined one differ in a file. */
export function without<Item extends object, Key extends keyof Item>(
  item: Item,
  ...keys: readonly Key[]
): Omit<Item, Key> {
  const left = Object.entries(item).filter(([key]) => !keys.some((name) => name === key));
  return Object.fromEntries(left) as Omit<Item, Key>;
}

/** The command that runs an automation, quoted the way a Windows shell needs. */
export function commandFor(id: string): string {
  return `bildora run ${id}`;
}
