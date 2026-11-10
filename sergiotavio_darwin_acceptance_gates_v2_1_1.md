# DARWIN — acceptance gates v2.1.1

Espelho documental gerado dos campos de
`sergiotavio_darwin_gate_registry_v2_1_1.json`, sem promover gates nem criar
evidências. **O JSON é a fonte de verdade; este MD é espelho.**
Para regenerar, transcrever seus metadados, regras e linhas de `gates` na
mesma ordem, preservando valores e evidência vazia.

- version: `2.1.1`
- project: `DARWIN`
- release_decision: `NO_GO`
- source_of_truth: `Este JSON. O MD é espelho.`
- branch: `sergiotavio/darwin-001-g0-g1`
- scope: `G0 + G1 apenas na primeira rodada`

## Regras

- Gate tecnico = codigo + teste + log literal + artefato
- Sem artefato, gate continua NOT_VERIFIED
- FAIL em gate de regras = NO-GO

## Gates

| id | title | status | evidence |
| --- | --- | --- | --- |
| G01 | Schema valido | NOT_VERIFIED | |
| G02 | Ontologia minima | NOT_VERIFIED | |
| G03 | Registro de fonte | NOT_VERIFIED | |
| G04 | Duas versoes sem alterar a primeira | NOT_VERIFIED | |
| G05 | Evidencia favoravel e contraria | NOT_VERIFIED | |
| G06 | Isolamento em 3 motivos separados | NOT_VERIFIED | |
| G07 | Snapshot historico | NOT_VERIFIED | |
| G08 | Export auditavel | NOT_VERIFIED | |
| G09 | Import e recuperacao | NOT_VERIFIED | |
| G10a | Autorizacao local | NOT_VERIFIED | |
| G10b | Autorizacao multiusuario | NOT_VERIFIED | |
| SEC-RULES | Regras do projeto | NOT_VERIFIED | |
| SEC-SCOPE | Escopo FOUNDER | NOT_VERIFIED | |
| SEC-SCOPE2 | Escopo ADAPTER separado | NOT_VERIFIED | |

As 14 evidências são strings vazias no JSON. PASS na auditoria de existência
F0 não significa PASS nestes gates; a decisão permanece **NO_GO**.
