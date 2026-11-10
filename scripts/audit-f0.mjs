#!/usr/bin/env node
import { lstatSync, readdirSync, writeFileSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { execute, gateIds, limits, normativeHashes, read, registryFile, root, schemaFile, sha256 } from './lib.mjs';

const mappings = {
  test: 'playwright test',
  'test:headed': 'playwright test --headed',
  'validate:schema': 'node scripts/validate-schema.mjs',
  'audit:f0': 'node scripts/audit-f0.mjs',
  dev: 'node scripts/dev.mjs',
  build: 'node scripts/build.mjs',
};
const commands = ['validate-schema', 'audit-f0', 'dev', 'build'];
const requiredFiles = [
  'package.json', 'package-lock.json', 'playwright.config.mjs', 'docs/F0-spec.md', schemaFile, registryFile,
  'scripts/lib.mjs', ...commands.map((name) => `scripts/${name}.mjs`), 'tests/f0.spec.mjs',
];

await execute('audit-f0', async (log) => {
  let validateContract;
  let validatorImportError;
  try {
    ({ validateContract } = await import('./validate-schema.mjs'));
  } catch (error) {
    validatorImportError = error;
  }
  const checks = [];
  function check(id, action) {
    try {
      const details = action();
      checks.push({ id, status: 'PASS', details: details ?? 'OK' });
      log(`PASS ${id}: ${details ?? 'OK'}`);
    } catch (error) {
      checks.push({ id, status: 'FAIL', details: error.message });
      log(`FAIL ${id}: ${error.message}`);
    }
  }
  function requireCondition(value, message) {
    if (!value) throw new Error(message);
  }
  function inventory(path) {
    return readdirSync(join(root, path)).filter((name) => name !== '.git').sort().map((name) => {
      const stat = lstatSync(join(root, path, name));
      return { name, type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file', bytes: stat.size, executable: Boolean(stat.mode & 0o111) };
    });
  }
  let rootInventory = [];
  let scriptInventory = [];
  check('inventory.root', () => { rootInventory = inventory('.'); return `${rootInventory.length} entradas (sem .git; não recursivo)`; });
  check('inventory.scripts', () => { scriptInventory = inventory('scripts'); return `${scriptInventory.length} entradas`; });
  for (const file of requiredFiles) check(`file:${file}`, () => {
    requireCondition(lstatSync(join(root, file)).isFile(), `${file} must be a regular file`);
    requireCondition(read(file).trim().length > 0, `${file} must not be empty`);
  });
  check('engines.declared', () => {
    const pkg = JSON.parse(read('package.json'));
    requireCondition(pkg.engines?.node === '>=24.0.0' && pkg.engines?.npm === '>=11.0.0', 'Expected node >=24.0.0 and npm >=11.0.0 declarations');
    return JSON.stringify(pkg.engines);
  });
  check('engines.runtime.node', () => {
    requireCondition(Number(process.versions.node.split('.')[0]) >= 24, `Unsupported Node ${process.version}`);
    return process.version;
  });
  check('engines.runtime.npm', () => {
    const result = spawnSync('npm', ['--version'], { cwd: root, encoding: 'utf8', timeout: 15000 });
    if (result.error) throw result.error;
    const version = result.stdout.trim();
    requireCondition(result.status === 0 && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) && Number(version.split('.')[0]) >= 11, `Unsupported npm: ${version}; ${result.stderr}`);
    return version;
  });
  check('scripts.mappings', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const [name, value] of Object.entries(mappings)) requireCondition(pkg.scripts?.[name] === value, `Unexpected mapping ${name}`);
    requireCondition(Boolean(pkg.devDependencies?.['@playwright/test']), 'Existing Playwright framework is required');
    return JSON.stringify(pkg.scripts);
  });
  for (const name of commands) check(`executable:${name}`, () => {
    const file = `scripts/${name}.mjs`;
    accessSync(join(root, file), constants.X_OK);
    requireCondition(read(file).startsWith('#!/usr/bin/env node\n'), `${file} missing Node shebang`);
  });
  check('scripts.no-placeholders', () => {
    const files = ['scripts/lib.mjs', ...commands.map((name) => `scripts/${name}.mjs`)];
    for (const file of files) {
      requireCondition(!/\bTODO\b|\bFIXME\b|not[\s_-]+implemented|not[\s_-]+initialized|implement[\s_-]+after/i.test(read(file)), `Placeholder in ${file}`);
    }
    return 'Inspeção estática dos scripts; execução coberta pelos testes, não inferida por esta busca.';
  });
  for (const [file, hash] of Object.entries(normativeHashes)) check(`normative:${file}`, () => {
    requireCondition(sha256(read(file)) === hash, `Normative bytes changed: ${file}`);
    return `SHA-256 ${hash}`;
  });
  check('schema.validity-and-f0-structure', () => {
    if (validatorImportError) throw validatorImportError;
    validateContract();
    return 'buildSchema + validateSchema, RevisionedNode, implementações, mutações e campos genéricos.';
  });
  let gates = [];
  check('registry.baseline', () => {
    const registry = JSON.parse(read(registryFile));
    requireCondition(Array.isArray(registry.gates), 'gates must be an array');
    gates = registry.gates;
    const ids = gates.map((gate) => gate.id);
    requireCondition(ids.length === gateIds.length && new Set(ids).size === gateIds.length && gateIds.every((id) => ids.includes(id)), 'Expected exactly 14 required gate IDs without duplicates');
    requireCondition(gates.every((gate) => gate.status === 'NOT_VERIFIED' && gate.evidence === ''), 'Gates must remain NOT_VERIFIED with empty evidence');
    requireCondition(registry.release_decision === 'NO_GO', 'Release must remain NO_GO');
    return '14 gates NOT_VERIFIED; release_decision NO_GO; nenhuma promoção.';
  });
  const report = {
    phase: 'F0',
    status: checks.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS',
    release_decision: 'NO_GO',
    generated_at: new Date().toISOString(),
    inventories: { root: rootInventory, scripts: scriptInventory },
    checks,
    gates,
    scope_limits: limits,
  };
  writeFileSync(join(root, 'artifacts', 'audit-f0-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  log(`Relatório: artifacts/audit-f0-report.json; F0=${report.status}; release_decision=NO_GO`);
  for (const limit of limits) log(`LIMITE: ${limit}`);
  if (report.status !== 'PASS') throw new Error('F0 audit failed; see report checks');
});
