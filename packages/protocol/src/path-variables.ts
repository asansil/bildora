const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const NAME_MAX_LENGTH = 64;
const REFERENCE_PATTERN = /\{\{paths\.([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g;
const REFERENCE_START_PATTERN = /^\{\{paths\.[a-zA-Z][a-zA-Z0-9_-]*\}\}/;

/** Tells whether a value can name a per-machine path variable. */
export function isPathVariableName(value: string): boolean {
  return value.length <= NAME_MAX_LENGTH && NAME_PATTERN.test(value);
}

/** Tells whether a path starts from a variable, which makes it as good as an absolute one. */
export function startsWithPathVariable(text: string): boolean {
  return REFERENCE_START_PATTERN.test(text);
}

/** Replaces each `{{paths.name}}` in a text. Replacements are not read again. */
export function replacePathVariables(text: string, replace: (name: string) => string): string {
  return text.replace(REFERENCE_PATTERN, (_match, name: string) => replace(name));
}
