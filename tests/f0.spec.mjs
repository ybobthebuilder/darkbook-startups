import { test, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { root, schemaFile, registryFile, normativeHashes, sha256 } from '../scripts/lib.mjs';

const fixtures = join(root, 'test-results', 'f0-fixtures');
let fixture;
const servers = new Set();
const mirrorFile = 'sergiotavio_darwin_acceptance_gates_v2_1_1.md';
const read = (file) => readFile(join(fixture, file), 'utf8');
const write = (file, value) => writeFile(join(fixture, file), value);
const run = (name, options = {}) => spawnSync(process.execPath, [join(fixture, 'scripts', `${name}.mjs`)], {
  cwd: fixture, encoding: 'utf8', timeout: 20_000, ...options,
});
const report = async () => JSON.parse(await read('artifacts/audit-f0-report.json'));

test.beforeEach(async () => {
  await mkdir(fixtures, { recursive: true });
  fixture = await mkdtemp(join(fixtures, 'case-'));
  for (const file of ['package.json', 'package-lock.json', 'playwright.config.mjs', schemaFile, registryFile, mirrorFile]) {
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

test('literal validator passes lexical checks and writes only check lines', async () => {
  const result = run('validate-schema');
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toBe('PASS entityId\nPASS revisionId\nPASS branchId\nPASS sem campo proibido 1\nPASS sem campo proibido 2\nPASS tem Mutation\nPASS tem Query\nPASS tem IsolationReason\nPASS tem ScopeKind\nPASS tem idempotencyKey\n');
  expect(await read('artifacts/validate-schema.log')).toBe(result.stdout.trimEnd());
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
  test(`build and dev strong validation reject ${name}`, async () => {
    await write(schemaFile, transform(await read(schemaFile)));
    for (const command of ['build', 'dev']) {
      const result = run(command, { env: { ...process.env, PORT: '0' } });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).toContain(`[${command}] FAIL`);
      expect(result.stdout).not.toContain('LISTENING');
      expect(await read(`artifacts/${command}.log`)).toBe(result.stdout);
    }
  });
}

for (const [field, check] of [['updatedAt', 'sem campo proibido 1'], ['changes:', 'sem campo proibido 2']]) {
  test(`literal validator rejects ${field} even in comments`, async () => {
    await write(schemaFile, `${await read(schemaFile)}\n# ${field}\n`);
    const result = run('validate-schema');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`FAIL ${check}\n`);
    expect(await read('artifacts/validate-schema.log')).toBe(result.stdout.trimEnd());
  });
}

test('validator missing contract prints exact failure without creating a log', async () => {
  await rm(join(fixture, schemaFile));
  const result = run('validate-schema');
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('FAIL: arquivo do contrato não encontrado\n');
  await expect(access(join(fixture, 'artifacts/validate-schema.log'))).rejects.toThrow();
});

test('missing contract leaves a previous validator log unchanged', async () => {
  expect(run('validate-schema').status).toBe(0);
  const previous = await read('artifacts/validate-schema.log');
  await rm(join(fixture, schemaFile));
  expect(run('validate-schema').status).toBe(1);
  expect(await read('artifacts/validate-schema.log')).toBe(previous);
});

test('literal validator is cwd-dependent', async () => {
  const result = run('validate-schema', { cwd: join(fixture, 'docs') });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('FAIL: arquivo do contrato não encontrado\n');
});

test('strong validation ignores comments but lexical validation does not', async () => {
  await write(schemaFile, `${await read(schemaFile)}\n# deleteHistory(changes: JSON) is prohibited\n`);
  expect(run('validate-schema').status).toBe(1);
  const result = run('build');
  expect(result.stdout).toContain('7 implementações');
  expect(result.stdout).toContain('Normative file changed');
});

test('lexical validation accepts invalid SDL when all tokens remain', async () => {
  await write(schemaFile, `${await read(schemaFile)}\ntype Broken {`);
  expect(run('validate-schema').status).toBe(0);
  expect(run('build').stdout).toContain('Syntax Error');
});

test('build emits real deterministic bundle, hashes and literal log without modifying sources', async () => {
  const first = run('build', { cwd: join(fixture, 'docs') });
  expect(first.status, first.stdout + first.stderr).toBe(0);
  expect(first.stdout).toContain('7 implementações');
  expect(first.stdout).toContain('não prova desigualdade');
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

test('audit checks existence and script presence without promoting gates or generating a log', async () => {
  const result = run('audit-f0');
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toBe('F0 audit — faltando: nenhum\nF0 audit — scripts ok: sim\n');
  expect(await report()).toEqual({ missing: [], scriptsOk: true, status: 'PASS' });
  expect(await read('artifacts/audit-f0-report.json')).toBe(JSON.stringify(await report(), null, 2));
  await expect(access(join(fixture, 'artifacts/audit-f0.log'))).rejects.toThrow();
  expect(sha256(await read(registryFile))).toBe(normativeHashes[registryFile]);
  const registry = JSON.parse(await read(registryFile));
  expect(registry.release_decision).toBe('NO_GO');
  expect(registry.gates).toHaveLength(14);
  expect(registry.gates.every((gate) => gate.status === 'NOT_VERIFIED' && gate.evidence === '')).toBe(true);
});

test('documented mirror faithfully transcribes every registry field and gate', async () => {
  const registry = JSON.parse(await read(registryFile));
  const mirror = await read(mirrorFile);
  for (const [key, value] of Object.entries(registry).filter(([key]) => !['rules', 'gates'].includes(key))) {
    expect(mirror).toContain(`- ${key}: \`${value}\``);
  }
  for (const rule of registry.rules) expect(mirror).toContain(`- ${rule}`);
  const rows = mirror.split('\n').filter((line) => /^\| (G\d|SEC-)/.test(line));
  expect(rows).toEqual(registry.gates.map((gate) => `| ${gate.id} | ${gate.title} | ${gate.status} |${gate.evidence ? ` ${gate.evidence} ` : ' '}|`));
});

for (const file of [schemaFile, registryFile, mirrorFile, 'docs/F0-spec.md', 'scripts/build.mjs', 'scripts/dev.mjs', 'scripts/validate-schema.mjs']) {
  test(`audit reports missing required path ${file}`, async () => {
    await rm(join(fixture, file));
    const result = run('audit-f0');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`F0 audit — faltando: ${file}\nF0 audit — scripts ok: sim\n`);
    expect(await report()).toEqual({ missing: [file], scriptsOk: true, status: 'FAIL' });
  });
}

test('audit does not validate schema or registry content', async () => {
  await write(schemaFile, 'broken schema');
  await write(registryFile, 'broken json');
  expect(run('audit-f0').status).toBe(0);
  expect(await report()).toEqual({ missing: [], scriptsOk: true, status: 'PASS' });
});

test('audit accepts any truthy script mapping rather than checking command semantics', async () => {
  const pkg = JSON.parse(await read('package.json'));
  pkg.scripts.build = 'echo success';
  await write('package.json', JSON.stringify(pkg));
  expect(run('audit-f0').status).toBe(0);
  expect((await report()).scriptsOk).toBe(true);
});

for (const mapping of ['validate:schema', 'audit:f0', 'dev', 'build']) {
  test(`audit fails when script mapping ${mapping} is missing`, async () => {
    const pkg = JSON.parse(await read('package.json'));
    delete pkg.scripts[mapping];
    await write('package.json', JSON.stringify(pkg));
    const result = run('audit-f0');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('F0 audit — faltando: nenhum\nF0 audit — scripts ok: não\n');
    expect(await report()).toEqual({ missing: [], scriptsOk: false, status: 'FAIL' });
  });
}

for (const condition of ['missing', 'invalid']) {
  test(`audit ${condition} package.json throws before writing a report`, async () => {
    if (condition === 'missing') await rm(join(fixture, 'package.json'));
    else await write('package.json', 'invalid JSON');
    expect(run('audit-f0').status).toBe(1);
    await expect(access(join(fixture, 'artifacts/audit-f0-report.json'))).rejects.toThrow();
  });
}

test('audit depends on cwd and cannot find package.json from docs', async () => {
  expect(run('audit-f0', { cwd: join(fixture, 'docs') }).status).toBe(1);
  await expect(access(join(fixture, 'docs/artifacts/audit-f0-report.json'))).rejects.toThrow();
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
