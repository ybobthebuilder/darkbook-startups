import { buildSchema, validateSchema, isInterfaceType, isObjectType } from 'graphql';
import { limits, read, schemaFile } from './lib.mjs';

const requiredFields = {
  entityId: 'ID!', revisionId: 'ID!', schemaVersion: 'String!',
  previousRevisionId: 'ID', forkedFromRevisionId: 'ID', branchId: 'ID!',
  createdAt: 'DateTime!', scope: 'Scope!', provenance: 'Provenance!',
  validation: 'Validation!', lifecycle: 'LifecycleState!',
};
const implementations = ['Project', 'WorldScenario', 'Question', 'Answer', 'Claim', 'Evidence', 'Decision'];
const destructive = /delete|remove|erase|purge|drop|destroy|truncate|overwrite|replace|update|patch|mutate|modify|edit|clear|reset|upsert/i;
const genericChange = /change|delta|diff|patch|update|modification/i;

export function validateContract(source = read(schemaFile)) {
  const schema = buildSchema(source);
  const errors = validateSchema(schema).map((error) => error.message);
  const node = schema.getType('RevisionedNode');
  if (!isInterfaceType(node)) errors.push('RevisionedNode must be an interface');
  else {
    const fields = node.getFields();
    for (const [name, type] of Object.entries(requiredFields)) {
      if (String(fields[name]?.type) !== type) errors.push(`RevisionedNode.${name} must be ${type}`);
    }
    if (!fields.entityId || !fields.revisionId || fields.entityId === fields.revisionId) {
      errors.push('entityId and revisionId require distinct field definitions (not runtime inequality)');
    }
    for (const name of implementations) {
      const type = schema.getType(name);
      if (!isObjectType(type) || !type.getInterfaces().includes(node)) {
        errors.push(`${name} must implement RevisionedNode`);
      }
    }
  }
  const mutation = schema.getMutationType();
  if (!mutation) errors.push('Mutation root is required');
  for (const field of Object.values(mutation?.getFields() ?? {})) {
    if (destructive.test(field.name)) errors.push(`Destructive mutation forbidden: ${field.name}`);
  }
  // Inspect the parsed schema, including nested input fields and argument names,
  // rather than comments or SDL formatting. Conservative substring matching is intentional.
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__') || typeof type.getFields !== 'function') continue;
    for (const field of Object.values(type.getFields())) {
      if (genericChange.test(field.name)) errors.push(`Generic change field forbidden: ${type.name}.${field.name}`);
      for (const argument of field.args ?? []) {
        if (genericChange.test(argument.name)) errors.push(`Generic change argument forbidden: ${type.name}.${field.name}(${argument.name})`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return schema;
}

export function validateAndLog(log) {
  const schema = validateContract();
  log(`Schema válido: buildSchema + validateSchema; ${schema.getPossibleTypes(schema.getType('RevisionedNode')).length} implementações.`);
  for (const limit of limits) log(`LIMITE: ${limit}`);
  return schema;
}
