export type JsonLogEvent = Record<string, unknown>;

export interface StructuredLogger {
  info(event: JsonLogEvent): void;
}

export class JsonLogger implements StructuredLogger {
  info(event: JsonLogEvent): void {
    console.info(JSON.stringify(event));
  }
}
