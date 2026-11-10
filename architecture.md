# ACS triage module architecture (OMS)

## Scope and decision boundary

The module is backend-only. AI provides a suggestion; the ACS retains sole
authority to make and record the triage decision. A suggestion is never
presented as a decision, and an unavailable or invalid AI response routes the
case to the existing manual-decision boundary without treating the failure as a
triage result. The UI is out of scope.

The initial supported levels are exactly `low`, `medium`, and `high`. The
prompt and validator share this contract; changing these levels requires a
review of the prompt, API validation, persistence, and tests.

## OMS mapping

| OMS element | Requirement | Backend control |
| --- | --- | --- |
| Inputs | Only symptoms and age are sent to the AI. | The request is built from those fields only. Symptom text is bounded and cleaned, CPF-like numbers and detected/name-supplied names are regex-masked, and age is range-checked. |
| Outputs | Measure API latency and errors; produce audit events for later override-rate analysis. | OpenTelemetry histogram and error counter; one-line JSON events carry `triage_id`, `ai_suggestion`, and `acs_decision`, never symptom text or patient identifiers. |
| Outcomes | Retain AI suggestion and ACS decision as relational strings. | The repository stores both separately; the ACS decision is written only through the explicit decision-recording operation. |

## Integration and failure behavior

The adapter calls an OpenAI-compatible chat-completions endpoint configured by
the application. The prompt lives in `prompts/triage.txt`. Only an exact
supported level is accepted. Network/HTTP/response errors and any other output
are recorded as AI failures and return `requiresManualDecision: true`; they do
not prevent the ACS from recording a decision.

The repository expects a PostgreSQL-compatible `query` client and exposes an
initialization method for its table. The application owns the connection pool,
OpenTelemetry SDK/exporter configuration, and endpoint credentials.

## Rollback and containment

If AI behavior becomes erratic, disable AI requests at the application
configuration/feature-flag boundary and route all cases to manual ACS decisions.
The persistence and manual-decision path remain available independently. If
needed, roll back the backend change while retaining the additive triage table
and audit records for investigation; do not delete records as part of rollback.
