import { test, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, schemaFile, registryFile, normativeHashes, sha256 } from '../scripts/lib.mjs';

const fixtures = join(root, 'test-results', 'f0-fixtures');
let fixture;
const servers = new Set();
const read = (file) => readFile(join(fixture, file), 'utf8');
const write = (file, value) => writeFile(join(fixture, file), value);
const run = (name, options = {}) => spawnSync(process.execPath, [join(fixture, 'scripts', `${name}.mjs`)], {
  cwd: join(fixture, 'docs'), encoding: 'utf8', timeout: 20_000, ...options,
});
const report = async () => JSON.parse(await read('artifacts/audit-f0-report.json'));
const failCheck = async (id) => expect((await report()).checks.find((check) => check.id === id)?.status).toBe('FAIL');

test.beforeEach(async () => {
  await mkdir(fixtures, { recursive: true });
  fixture = await mkdtemp(join(fixtures, 'case-'));
  for (const file of ['package.json', 'package-lock.json', 'playwright.config.mjs', schemaFile, registryFile]) {
    await copyFile(join(root, file), join(fixture, file));
  }
  for (const directory of ['scripts', 'docs', 'tests']) {
    await cp(join(root, directory), join(fixture, directory), { recursive: true });
  }
  await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir');
});

test.afterEach(async () => {
  for (const child of servers) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'close');
      child.kill('SIGTERM');
      await exited;
    }
    servers.delete(child);
  }
  await rm(fixture, { recursive: true, force: true });
});

test.afterAll(async () => {
  // Only remove an empty shared parent; another worker may still own a fixture.
  await rmdir(fixtures).catch(() => {});
});

test('valid schema checks definitions and honestly logs runtime limits from any cwd', async () => {
  const result = run('validate-schema');
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('7 implementações');
  expect(result.stdout).toContain('não prova desigualdade');
  expect(await read('artifacts/validate-schema.log')).toBe(result.stdout);
  for (const [file, hash] of Object.entries(normativeHashes)) expect(sha256(await read(file))).toBe(hash);
});

for (const [name, transform] of [
  ['syntax corruption', (s) => `${s}\ntype Broken {`],
  ['missing branchId', (s) => s.replace('  branchId: ID!\n', '')],
  ['nullable provenance', (s) => s.replace('  provenance: Provenance!\n', '  provenance: Provenance\n')],
  ['identity type', (s) => s.replace('  revisionId: ID!\n', '  revisionId: String!\n')],
  ['non-implementing Decision', (s) => s.replace('type Decision implements RevisionedNode', 'type Decision')],
  ['missing identity field', (s) => s.replace('  entityId: ID!\n', '')],
  ['destructive mixed-case mutation', (s) => `${s}\nextend type Mutation { hardDELETEHistory: Boolean }`],
  ['destructive underscore mutation', (s) => `${s}\nextend type Mutation { admin_remove_history: Boolean }`],
  ['physical update', (s) => `${s}\nextend type Mutation { updateClaim: Claim }`],
  ['overwrite mutation', (s) => `${s}\nextend type Mutation { overwriteRevision: Claim }`],
  ['physical modification', (s) => `${s}\nextend type Mutation { modifyClaim: Claim }`],
  ['physical edit', (s) => `${s}\nextend type Mutation { editClaim: Claim }`],
  ['generic changes field', (s) => `${s}\ninput ArbitraryInput { requestedChanges: JSON }`],
  ['generic delta input', (s) => `${s}\ninput ArbitraryInput { revision_delta: JSON }`],
  ['generic argument', (s) => `${s}\nextend type Mutation { createRevision(changeSet: JSON): Claim }`],
  ['generic output field', (s) => `${s}\nextend type Claim { modifications: JSON }`],
]) {
  test(`validator rejects ${name} with a literal failure log`, async () => {
    await write(schemaFile, transform(await read(schemaFile)));
    const result = run('validate-schema');
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('[validate-schema] FAIL');
    expect(await read('artifacts/validate-schema.log')).toBe(result.stdout);
  });
}

test('validator logs missing schema and exits nonzero', async () => {
  await rm(join(fixture, schemaFile));
  const result = run('validate-schema');
  expect(result.status).toBe(1);
  expect(await read('artifacts/validate-schema.log')).toContain('ENOENT');
});

test('SDL comments do not masquerade as banned fields', async () => {
  await write(schemaFile, `${await read(schemaFile)}\n# deleteHistory(changes: JSON) is prohibited\n`);
  expect(run('validate-schema').status).toBe(0);
});

