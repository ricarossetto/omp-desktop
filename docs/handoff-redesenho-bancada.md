# Handoff: redesenho "Bancada" do OMP Desktop

Para o agente que continua o desenvolvimento. Escrito em 06/11/2026.

## Onde está

- Branch: `redesenho-bancada`, criada a partir de `master` (`528f61e`).
- Commits:
  - `78c21e8`: barra de título própria, rodapé, pausa e primeira execução.
  - `6de0ef4`: interface igual ao protótipo em todas as regiões e correção do estado dos runners.
- Nada foi enviado ao remoto nem mesclado na `master`.
- Protótipo de referência: `design/omp-desktop-bancada.html`, um arquivo único que abre no navegador e mostra todas as telas nos temas claro e escuro. Em caso de dúvida visual, ele é a fonte de verdade.

## O que mudou

### Visual e janela
- `src/renderer/styles/tokens.css`: paleta nova nos temas escuro e claro. Os nomes das variáveis não mudaram (`--bg`, `--panel`, `--panel-raised`, `--text`, `--muted`, `--accent` etc.); a nova `--titlebar-height` vale 36px.
- `src/main/index.ts`:
  - `titleBarStyle: "hidden"` com `titleBarOverlay`; minimizar, maximizar e fechar continuam nativos.
  - As cores do overlay seguem `nativeTheme`.
  - O tema escolhido no app vira `nativeTheme.themeSource`. Isso é feito embrulhando `uiState.setState` e lendo `shell.theme`.
- `src/renderer/layout/TitleBar.tsx`:
  - Mostra a marca, alternar barra lateral, Voltar/Avançar e o título projeto / sessão.
  - À direita: busca (paleta), tema, terminal e painel direito.
  - Também exporta `BrandMark` (o logo).
  - O histórico de Voltar/Avançar fica só na memória do componente.
- `src/renderer/App.tsx`: tudo fica dentro de `.app-frame`, com a barra de título em cima.
- O antigo `TopBar` saiu do `Shell`; o arquivo continua no projeto só porque exporta `statusFor`. `SessionTabs` também saiu do `Shell`; a função de fechar sessão foi para a barra lateral.
- Logo: `resources/brand/omp-logo.svg`. Para regenerar o `resources/icon.ico`, rode `bun scripts/build-icon.ts .` (usa `sharp`).

### Barra lateral (`src/renderer/layout/Sidebar.tsx`, reescrita)
- No topo: Nova sessão, Buscar e Skills e MCP (os dois últimos abrem a paleta).
- Árvore de projetos com as sessões dentro. Clicar no nome nunca recolhe o projeto; só a seta recolhe.
- Situação de cada sessão:
  - Trabalhando e Aprovar vêm do estado das sessões abertas.
  - Nova é calculada só no componente: sessão que terminou enquanto você olhava outra.
  - Em uso vem de `locked`.
- A branch e o número de arquivos alterados vêm de `git.status`, atualizado a cada 15 s.
- A sessão é fechada no X do item, com confirmação.
- `SidebarRail`: trilho mostrado quando `layout.sidebarOpen` é falso (Ctrl+B). O campo `sidebarOpen` é novo em `LayoutState` (`state.ts`, `clampLayout`).

### Conversa
- `MessageItem.tsx`:
  - A mensagem do usuário é um balão à direita, com as ações Voltar até aqui (rewind), Ramificar (fork) e Copiar, que aparecem com opacidade ao passar o mouse. Opacidade, e não `display`, para não mudar a altura medida pela virtualização.
  - A resposta do assistente não tem cabeçalho.
  - O raciocínio é um `details` recolhido.
- `ToolCard.tsx`:
  - O card é um `details`, com `ToolStatus` (Rodando com anel, Concluído, Falhou).
  - O diff inline usa `toolDiff()`, que lê `details.diff` do OMP ou `arguments.edits[].diff`.
  - Abre sozinho quando está rodando, quando deu erro ou quando o diff tem até 60 linhas.
- `Composer.tsx`:
  - Menu + (anexar, inserir `@`, inserir `/`) e caixa de modelo e raciocínio, que abre o `ModelPicker` já existente.
  - Linha "Trabalhando · tempo · rodando X" e fila com Enviar agora (promote), Editar (remove e volta ao rascunho) e remover.
  - Pausar e Parar como ícones.
  - Durante o streaming, com texto digitado, aparecem "Interromper com orientação" e "Enviar depois", que são exigência do produto.
