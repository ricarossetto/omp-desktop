# Como contribuir

Obrigado pelo interesse. Este projeto é um aplicativo desktop independente para o
[OMP](https://omp.sh); ele não faz parte do OMP e não é mantido pelos autores dele.

## Antes de abrir uma issue

- Rode `bun run typecheck`, `bun test tests/unit` e `bunx playwright test` para
  confirmar que o problema não é local.
- Descreva o sistema (Windows x64), a versão do app e a do OMP (`omp --version`).
- Para falhas de segurança, siga o [SECURITY.md](SECURITY.md) em vez de abrir issue.

## Ambiente

```powershell
bun install --ignore-scripts
node node_modules/electron/install.js
bun run dev
```

Requisitos: Windows x64, Bun 1.4+ e OMP instalado. O Git só é necessário para o
painel Alterações.

## Padrões

- **Idioma do código**: identificadores em inglês; comentários e mensagens de
  interface em português do Brasil, com as três traduções (`src/renderer/i18n`).
- **Contratos**: `src/shared/contracts.ts` e `src/shared/session-types.ts` são
  compartilhados entre main, host e renderer. Mudou um, ajuste os três lados.
- **Regras do produto** (não quebrar):
  1. o app nunca aprova nada sozinho;
  2. Parar fica sempre visível enquanto o agente trabalha;
  3. valor desconhecido aparece como "Indisponível", nunca 0%;
  4. custo é sempre "estimado" e vem de `get_session_stats`;
  5. runner mostra modelo efetivo e configurado separados;
  6. estados nunca dependem só de cor;
  7. nenhum prompt é reenviado automaticamente.
- **Testes**: comportamento relevante ganha teste. Use o OMP de teste
  (`tests/fixtures/fake-omp.ts`) na aceitação; não gaste cota em teste automatizado.

## Pull requests

1. Uma mudança por PR, com o motivo no título.
2. `bun run typecheck`, `bun test tests/unit` e `bunx playwright test` verdes.
3. Se mudar a interface, anexe uma captura da janela real.
4. Não inclua dados pessoais (caminhos com nome de usuário, e-mails, tokens) em
   capturas, fixtures ou logs.