test('build emits real deterministic bundle, hashes and literal log without modifying sources', async () => {
  const first = run('build');
  expect(first.status, first.stdout + first.stderr).toBe(0);
  expect(await readdir(join(fixture, 'dist'))).toEqual([schemaFile, 'manifest.json', registryFile].sort());
  const manifest = await read('dist/manifest.json');
  const data = JSON.parse(manifest);
  expect(data.release_decision).toBe('NO_GO');
  for (const file of data.files) {
    expect(await read(`dist/${file.path}`)).toBe(await read(file.path));
    expect(sha256(await read(`dist/${file.path}`))).toBe(file.sha256);
    expect(Buffer.byteLength(await read(`dist/${file.path}`))).toBe(file.bytes);
  }
  expect(await read('artifacts/build.log')).toBe(first.stdout);
  expect(run('build').status).toBe(0);
  expect(await read('dist/manifest.json')).toBe(manifest);
});

test('build refuses normative drift even when SDL remains valid', async () => {
  await write(schemaFile, `${await read(schemaFile)}\n# altered normative file\n`);
  expect(run('validate-schema').status).toBe(0);
  expect(run('build').status).toBe(1);
  expect(await read('artifacts/build.log')).toContain('Normative file changed');
  await expect(access(join(fixture, 'dist'))).rejects.toThrow();
});

for (const file of [schemaFile, registryFile]) {
  test(`build fails and logs when ${file} is missing`, async () => {
    await rm(join(fixture, file));
    expect(run('build').status).toBe(1);
    expect(await read('artifacts/build.log')).toContain('[build] FAIL');
    await expect(access(join(fixture, 'dist'))).rejects.toThrow();
  });
}

test('audit inventories real files and passes only F0, without gate promotion', async () => {
  const result = run('audit-f0');
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const data = await report();
  expect(data.status).toBe('PASS');
  expect(data.release_decision).toBe('NO_GO');
  expect(data.gates).toHaveLength(14);
  expect(data.gates.every((gate) => gate.status === 'NOT_VERIFIED' && gate.evidence === '')).toBe(true);
  expect(data.inventories.root.some((entry) => entry.name === schemaFile)).toBe(true);
  expect(data.inventories.scripts.filter((entry) => entry.executable)).toHaveLength(4);
  expect(data.checks.every((check) => check.status === 'PASS')).toBe(true);
  expect(data.scope_limits.join(' ')).toContain('Append-only');
  expect(await read('artifacts/audit-f0.log')).toBe(result.stdout);
  expect(sha256(await read(registryFile))).toBe(normativeHashes[registryFile]);
});

for (const [name, mutate] of [
  ['duplicate ID', (r) => { r.gates[1].id = r.gates[0].id; }],
  ['missing ID', (r) => { r.gates.pop(); }],
  ['extra ID', (r) => { r.gates.push({ id: 'EXTRA', status: 'NOT_VERIFIED', evidence: '' }); }],
  ['promoted gate', (r) => { r.gates[0].status = 'PASS'; }],
  ['invented evidence', (r) => { r.gates[0].evidence = 'unsupported'; }],
  ['GO release', (r) => { r.release_decision = 'GO'; }],
]) {
  test(`audit rejects registry ${name}, writes failure report and retains NO_GO`, async () => {
    const registry = JSON.parse(await read(registryFile));
    mutate(registry);
    await write(registryFile, JSON.stringify(registry));
    expect(run('audit-f0').status).toBe(1);
    await failCheck('registry.baseline');
    expect((await report()).status).toBe('FAIL');
    expect((await report()).release_decision).toBe('NO_GO');
  });
}

for (const file of [schemaFile, registryFile, 'docs/F0-spec.md', 'package.json', 'package-lock.json', 'playwright.config.mjs', 'scripts/build.mjs', 'scripts/dev.mjs', 'scripts/validate-schema.mjs', 'tests/f0.spec.mjs']) {
  test(`audit still writes report when required file ${file} is missing`, async () => {
    await rm(join(fixture, file));
    expect(run('audit-f0').status).toBe(1);
    await failCheck(`file:${file}`);
    expect((await report()).release_decision).toBe('NO_GO');
    expect(await read('artifacts/audit-f0.log')).toContain('[audit-f0] FAIL');
  });
}

test('audit reports invalid SDL and malformed registry independently', async () => {
  await write(schemaFile, 'broken schema');
  await write(registryFile, 'broken json');
  expect(run('audit-f0').status).toBe(1);
  await failCheck('schema.validity-and-f0-structure');
  await failCheck('registry.baseline');
  await failCheck(`normative:${schemaFile}`);
});