- **Pausar depois do passo atual** é implementado só no app: ao clicar, o app guarda quantos passos já terminaram. Quando mais um passo termina e nenhuma ferramenta está rodando, chama `abortAndRestore`. O botão Continuar envia "Continue de onde parou.". O OMP não tem pausa própria.
- `StatusBar.tsx` (rodapé):
  - O contexto é clicável e mostra tokens e o botão "Compactar conversa" (RPC `compact`, bloqueado enquanto o agente trabalha).
  - Também mostra custo estimado, aprovações pendentes e o estado.

### Painel direito
- `RightPanel.tsx`: uma fileira de abas com sublinhado e contadores (agentes; arquivos alterados via `git.status`).
- `AgentsPanel.tsx`: coluna única com objetivo (o formulário fica em "Definir objetivo"), tarefas e runners em cards compactos, com o detalhe e o transcript embaixo. As abas internas Agentes/Tarefas saíram.

### Outras telas
- `StartScreen.tsx`: saudação, cartão "Abrir pasta", recentes, "Antes de começar" e atalhos.
- `features/onboarding/Onboarding.tsx`:
  - Quatro etapas: boas-vindas, ambiente real (`runtime.ompPath`, `gitVersion`, `shell`), tema e primeiro projeto.
  - Aparece só se `localStorage["omp-desktop.onboarding.done"]` não estiver marcado e não houver projeto recente.
- As Configurações viraram tela cheia com navegação vertical, só com CSS (`settings.css`, `shell.css`).
- O diagnóstico, os diálogos, os botões (`.btn`, `.omp-button`) e os avisos foram padronizados por CSS anexado no fim de `app.css`, `dialogs.css`, `changes.css`, `agents.css` e `diagnostics.css`.

### Correção
- `src/shared/session-state.ts`, `mergeAgent`: um evento com estado `unknown` não sobrescreve mais o último estado conhecido. Antes, os runners concluídos apareciam como "Estado desconhecido". No painel, um runner `unknown` e finalizado aparece como "Finalizado".

## Verificação feita
- `bun run typecheck`: passou.
- `bun run build`: passou.
- `bun run test:acceptance`: 9 testes passaram e 1 foi pulado (o smoke real, como de costume).
- `bun test tests/unit`: 228 passaram e 1 falhou: `main-paths.test.ts`, "assertWorkspaceDirectory exige diretório existente". **Essa falha já existia antes deste trabalho** (confirmado com stash).
- Prints conferidos: janela principal no claro e no escuro, Configurações e início.

## O que não foi testado
- Nenhum teste automatizado cobre pausa, primeira execução, diff inline, situação das sessões, árvore de projetos, menu +, Voltar/Avançar ou compactar. Vale escrever testes de aceitação para eles; o `tests/fixtures/fake-omp.ts` pode ganhar cenários.
- Janela de 1000px (gaveta do painel direito) e diálogo de aprovação depois da última passada visual.
- Barra de título real com os botões nativos do Windows: os prints do Playwright não capturam o overlay.
- Escala de 125% e 150% do Windows e contraste medido com ferramenta. As cores foram calculadas à mão.

## Pendências conhecidas
- **Itens do protótipo que ficaram de fora, porque o OMP não suporta:**
  - Seletor de permissões ("Pedir sempre") e "Modo: Executar/Planejar": não há RPC para isso.
  - O modo rápido existe (`set_fast_mode`), mas o estado atual dele não vem nos metadados da sessão.
- **Itens do protótipo que ficaram de fora porque exigem mudar o host:**
  - "Conversas sem projeto" e "Clonar repositório".
  - Soltar uma pasta na janela para abrir.
  - Indicar worktree na barra lateral, porque `git.status` não informa isso.
- Arquivos `.tsx`/`.css` com quebras de linha CRLF e LF misturadas fizeram edições automatizadas falharem em silêncio. Sugestão: um `.gitattributes` com `* text=auto eol=lf`.
- Ficou CSS antigo sem uso em `shell.css`: `.sidebar__brand`, `.workspace-*`, `.session-item`, `.session-tabs`. Dá para limpar.
- `TopBar.tsx` e `SessionTabs.tsx` não são mais renderizados. `TopBar` ainda exporta `statusFor`, usado pelo `StatusBar`; vale mover essa função e apagar os dois arquivos.
- A sessão marcada como "Nova" não é persistida e se perde ao reiniciar o app.

## Regras do produto que o redesenho respeita (não quebrar)
1. O app nunca aprova nada sozinho.
2. Parar fica sempre visível enquanto o agente trabalha. Durante a resposta, o usuário escolhe entre "Interromper com orientação" e "Enviar depois".
3. Valor desconhecido aparece como "Indisponível", nunca como 0%. O custo é sempre "estimado".
4. O runner mostra o modelo efetivo e o configurado separados; sem dado, mostra "Modelo não informado".
5. Estados nunca dependem só de cor: sempre ícone mais texto.
6. Runners finalizados continuam listados.
