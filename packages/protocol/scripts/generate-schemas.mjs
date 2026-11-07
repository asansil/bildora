// Writes the published JSON Schemas next to the build output.
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildAutomationJsonSchema, buildToolManifestJsonSchema } from '../dist/index.js';

const directory = new URL('../dist/schemas/', import.meta.url);
mkdirSync(directory, { recursive: true });
for (const [file, schema] of [
  ['tool-manifest.schema.json', buildToolManifestJsonSchema()],
  ['automation.schema.json', buildAutomationJsonSchema()],
]) {
  writeFileSync(new URL(file, directory), `${JSON.stringify(schema, null, 2)}\n`);
}