test('audit checks engines, mappings, permissions and placeholders explicitly', async () => {
  const pkg = JSON.parse(await read('package.json'));
  pkg.engines.node = '>=18';
  pkg.engines.npm = '>=9';
  pkg.scripts.build = 'echo success';
  await write('package.json', JSON.stringify(pkg));
  await chmod(join(fixture, 'scripts/build.mjs'), 0o644);
  await write('scripts/dev.mjs', `${await read('scripts/dev.mjs')}\n// TODO implement server\n`);
  expect(run('audit-f0').status).toBe(1);
  for (const id of ['engines.declared', 'scripts.mappings', 'executable:build', 'scripts.no-placeholders']) await failCheck(id);
});

test('audit checks actual npm runtime instead of trusting package declarations', async () => {
  const bin = join(fixture, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'npm'), '#!/bin/sh\nprintf "10.0.0\\n"\n', { mode: 0o755 });
  expect(run('audit-f0', { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).status).toBe(1);
  await failCheck('engines.runtime.npm');
});

test('audit records missing npm runtime and still writes the report', async () => {
  const bin = join(fixture, 'empty-bin');
  await mkdir(bin);
  expect(run('audit-f0', { env: { ...process.env, PATH: bin } }).status).toBe(1);
  await failCheck('engines.runtime.npm');
  expect((await report()).release_decision).toBe('NO_GO');
});

function rawRequest(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function startDev() {
  const child = spawn(process.execPath, [join(fixture, 'scripts/dev.mjs')], {
    cwd: join(fixture, 'docs'), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await expect.poll(() => output.match(/LISTENING http:\/\/127\.0\.0\.1:(\d+)/)?.[1], { timeout: 10_000 }).toBeTruthy();
  return { child, port: Number(output.match(/LISTENING http:\/\/127\.0\.0\.1:(\d+)/)[1]) };
}

test('dev binds loopback and serves only fixed resources, including HEAD and method policy', async () => {
  const { port, child } = await startDev();
  for (const [path, file] of [['/contract.graphql', schemaFile], ['/gate-registry.json', registryFile]]) {
    const response = await rawRequest(port, path);
    expect(response.status).toBe(200);
    expect(response.body).toBe(await read(file));
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect((await rawRequest(port, path, 'HEAD')).body).toBe('');
  }
  expect(JSON.parse((await rawRequest(port, '/health')).body).status).toBe('ok');
  expect(JSON.parse((await rawRequest(port, '/')).body).release_decision).toBe('NO_GO');
  const method = await rawRequest(port, '/contract.graphql', 'POST');
  expect(method.status).toBe(405);
  expect(method.headers.allow).toBe('GET, HEAD');
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  expect((await closed)[0]).toBe(0);
  servers.delete(child);
  expect(await read('artifacts/dev.log')).toContain('[dev] PASS');
});

test('dev rejects raw and encoded traversal, queries, arbitrary files and GraphQL execution', async () => {
  const { port } = await startDev();
  for (const path of [
    '/../package.json', '/%2e%2e/package.json', '/contract.graphql/../package.json',
    '/%2e%2e/contract.graphql', '//contract.graphql', '/%2fcontract.graphql',
    '/contract.graphql?file=package.json', '/package.json', '/.git/config',
    '/scripts/dev.mjs', '/graphql', '/contract.graphql%00', '/..\\package.json',
  ]) expect((await rawRequest(port, path)).status, path).toBe(404);
});

test('dev logs occupied-port failure and leaves the original server responsive', async () => {
  const { port } = await startDev();
  const result = run('dev', { env: { ...process.env, PORT: String(port) } });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('EADDRINUSE');
  expect(await read('artifacts/dev.log')).toContain('[dev] FAIL');
  expect((await rawRequest(port, '/health')).status).toBe(200);
});

for (const port of ['-1', '65536', 'abc', '1.5', '']) {
  test(`dev logs invalid port ${JSON.stringify(port)} and fails`, async () => {
    expect(run('dev', { env: { ...process.env, PORT: port } }).status).toBe(1);
    expect(await read('artifacts/dev.log')).toContain('PORT must be an integer');
  });
}

test('dev logs schema failure and does not start', async () => {
  await write(schemaFile, 'invalid');
  expect(run('dev', { env: { ...process.env, PORT: '0' } }).status).toBe(1);
  const log = await read('artifacts/dev.log');
  expect(log).toContain('[dev] FAIL');
  expect(log).not.toContain('LISTENING');
});

test('dev logs missing registry failure and does not start', async () => {
  await rm(join(fixture, registryFile));
  expect(run('dev', { env: { ...process.env, PORT: '0' } }).status).toBe(1);
  const log = await read('artifacts/dev.log');
  expect(log).toContain('[dev] FAIL');
  expect(log).not.toContain('LISTENING');
});
