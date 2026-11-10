const CPF_PATTERN = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const SELF_IDENTIFICATION_PATTERN =
  /((?:meu nome (?:é|e)|nome\s*[:=]|sou (?:o|a))\s+)([\p{L}][\p{L}'-]*(?:\s+(?!e\b|estou\b|tenho\b|sinto\b|com\b|relato\b)[\p{L}][\p{L}'-]*){0,3})/giu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeSymptoms(symptoms: string, patientName?: string): string {
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
    sanitized = sanitized.replace(new RegExp(escapeRegExp(patientName.trim()), 'giu'), '[REDACTED]');
  }
  return sanitized;
}
