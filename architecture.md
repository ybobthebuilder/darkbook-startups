# Contrato do Módulo de Triagem ACS

## Objetivo e autoridade

O módulo recebe sintomas relatados e pode solicitar uma sugestão à LLM. A IA
apoia a triagem; a decisão final pertence ao ACS. A sugestão nunca deve ser
tratada automaticamente como decisão clínica.

## Contrato funcional

- **Input:** texto dos sintomas relatados. Antes de qualquer chamada à LLM, o
  texto deve passar por sanitização de PII.
- **Saída da IA:** exatamente um dos valores `EMERGENCIA`, `UBS` ou `CASA`.
  Não aceitar explicações, prefixos, sufixos, variações de caixa ou qualquer
  outro valor como classificação válida.
- **Fallback:** falha de chamada, resposta ausente ou saída fora do conjunto
  permitido deve encaminhar o caso para revisão manual pelo ACS. Falhas não
  devem impedir a continuidade do fluxo manual nem ser convertidas em uma
  classificação.
- **Decisão:** o ACS registra a decisão final separadamente da sugestão da IA.

## Compliance e privacidade

Nomes, CPF e outros dados pessoais identificáveis (PII) não podem ser enviados
à LLM. O texto deve ser examinado e os identificadores detectados mascarados
antes da montagem do prompt. A aplicação não deve incluir sintomas ou PII nos
logs operacionais. A detecção por regex é uma barreira de redução de risco, não
uma garantia de identificação de toda PII; os campos da requisição devem ser
limitados aos dados necessários e a saída do sanitizador deve ser verificada.

## Observabilidade e auditoria

Registrar eventos estruturados com um identificador de triagem e os campos
`ai_suggestion` e `acs_decision`, sem sintomas nem PII. Manter a sugestão e a
decisão final distintas, inclusive quando o ACS concordar com a IA.

O *override rate* é a proporção de triagens com sugestão válida da IA em que a
decisão final do ACS difere da sugestão, dentre as triagens com sugestão válida
e decisão ACS registrada. Casos encaminhados ao fallback manual, sem sugestão
válida da IA, não entram no denominador.

## Alinhamento necessário com a implementação

No momento deste documento, `triage-service/src/services/triageService.ts` e
`triage-service/prompts/triage_system.txt` ainda usam os níveis `low`,
`medium` e `high`. Portanto, o contrato acima fixa os níveis solicitados, mas
a implementação atual ainda não os cumpre. Antes de ativar esse contrato, a
lista de saída, o prompt e os testes do serviço devem ser atualizados em conjunto.
