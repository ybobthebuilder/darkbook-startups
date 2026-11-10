import assert from 'node:assert/strict';
import test from 'node:test';
import { AcsTriageService, TriageRepository, sanitizeSymptoms } from '../src/acs/triage.js';

function createMetrics() {
  const measurements = { durations: [], errors: [] };
  return {
    measurements,
    createHistogram: () => ({ record: (value) => measurements.durations.push(value) }),
    createCounter: () => ({ add: (value, attributes) => measurements.errors.push({ value, attributes }) }),
  };
}

function createDatabase() {
  const rows = new Map();
  return {
    rows,
    async query(sql, values = []) {
      if (sql.includes('INSERT INTO acs_triage')) {
        rows.set(values[0], {
          triage_id: values[0],
          ai_suggestion: values[1],
          ai_status: values[2],
          acs_decision: null,
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE acs_triage')) {
        const row = rows.get(values[0]);
        if (!row) return { rowCount: 0, rows: [] };
        row.acs_decision = values[1];
        return { rowCount: 1, rows: [{ ai_suggestion: row.ai_suggestion }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

function createLogger() {
  const entries = [];
  return { entries, info: (entry) => entries.push(JSON.parse(entry)) };
}

test('sanitizes CPF and patient name before forming an AI request, then records the ACS override', async () => {
  const database = createDatabase();
  const repository = new TriageRepository(database);
  const metrics = createMetrics();
  const logger = createLogger();
  let request;
  const service = new AcsTriageService({
    endpoint: 'https://ai.example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    repository,
    meter: metrics,
    logger,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'medium' } }] }) };
    },
  });

  const result = await service.suggest({
    age: 42,
    symptoms: 'Meu nome é Ana Silva, CPF 123.456.789-09; relata tosse.',
    patientName: 'Ana Silva',
    patientCpf: '123.456.789-09',
  });
  await service.recordAcsDecision({ triageId: result.triageId, acsDecision: 'high' });

  const sentBody = JSON.parse(request.options.body);
  const prompt = sentBody.messages[0].content;
  assert.equal(request.url, 'https://ai.example.test/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer ' + 'test-key');
  assert.match(prompt, /Age: 42/);
  assert.match(prompt, /\[REDACTED\]/);
  assert.doesNotMatch(prompt, /Ana Silva|123\.456\.789-09/);
  assert.deepEqual(Object.keys(sentBody), ['model', 'messages']);
  assert.equal(result.aiSuggestion, 'medium');
  assert.equal(result.requiresManualDecision, false);
  assert.equal(database.rows.get(result.triageId).ai_suggestion, 'medium');
  assert.equal(database.rows.get(result.triageId).acs_decision, 'high');
  assert.deepEqual(
    logger.entries.filter((entry) => entry.event.startsWith('acs.triage.')).map((entry) => [
      entry.ai_suggestion,
      entry.acs_decision,
    ]),
    [['medium', null], ['medium', 'high']],
  );
  assert.equal(metrics.measurements.durations.length, 1);
  assert.equal(metrics.measurements.errors.length, 0);
});

test('routes invalid AI output to manual decision and records the error metric', async () => {
  const database = createDatabase();
  const metrics = createMetrics();
  const service = new AcsTriageService({
    endpoint: 'https://ai.example.test/v1/chat/completions',
    model: 'test-model',
    repository: new TriageRepository(database),
    meter: metrics,
    logger: createLogger(),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'medium\n' } }] }),
    }),
  });

  const result = await service.suggest({ age: 30, symptoms: 'Headache' });

  assert.equal(result.aiSuggestion, null);
  assert.equal(result.aiStatus, 'manual');
  assert.equal(result.requiresManualDecision, true);
  assert.equal(database.rows.get(result.triageId).ai_suggestion, null);
  assert.deepEqual(metrics.measurements.errors, [
    { value: 1, attributes: { reason: 'invalid_output' } },
  ]);
  assert.equal(metrics.measurements.durations.length, 1);
});

test('masks explicit identifying phrases and rejects invalid ages and decisions', async () => {
  assert.equal(
    sanitizeSymptoms('Meu nome é João Pedro e estou com febre.', { patientName: 'João Pedro' }),
    'Meu nome é [REDACTED] e estou com febre.',
  );

  const service = new AcsTriageService({
    endpoint: 'https://ai.example.test/v1/chat/completions',
    model: 'test-model',
    repository: new TriageRepository(createDatabase()),
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });

  await assert.rejects(service.suggest({ age: 131, symptoms: 'Headache' }), RangeError);
  await assert.rejects(
    service.recordAcsDecision({ triageId: 'not-a-uuid', acsDecision: 'critical' }),
    TypeError,
  );
});
