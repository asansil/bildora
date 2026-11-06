const THEME_TOKEN_PREFIX = '--bildora-';

/** Returns the CSS custom property that holds a shared theme token. */
export function themeTokenProperty(token: string): string {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(token)) {
    throw new RangeError(`Invalid theme token name: ${token}`);
  }
  return `${THEME_TOKEN_PREFIX}${token}`;
}
