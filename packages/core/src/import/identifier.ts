import { isValidIdentifier } from '@bildora/protocol';

const IDENTIFIER_BASE_LENGTH = 100;

/** Makes a folder-safe id from a name, as close to readable as the name allows. */
export function identifierFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, IDENTIFIER_BASE_LENGTH)
    .replace(/^-+|-+$/g, '');
  if (slug === '') {
    return 'tool';
  }
  return isValidIdentifier(slug) ? slug : `tool-${slug}`;
}
