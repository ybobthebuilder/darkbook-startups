import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const schemaFile = 'darwin_semantic_contract_v2.graphql';
export const registryFile = 'sergiotavio_darwin_gate_registry_v2_1_1.json';
export const gateIds = [
  'G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07', 'G08', 'G09',
  'G10a', 'G10b', 'SEC-RULES', 'SEC-SCOPE', 'SEC-SCOPE2',
];
export const normativeHashes = {
  [schemaFile]: '057150d790fdf7c2a24f595c9102422651767c0e0209a1c03ae41e792497d027',
  [registryFile]: 'ef63a225f119c508b0a5dd9843b1338a82ff2c6bdfdbaeede49972398e85e1cc',
};
export const limits = [
  'O SDL declara campos entityId e revisionId distintos, mas não prova desigualdade dos valores em execução.',
  'Append-only, autorização, persistência, isolamentos e os gates técnicos não são comprovados por esta auditoria F0.',
];
export const read = (file) => readFileSync(join(root, file), 'utf8');
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const isMain = (url) => process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url);

export async function execute(name, action) {
  mkdirSync(join(root, 'artifacts'), { recursive: true });
  const file = join(root, 'artifacts', `${name}.log`);
  // Append sessions: simultaneous commands must not erase each other's evidence.
  const log = (message) => {
    const line = String(message);
    appendFileSync(file, `${line}\n`);
    console.log(line);
  };
  log(`[${name}] START ${new Date().toISOString()} node=${process.version}`);
  try {
    await action(log);
    log(`[${name}] PASS`);
  } catch (error) {
    log(`[${name}] FAIL: ${error.stack ?? error}`);
    process.exitCode = 1;
  }
}
