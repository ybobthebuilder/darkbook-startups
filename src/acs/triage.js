import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { metrics } from '@opentelemetry/api';

export const TRIAGE_LEVELS = Object.freeze(['low', 'medium', 'high']);

const promptTemplate = readFileSync(new URL('../../prompts/triage.txt', import.meta.url), 'utf8');
const CPF_PATTERN = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const SELF_IDENTIFICATION_PATTERN =
  /((?:meu nome (?:é|e)|nome\s*[:=]|sou (?:o|a))\s+)([\p{L}][\p{L}'-]*(?:\s+(?!e\b|estou\b|tenho\b|sinto\b|com\b|relato\b)[\p{L}][\p{L}'-]*){0,3})/giu;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeSymptoms(symptoms, { patientName } = {}) {
  if (typeof symptoms !== 'string' || symptoms.trim().length === 0) {
    throw new TypeError('Symptoms must be a non-empty string');
  }

  let sanitized = symptoms
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(CPF_PATTERN, '[REDACTED]')
    .replace(SELF_IDENTIFICATION_PATTERN, '$1[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);

  if (typeof patientName === 'string' && patientName.trim()) {
    const namePattern = new RegExp(escapeRegExp(patientName.trim()), 'giu');
    sanitized = sanitized.replace(namePattern, '[REDACTED]');
  }
  return sanitized;
}

function validateAge(age) {
  if (!Number.isInteger(age) || age < 0 || age > 130) {
    throw new RangeError('Age must be an integer between 0 and 130');
  }
}

function writeJsonLog(logger, event) {
  logger.info(JSON.stringify(event));
}

export class TriageRepository {
  constructor(database) {
    if (!database || typeof database.query !== 'function') {
      throw new TypeError('A relational database query client is required');
    }
    this.database = database;
  }

  async initialize() {
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS acs_triage (
        triage_id UUID PRIMARY KEY,
        ai_suggestion TEXT,
        acs_decision TEXT,
        ai_status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        decided_at TIMESTAMPTZ
      )
    `);
  }

  async createSuggestion({ triageId, aiSuggestion, aiStatus }) {
    await this.database.query(
      `INSERT INTO acs_triage (triage_id, ai_suggestion, ai_status)
       VALUES ($1, $2, $3)`,
      [triageId, aiSuggestion, aiStatus],
    );
  }

  async recordDecision({ triageId, acsDecision }) {
    const result = await this.database.query(
      `UPDATE acs_triage
       SET acs_decision = $2, decided_at = CURRENT_TIMESTAMP
       WHERE triage_id = $1
       RETURNING ai_suggestion`,
      [triageId, acsDecision],
    );
    if (result.rowCount !== 1) {
      throw new Error('Triage record was not found');
    }
    return result.rows[0].ai_suggestion;
  }
}

export class AcsTriageService {
  constructor({
    endpoint,
    apiKey,
    model,
    repository,
    fetchImpl = globalThis.fetch,
    logger = console,
    meter = metrics.getMeter('acs-triage'),
  }) {
    if (!endpoint || !model || typeof fetchImpl !== 'function') {
      throw new TypeError('An AI endpoint, model, and fetch implementation are required');
    }
    if (!repository || typeof repository.createSuggestion !== 'function' ||
        typeof repository.recordDecision !== 'function') {
      throw new TypeError('A triage repository is required');
    }
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.model = model;
    this.repository = repository;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.requestDuration = meter.createHistogram('acs.ai.request.duration', {
      unit: 'ms',
      description: 'Duration of AI triage requests',
    });
    this.requestErrors = meter.createCounter('acs.ai.request.errors', {
      description: 'Failed AI triage requests, including invalid output',
    });
  }

  async suggest({ symptoms, age, patientName } = {}) {
    validateAge(age);
    const safeSymptoms = sanitizeSymptoms(symptoms, { patientName });
    const triageId = randomUUID();
    const startedAt = performance.now();
    let aiSuggestion = null;
    let aiStatus = 'ok';
    let failureReason;

    try {
      const prompt = promptTemplate
        .replace('{{AGE}}', String(age))
        .replace('{{SYMPTOMS}}', safeSymptoms);
      const headers = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = 'Bearer ' + this.apiKey;
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) throw new Error('api_error');
      const payload = await response.json();
      const output = payload?.choices?.[0]?.message?.content;
      if (typeof output !== 'string' || !TRIAGE_LEVELS.includes(output)) {
        failureReason = 'invalid_output';
        throw new Error(failureReason);
      }
      aiSuggestion = output;
    } catch (error) {
      aiStatus = 'manual';
      failureReason = failureReason ?? (
        error instanceof Error && error.message === 'api_error' ? 'api_error' : 'request_error'
      );
      this.requestErrors.add(1, { reason: failureReason });
    } finally {
      this.requestDuration.record(performance.now() - startedAt);
    }

    await this.repository.createSuggestion({ triageId, aiSuggestion, aiStatus });
    writeJsonLog(this.logger, {
      event: 'acs.triage.suggestion',
      triage_id: triageId,
      ai_suggestion: aiSuggestion,
      acs_decision: null,
      ai_status: aiStatus,
      ...(failureReason ? { failure_reason: failureReason } : {}),
    });

    return {
      triageId,
      aiSuggestion,
      aiStatus,
      requiresManualDecision: aiStatus !== 'ok',
    };
  }

  async recordAcsDecision({ triageId, acsDecision } = {}) {
    if (!triageId || !TRIAGE_LEVELS.includes(acsDecision)) {
      throw new TypeError('A valid triage ID and ACS decision are required');
    }
    const aiSuggestion = await this.repository.recordDecision({ triageId, acsDecision });
    writeJsonLog(this.logger, {
      event: 'acs.triage.decision',
      triage_id: triageId,
      ai_suggestion: aiSuggestion ?? null,
      acs_decision: acsDecision,
    });
  }
}
