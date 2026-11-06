import { describe, expect, it } from 'vitest';
import { DefinitionError } from './definition-error.js';
import { migrateDefinition } from './migrations.js';
import type { VersionedFormat } from './migrations.js';

const format: VersionedFormat = {
  label: 'sample',
  versionField: 'schemaVersion',
  currentVersion: 2,
  migrations: [
    { from: 0, migrate: ({ title, ...rest }) => ({ ...rest, name: title }) },
    { from: 1, migrate: (document) => ({ ...document, tags: [] }) },
  ],
};

describe('migrateDefinition', () => {
  it('leaves a current definition as it is', () => {
    const document = { schemaVersion: 2, name: 'a' };
    expect(migrateDefinition(document, format)).toBe(document);
  });

  it('applies every step in order and records the final version', () => {
    expect(migrateDefinition({ schemaVersion: 0, title: 'a' }, format)).toEqual({
      schemaVersion: 2,
      name: 'a',
      tags: [],
    });
  });

  it('does not touch the document it was given', () => {
    const document = { schemaVersion: 0, title: 'a' };
    migrateDefinition(document, format);
    expect(document).toEqual({ schemaVersion: 0, title: 'a' });
  });

  it('refuses a definition from a newer build and names the fix', () => {
    expect(() => migrateDefinition({ schemaVersion: 3 }, format)).toThrow(/Update Bildora/);
  });

  it('refuses a version with no path to the current one', () => {
    const gap = { ...format, migrations: [{ from: 1, migrate: (d: object) => ({ ...d }) }] };
    expect(() => migrateDefinition({ schemaVersion: 0 }, gap)).toThrow(/cannot upgrade/);
  });

  it.each([[undefined], ['1'], [1.5], [-1]])('refuses version %s', (schemaVersion) => {
    expect(() => migrateDefinition({ schemaVersion }, format)).toThrow(DefinitionError);
  });
});
