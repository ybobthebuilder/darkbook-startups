#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute, normativeHashes, read, registryFile, root, schemaFile, sha256 } from './lib.mjs';
import { validateAndLog } from './contract.mjs';

await execute('build', async (log) => {
  validateAndLog(log);
  const files = [schemaFile, registryFile].sort();
  const contents = Object.fromEntries(files.map((file) => [file, read(file)]));
  for (const file of files) {
    if (sha256(contents[file]) !== normativeHashes[file]) throw new Error(`Normative file changed: ${file}`);
  }
  const registry = JSON.parse(contents[registryFile]);
  if (registry.release_decision !== 'NO_GO' || registry.gates.some((gate) => gate.status !== 'NOT_VERIFIED')) {
    throw new Error('Registry must remain NO_GO / NOT_VERIFIED');
  }
  const manifest = {
    format: 'darwin-f0-contract-bundle-v1',
    scope: 'Contrato estático; não é uma aplicação nem um runtime GraphQL.',
    release_decision: 'NO_GO',
    files: files.map((path) => ({ path, sha256: sha256(contents[path]), bytes: Buffer.byteLength(contents[path]) })),
  };
  mkdirSync(join(root, 'dist'), { recursive: true });
  for (const file of files) writeFileSync(join(root, 'dist', file), contents[file]);
  writeFileSync(join(root, 'dist', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log('Bundle determinístico produzido em dist/: dois contratos e manifest.json (SHA-256).');
});
