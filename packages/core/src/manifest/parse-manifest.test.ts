import { describe, expect, it } from 'vitest';
import { DefinitionError } from '../storage/definition-error.js';
import { parseManifest, serializeManifest } from './parse-manifest.js';

const valid = `
# Comments are fine, since people write these by hand.
schemaVersion: 1
id: acme.log-parser
name: Log Parser
version: 1.2.0
level: 1
interpreter: python
run:
  program: parse.py
  args: [--strict]
parameters:
  - name: input
    type: path
    label: Input file
    required: true
    flag: --input
outputs:
  - name: csv
    path: out/result.csv
permissions: [filesystem.read]
`;

function failure(text: string): DefinitionError {
  try {
    parseManifest(text);
  } catch (error) {
    if (error instanceof DefinitionError) {
      return error;
    }
    throw error;
  }
  throw new Error('parseManifest accepted the text');
}

describe('parseManifest', () => {
  it('reads a valid manifest', () => {
    expect(parseManifest(valid)).toMatchObject({
      id: 'acme.log-parser',
      level: 1,
      leftoverProcesses: 'end',
      run: { program: 'parse.py', args: ['--strict'] },
    });
  });

  it('survives a round trip', () => {
    const manifest = parseManifest(valid);
    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  it('does not treat YAML 1.1 words as booleans', () => {
    const text = valid.replace('name: Log Parser', 'name: no');
    expect(parseManifest(text).name).toBe('no');
  });

  it('reports broken YAML', () => {
    expect(failure('id: [').message).toMatch(/not valid YAML/);
  });

  it('rejects duplicate keys, which YAML parsers often take silently', () => {
    expect(failure(`${valid}\nid: other\n`).message).toMatch(/not valid YAML/);
  });

  it.each(['', '- a', 'text'])('rejects a document that is not a mapping: %j', (text) => {
    expect(failure(text).message).toMatch(/mapping/);
  });

  it('names the field that failed, in plain words', () => {
    const error = failure(valid.replace('flag: --input', 'flag: "not a flag"'));
    expect(error.issues[0]?.path).toBe('parameters.0.flag');
    expect(error.message).toContain('parameters.0.flag');
    expect(error.message).not.toContain('"code"');
  });

  it('asks for an update when the manifest is newer than this build', () => {
    expect(failure(valid.replace('schemaVersion: 1', 'schemaVersion: 2')).message).toMatch(
      /Update Bildora/,
    );
  });

  it('upgrades an older manifest before validating it', () => {
    const older = valid.replace('schemaVersion: 1', 'schemaVersion: 0').replace('name:', 'title:');
    const rename = {
      from: 0,
      migrate: ({ title, ...rest }: Record<string, unknown>) => ({ ...rest, name: title }),
    };
    expect(parseManifest(older, [rename]).name).toBe('Log Parser');
  });
});
