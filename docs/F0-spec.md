# DARWIN v2.1.1 — especificação F0

## Escopo e fontes normativas

F0 estabelece uma base executável, auditável e conservadora para o contrato
semântico de P&D. Não entrega ainda a aplicação DARWIN, banco de dados,
resolvers GraphQL, autenticação ou execução dos gates F1–F5.

As fontes normativas são `darwin_semantic_contract_v2.graphql` e
`sergiotavio_darwin_gate_registry_v2_1_1.json`. Seus bytes devem permanecer
inalterados. O JSON é a fonte de verdade dos gates; esta documentação é um
espelho explicativo. O escopo registrado é G0 + G1 apenas na primeira rodada.

Regra de aceitação: gate técnico exige código + teste + log literal + artefato.
Sem artefato, continua `NOT_VERIFIED`. Falha em gate de regras implica `NO_GO`.
F0 não promove nenhum gate: os 14 IDs obrigatórios são G01, G02, G03, G04,
G05, G06, G07, G08, G09, G10a, G10b, SEC-RULES, SEC-SCOPE e SEC-SCOPE2.
Todos permanecem `NOT_VERIFIED`, sem evidência; a decisão é `NO_GO`.

## Requisitos

- Node.js `>=24.0.0`, npm `>=11.0.0`, módulos ESM; manter o Playwright existente.
- `RevisionedNode` deve declarar separadamente `entityId: ID!` e
  `revisionId: ID!`, além de `schemaVersion`, `previousRevisionId`,
  `forkedFromRevisionId`, `branchId`, `createdAt`, `scope`, `provenance`,
  `validation` e `lifecycle`, com os tipos do contrato normativo.
- Project, WorldScenario, Question, Answer, Claim, Evidence e Decision
  implementam `RevisionedNode`; GraphQL verifica suas definições.
- Build e servidor validam com `scripts/contract.mjs`, usando
  `graphql.buildSchema` e `graphql.validateSchema`. Rejeitar
  mutações destrutivas e campos/argumentos genéricos de mudanças, inclusive
  dentro de inputs. A busca conservadora por nomes não é prova de semântica.
- `entityId != revisionId` é uma regra de valores em execução: dois campos
  distintos no SDL **não** a provam. Append-only e retratação por nova revisão,
  sem apagar histórico, exigem implementação e testes futuros.
- Os três isolamentos são INTEGRITY, RULES e EVALUATION; FOUNDER e ADAPTER
  permanecem escopos separados. A existência dos enums não prova isolamento.

## Comandos e artefatos

Executar `npm ci` e depois:

| Comando | Resultado real | Log literal em `artifacts/` |
| --- | --- | --- |
| `npm run validate:schema` | Checks lexicais literais fornecidos pelo usuário, não validação GraphQL | `validate-schema.log` (linhas dos checks, sem newline final) |
| `npm run build` | Bundle determinístico em `dist/`: cópias exatas dos dois contratos e `manifest.json` com SHA-256 e tamanho | `build.log` |
| `npm run dev` | HTTP em `127.0.0.1:3000`; `PORT` permite 0–65535, inclusive porta efêmera | `dev.log` |
| `npm run audit:f0` | Existência de nove caminhos e presença truthy de quatro scripts; `audit-f0-report.json` | Não gera log; capturar stdout com `tee artifacts/audit-f0.log` |
| `npm test` | Testes Playwright de Node/API, sem navegador | Relatório do runner; testes de comandos verificam seus logs nas fixtures |

O servidor oferece somente GET/HEAD em `/`, `/health`, `/contract.graphql` e
`/gate-registry.json`. Não resolve caminhos arbitrários, não serve arquivos do
projeto e não executa GraphQL. Outros métodos retornam 405; outros caminhos
(inclusive traversal e queries) retornam 404. SIGINT/SIGTERM encerram o servidor.

Os scripts `validate-schema.mjs` e `audit-f0.mjs` são cópias literais fornecidas
pelo usuário, sem shebang; executar via `node` (ou npm) **na raiz do projeto**.
Permissões executáveis são preservadas, mas execução direta não é suportada.
O validator faz apenas `text.includes`: comentários contam, formatação pode
alterar resultados e SDL inválido pode passar. Se o contrato faltar, imprime
`FAIL: arquivo do contrato não encontrado`, sai com 1 e não cria/atualiza o log;
um log anterior pode permanecer. Nos outros casos sobrescreve o log dos checks.
A auditoria sobrescreve apenas o JSON `{ missing, scriptsOk, status }`, sem
validar conteúdos, hashes, engines, permissões ou valores exatos dos comandos.
`package.json` ausente ou JSON inválido causa exceção antes do relatório;
artefatos anteriores podem permanecer. Os demais caminhos são apenas testados
por existência, inclusive diretórios. `scriptsOk` mede valores truthy, não
execução. Nenhum desses dois scripts prova validade real do schema.

Build/dev usam a raiz derivada do módulo, independentemente do cwd, e
acrescentam saída literal aos próprios logs; falhas encerram com código não
zero. Os logs e o relatório de auditoria são
evidências versionáveis; `node_modules/`, `dist/`, `test-results/` e
`playwright-report/` não são versionados.

O espelho `sergiotavio_darwin_acceptance_gates_v2_1_1.md` transcreve o registro
JSON, que continua sendo a fonte de verdade. A auditoria exige o espelho, mas
não verifica sua fidelidade. `status: PASS` significa apenas que seus checks
de existência/presença passaram, nunca aprovação dos gates ou liberação.
Build preserva checks fortes de schema e hashes normativos; dev valida o
schema antes de abrir o servidor. Mesmo esses checks estáticos não provam
`entityId != revisionId` em execução nem append-only.

Para registrar honestamente o stdout npm da auditoria, após os outros testes:
`set -o pipefail; npm run audit:f0 | tee artifacts/audit-f0.log`.
Esse log é captura externa, não saída em arquivo gerada pelo script.

## Validação e limites

Os testes usam cópias isoladas em diretórios temporários sob a raiz do projeto,
removidas ao terminar, sem alterar fontes ou evidências de produção. Cobrem
schema válido, corrupção/ausência, campos proibidos, registro, build
determinístico, HTTP/traversal, falhas e relatório da auditoria.

Nenhum resultado F0 prova desigualdade dos IDs em execução, imutabilidade do
histórico, append-only, autorização, recuperação, compilação de contexto,
isolamentos efetivos ou funcionamento de uma aplicação. `release_decision`
continua obrigatoriamente `NO_GO`.
