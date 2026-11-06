// Writes the published manifest JSON Schema next to the build output.
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildToolManifestJsonSchema } from '../dist/index.js';

const directory = new URL('../dist/schemas/', import.meta.url);
mkdirSync(directory, { recursive: true });
writeFileSync(
  new URL('tool-manifest.schema.json', directory),
  `${JSON.stringify(buildToolManifestJsonSchema(), null, 2)}\n`,
);
