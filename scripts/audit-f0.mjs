import fs from 'node:fs';

const required = [
  'darwin_semantic_contract_v2.graphql',
  'sergiotavio_darwin_gate_registry_v2_1_1.json',
  'sergiotavio_darwin_acceptance_gates_v2_1_1.md',
  'docs/F0-spec.md',
  'scripts/validate-schema.mjs',
  'scripts/audit-f0.mjs',
  'scripts/dev.mjs',
  'scripts/build.mjs',
  'package.json'
];
const missing = required.filter(f => !fs.existsSync(f));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const scriptsOk = Boolean(pkg.scripts?.['validate:schema'] && pkg.scripts?.['audit:f0'] && pkg.scripts?.dev && pkg.scripts?.build);

console.log(`F0 audit — faltando: ${missing.length ? missing.join(', ') : 'nenhum'}`);
console.log(`F0 audit — scripts ok: ${scriptsOk ? 'sim' : 'não'}`);
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/audit-f0-report.json', JSON.stringify({ missing, scriptsOk, status: missing.length === 0 && scriptsOk ? 'PASS' : 'FAIL' }, null, 2));
process.exit(missing.length === 0 && scriptsOk ? 0 : 1);
