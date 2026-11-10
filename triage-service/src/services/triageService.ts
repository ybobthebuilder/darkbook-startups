import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { metrics, type Counter, type Histogram, type Meter } from '@opentelemetry/api';
import { JsonLogger, type StructuredLogger } from '../telemetry/logger.js';
import { sanitizeSymptoms } from '../utils/piiMasker.js';

export const TRIAGE_LEVELS = ['low', 'medium', 'high'] as const;
export type TriageLevel = (typeof TRIAGE_LEVELS)[number];
export type AiStatus = 'ok' | 'manual';

export interface DatabaseResult {
  rowCount: number;
  rows: Array<{ ai_suggestion: string | null }>;
}

export interface RelationalDatabase {
  query(sql: string, values?: unknown[]): Promise<DatabaseResult>;
}

export interface TriageRepositoryPort {
  createSuggestion(input: {
    triageId: string;
    aiSuggestion: TriageLevel | null;
    aiStatus: AiStatus;
  }): Promise<void>;
  recordDecision(input: { triageId: string; acsDecision: TriageLevel }): Promise<string | null>;
}

export interface TriageServiceOptions {
  endpoint: string;
  model: string;
  repository: TriageRepositoryPort;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  logger?: StructuredLogger;
  meter?: Meter;
}

export interface SuggestionInput {
  symptoms: string;
  age: number;
  patientName?: string;
}

export interface SuggestionResult {
  triageId: string;
  aiSuggestion: TriageLevel | null;
  aiStatus: AiStatus;
  requiresManualDecision: boolean;
}

const promptTemplate = readFileSync(
  new URL('../../prompts/triage_system.txt', import.meta.url),
  'utf8',
);

function validateAge(age: number): void {
  if (!Number.isInteger(age) || age < 0 || age > 130) {
    throw new RangeError('Age must be an integer between 0 and 130');
  }
}

function isTriageLevel(value: unknown): value is TriageLevel {
  return typeof value === 'string' && TRIAGE_LEVELS.includes(value as TriageLevel);
}

export class TriageRepository implements TriageRepositoryPort {
  constructor(private readonly database: RelationalDatabase) {
    if (!database || typeof database.query !== 'function') {
      throw new TypeError('A relational database query client is required');
    }
  }

  async initialize(): Promise<void> {
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

  async createSuggestion({
    triageId,
    aiSuggestion,
    aiStatus,
  }: {
    triageId: string;
    aiSuggestion: TriageLevel | null;
    aiStatus: AiStatus;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO acs_triage (triage_id, ai_suggestion, ai_status)
       VALUES ($1, $2, $3)`,
      [triageId, aiSuggestion, aiStatus],
    );
  }

  async recordDecision({
    triageId,
    acsDecision,
  }: {
    triageId: string;
    acsDecision: TriageLevel;
  }): Promise<string | null> {
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

export class TriageService {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: StructuredLogger;
  private readonly requestDuration: Histogram;
  private readonly requestErrors: Counter;

  constructor(private readonly options: TriageServiceOptions) {
    if (!options.endpoint || !options.model || !options.repository) {
      throw new TypeError('An AI endpoint, model, and triage repository are required');
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('A fetch implementation is required');
    }
    this.logger = options.logger ?? new JsonLogger();
    const meter = options.meter ?? metrics.getMeter('acs-triage');
    this.requestDuration = meter.createHistogram('acs.ai.request.duration', {
      unit: 'ms',
      description: 'Duration of AI triage requests',
    });
    this.requestErrors = meter.createCounter('acs.ai.request.errors', {
      description: 'Failed AI triage requests, including invalid output',
    });
  }

  async suggest({ symptoms, age, patientName }: SuggestionInput): Promise<SuggestionResult> {
    validateAge(age);
    const safeSymptoms = sanitizeSymptoms(symptoms, patientName);
    const triageId = randomUUID();
    const startedAt = performance.now();
    let aiSuggestion: TriageLevel | null = null;
    let aiStatus: AiStatus = 'ok';
    let failureReason: string | undefined;

    try {
      const prompt = promptTemplate
        .replace('{{AGE}}', String(age))
        .replace('{{SYMPTOMS}}', safeSymptoms);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.options.apiKey) headers.authorization = 'Bearer ' + this.options.apiKey;
      const response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.options.model,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) throw new Error('api_error');
      const payload: unknown = await response.json();
      const output = (payload as {
        choices?: Array<{ message?: { content?: unknown } }>;
      })?.choices?.[0]?.message?.content;
      if (!isTriageLevel(output)) {
        failureReason = 'invalid_output';
        throw new Error(failureReason);
      }
      aiSuggestion = output;
    } catch (error) {
      aiStatus = 'manual';
      failureReason ??= (
        error instanceof Error && error.message === 'api_error' ? 'api_error' : 'request_error'
      );
      this.requestErrors.add(1, { reason: failureReason });
    } finally {
      this.requestDuration.record(performance.now() - startedAt);
    }

    await this.options.repository.createSuggestion({ triageId, aiSuggestion, aiStatus });
    this.logger.info({
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

  async recordAcsDecision({
    triageId,
    acsDecision,
  }: {
    triageId: string;
    acsDecision: TriageLevel;
  }): Promise<void> {
    if (!triageId || !isTriageLevel(acsDecision)) {
      throw new TypeError('A valid triage ID and ACS decision are required');
    }
    const aiSuggestion = await this.options.repository.recordDecision({ triageId, acsDecision });
    this.logger.info({
      event: 'acs.triage.decision',
      triage_id: triageId,
      ai_suggestion: aiSuggestion,
      acs_decision: acsDecision,
    });
  }
}
