import fs from 'node:fs';

const path = 'darwin_semantic_contract_v2.graphql';
if (!fs.existsSync(path)) {
  console.log('FAIL: arquivo do contrato não encontrado');
  process.exit(1);
}
const text = fs.readFileSync(path, 'utf8');
const checks = [
  ['entityId', text.includes('entityId: ID!')],
  ['revisionId', text.includes('revisionId: ID!')],
  ['branchId', text.includes('branchId: ID!')],
  ['sem campo proibido 1', !text.includes('updatedAt')],
  ['sem campo proibido 2', !text.includes('changes:')],
  ['tem Mutation', text.includes('type Mutation')],
  ['tem Query', text.includes('type Query')],
  ['tem IsolationReason', text.includes('IsolationReason')],
  ['tem ScopeKind', text.includes('ScopeKind')],
  ['tem idempotencyKey', text.includes('idempotencyKey')],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  if (!pass) ok = false;
}
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/validate-schema.log', checks.map(([n,p]) => `${p?'PASS':'FAIL'} ${n}`).join('\n'));
process.exit(ok ? 0 : 1);
