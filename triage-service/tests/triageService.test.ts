import assert from 'node:assert/strict';
import test from 'node:test';
import type { Meter } from '@opentelemetry/api';
import {
  TriageRepository,
  TriageService,
  type DatabaseResult,
  type RelationalDatabase,
} from '../src/services/triageService.js';
import type { StructuredLogger } from '../src/telemetry/logger.js';
import { sanitizeSymptoms } from '../src/utils/piiMasker.js';

function createMetrics() {
  const measurements = { durations: [] as number[], errors: [] as Array<{ value: number; attributes: unknown }> };
  const meter = {
    createHistogram: () => ({ record: (value: number) => measurements.durations.push(value) }),
    createCounter: () => ({
      add: (value: number, attributes: unknown) => measurements.errors.push({ value, attributes }),
    }),
  } as unknown as Meter;
  return { meter, measurements };
}

function createDatabase(): RelationalDatabase & {
  rows: Map<string, { ai_suggestion: string | null; ai_status: string; acs_decision: string | null }>;
} {
  const rows = new Map<string, {
    ai_suggestion: string | null;
    ai_status: string;
    acs_decision: string | null;
  }>();
  return {
    rows,
    async query(sql: string, values: unknown[] = []): Promise<DatabaseResult> {
      if (sql.includes('INSERT INTO acs_triage')) {
        rows.set(values[0] as string, {
          ai_suggestion: values[1] as string | null,
          ai_status: values[2] as string,
          acs_decision: null,
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('UPDATE acs_triage')) {
        const row = rows.get(values[0] as string);
        if (!row) return { rowCount: 0, rows: [] };
        row.acs_decision = values[1] as string;
        return { rowCount: 1, rows: [{ ai_suggestion: row.ai_suggestion }] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

function createLogger(): StructuredLogger & { entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    info: (event) => entries.push(event),
  };
}

test('masks PII from the AI prompt and records the ACS override', async () => {
  const database = createDatabase();
  const repository = new TriageRepository(database);
  const metrics = createMetrics();
  const logger = createLogger();
  let request: { url: string; options: RequestInit } | undefined;
  const service = new TriageService({
    endpoint: 'https://ai.example.test/v1/chat/completions',
    apiKey: 'test-key',
    model: 'test-model',
    repository,
    meter: metrics.meter,
    logger,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options: options ?? {} };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'medium' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const result = await service.suggest({
    age: 42,
    symptoms: 'Meu nome é Ana Silva, CPF 123.456.789-09; relata tosse.',
    patientName: 'Ana Silva',
  });
  await service.recordAcsDecision({ triageId: result.triageId, acsDecision: 'high' });

  assert.ok(request);
  const requestOptions = request.options;
  const sentBody = JSON.parse(String(requestOptions.body));
  const prompt = sentBody.messages[0].content as string;
  assert.equal(request.url, 'https://ai.example.test/v1/chat/completions');
  assert.equal((requestOptions.headers as Record<string, string>).authorization, 'Bearer ' + 'test-key');
  assert.match(prompt, /Age: 42/);
  assert.match(prompt, /\[REDACTED\]/);
  assert.doesNotMatch(prompt, /Ana Silva|123\.456\.789-09/);
  assert.deepEqual(Object.keys(sentBody), ['model', 'messages']);
  assert.equal(result.aiSuggestion, 'medium');
  assert.equal(result.requiresManualDecision, false);
  assert.equal(database.rows.get(result.triageId)?.ai_suggestion, 'medium');
  assert.equal(database.rows.get(result.triageId)?.acs_decision, 'high');
  assert.deepEqual(
    logger.entries.map((entry) => [entry.ai_suggestion, entry.acs_decision]),
    [['medium', null], ['medium', 'high']],
  );
  assert.doesNotMatch(JSON.stringify(logger.entries), /Ana Silva|123\.456\.789-09/);
  assert.equal(metrics.measurements.durations.length, 1);
  assert.equal(metrics.measurements.errors.length, 0);
});

test('routes invalid AI output to manual decision and records the error metric', async () => {
  const database = createDatabase();
  const metrics = createMetrics();
  const service = new TriageService({
    endpoint: 'https://ai.example.test/v1/chat/completions',
    model: 'test-model',
    repository: new TriageRepository(database),
    meter: metrics.meter,
    logger: createLogger(),
    fetchImpl: async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'medium\n' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });

  const result = await service.suggest({ age: 30, symptoms: 'Headache' });

  assert.equal(result.aiSuggestion, null);
  assert.equal(result.aiStatus, 'manual');
  assert.equal(result.requiresManualDecision, true);
  assert.equal(database.rows.get(result.triageId)?.ai_suggestion, null);
  assert.deepEqual(metrics.measurements.errors, [
    { value: 1, attributes: { reason: 'invalid_output' } },
  ]);
  assert.equal(metrics.measurements.durations.length, 1);
});

test('masks identified names and rejects invalid input and decisions', async () => {
  assert.equal(
    sanitizeSymptoms('Meu nome é João Pedro e estou com febre.', 'João Pedro'),
    'Meu nome é [REDACTED] e estou com febre.',
  );

  const service = new TriageService({
    endpoint: 'https://ai.example.test/v1/chat/completions',
    model: 'test-model',
    repository: new TriageRepository(createDatabase()),
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });

  await assert.rejects(service.suggest({ age: 131, symptoms: 'Headache' }), RangeError);
  await assert.rejects(
    service.recordAcsDecision({ triageId: 'not-a-uuid', acsDecision: 'critical' as never }),
    TypeError,
  );
});
