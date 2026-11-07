# OMP Desktop — brief visual e de interação (shell, conversa, diálogos e projetos)

## 1. Fonte visual

Procurei um export do OpenDesign apenas em os diretórios de trabalho do projeto (listagem simples, sem abrir aplicativos). Não há export do OpenDesign nesses diretórios. A camada visual foi implementada em React + CSS próprio com os tokens desta entrega, separada em `styles/tokens.css`, `styles/app.css` e CSS por feature; se um export compatível surgir, a camada visual pode ser substituída sem alterar o store nem os contratos de ações.

Referência de arquitetura/UX: OpenCode Desktop (MIT) e OMP. Nenhum artefato, marca ou ícone do OpenCode foi copiado.

## 2. Telas e estados

| Tela | Conteúdo | Estados obrigatórios |
| --- | --- | --- |
| Inicial (`StartScreen`) | marca, abrir pasta, projetos recentes, ambiente detectado | carregando, vazio, erro de listagem, projeto indisponível com Relocalizar/Remover recente, confirmação de remoção |
| Shell | lateral 256px, conversa central, painel direito 340px, terminal inferior 240px, barra superior | sem sessão, restaurando abas, sessão iniciando, aberta, trabalhando, interrompida, com erro, trabalho assíncrono pendente |
| Conversa | histórico virtualizado, cards de ferramenta, Markdown, raciocínio recolhível, imagens | vazio, streaming, saída parcial, erro de ferramenta, saída enorme paginada, resultado truncado pelo OMP |
| Compositor | texto, anexos, fila, comandos `/`, Parar | rascunho preservado, enviando, streaming com steer/follow-up, fila com remover/promover, anexo inválido |
| Diálogos | select, confirm, input secreto, editor, ask | enviando, erro de resposta, timeout com aviso, várias solicitações na fila |
| Paleta (Ctrl+K) | ações do app e comandos anunciados pelo OMP | vazio, navegação por teclado |
| Configurações | `SettingsScreen` de UI_B dentro de modal completo | carregando/erro/editable em UI_B |
| Diagnóstico | `DiagnosticsScreen` de UI_B quando OMP ausente/incompatível/host falhou | selecionar executável, tentar novamente |

## 3. Tokens

Dark (padrão): fundo `#111315`, painel `#191C1F`, texto `#E6E8EA`, secundário `#A4AAB2`, borda `#32383F`, acento `#83B4E8`, sucesso `#6FCF97`, aviso `#E6B450`, erro `#F07A7A`.

Light: fundo `#F7F8FA`, painel `#FFFFFF`, texto `#20252B`, secundário `#53606D`, borda `#CCD2D9`, acento `#245F98`, sucesso `#1F7A4D`, aviso `#8A5B00`, erro `#B42318`.

Sem gradientes, sem all-caps decorativo, sem animação contínua. Tema por `prefers-color-scheme` e atributo `data-theme` (`light`/`dark`); a escolha do usuário é persistida via `ui.setState` e aplicada no `<html>`.

Tipografia: Segoe UI Variable/Segoe UI (controles e texto), Cascadia Code (código). Base 14px/1.5; escala 12/14/16/20; espaçamento 4/8/12/16/20/24; raios 4/8px. Foco visível em todos os controles; `prefers-reduced-motion` zera transições.

## 4. Layout e responsividade

- Lateral fixa de 256px (arrastável 200–380) com projetos recentes, seletor de projeto, nova sessão e lista de sessões; item aberto, ocupado por outro processo e "Executando" são indicados com texto e ícone.
- Painel direito de 340px (arrastável 280–520) com abas Agentes/Alterações; em 1000px ou menos vira drawer com backdrop, sem remover comandos.
- Terminal inferior de 240px (arrastável 140–620), recolhível; desmontado ao fechar para encerrar o PTY do app.
- Larguras, aba ativa, terminal e tema são persistidos em `ui.setState` sob a chave `shell`, com merge do objeto existente; abas abertas e sessão ativa também são restauradas.
- Abas de sessão horizontais no topo da conversa com indicador de trabalho e de aprovações pendentes.

## 5. Contratos de ações usados pelo renderer

- Ambiente: `runtime.status`, `runtime.selectOmp`, `runtime.openExternal` (somente http/https), `ui.getState`, `ui.setState`.
- Projetos/sessões: `workspace.pick`, `workspace.list`, `workspace.relocate`, `workspace.removeRecent`, `session.list`, `session.create`, `session.open`, `session.close`, `session.snapshot`, `session.rpc`, `session.uiResponse`, `session.exportHtml`.
- Anexos: `attachment.pick`, `attachment.import` (Uint8Array via IPC), `attachment.remove`.
- Conversa: `session.rpc` com `prompt`/`steer`/`follow_up`, `abort_and_restore_queue`, `remove_queued_message`, `promote_queued_message`, `get_session_stats`, `navigate_tree`, `fork`.
- Arquivos citados: `files.openExternal` com caminho relativo validado pelo main.

O renderer nunca recebe tokens, headers ou `providerPayload`; custo exibido vem de `get_session_stats` (rótulo “Custo estimado”), contexto é 0–100 e ausência mostra “Indisponível”. Nenhum prompt é reenviado automaticamente após interrupção: o botão apenas recoloca o texto no compositor.

## 6. Conversa e compositor

- Virtualização própria por alturas medidas (ResizeObserver) + estimativa; prepend de histórico preserva a âncora visual; botão “Ir para a resposta” quando o usuário está fora do fim.
- Markdown via `react-markdown`/`remark-gfm` sem HTML cru; blocos de código com copiar; links só abrem por clique; imagem remota vira link (CSP bloqueia carregamento remoto).
- Cards de ferramenta mostram intenção, argumentos, saída parcial, resultado, erro e selo de truncamento; saída acima de 4.000 caracteres expande e pagina sem descartar o conteúdo.
- Enter envia, Shift+Enter quebra linha, composição de IME é respeitada. Durante streaming: “Interromper com orientação” (`steer`) e “Enviar depois” (`follow_up`), além de “Parar” explícito que usa `abort_and_restore_queue` e recoloca textos/imagens restaurados (com aviso de `truncated`/`imagesDropped`).
- Rascunho e chips de anexos são por sessão e só saem com o ack do prompt; falha preserva tudo. A fila (`state.queue`) só é alterada após a confirmação do RPC de remover/promover.
- Comandos `/` vêm exclusivamente de `get_available_commands`/`available_commands_update`; a paleta e o menu de barra inserem nome/argumentos no compositor.
- `agent_end` com `isTerminal:false` não é tratado como ociosidade: barra, aviso e compositor usam `isSettled`/`hasPendingAsyncWork`/`status`.

## 7. Diálogos

- `select` com `optionDetails`, `confirm`, `input` (segredo mascarado, com revelar), `editor` multiline e `ask` com perguntas simples, múltipla escolha e entrada livre.
- Respostas exatas: `select`/`input`/`editor` → `{value}`; `confirm` → `{confirmed}`; `ask` → `{answers:[{id,selectedOptions,customInput?}]}`; cancelar/timeout → `{cancelled:true}` (+ `timedOut:true`).
- Nenhuma opção é pré-aprovada; o foco inicial vai para Cancelar (ou primeiro campo), Tab fica preso, Esc cancela apenas o diálogo e o botão de enviar é desabilitado após a primeira tentativa. Timeout mostra contagem e cancela sem aprovar. Cancelamento do OMP (`method:"cancel"`) apenas remove o `targetId` pelo reducer.

## 8. Atalhos

Ctrl+K paleta · Ctrl+M modelos · Ctrl+Shift+P abrir projeto · Ctrl+N nova sessão · Ctrl+\` terminal · Esc fecha overlay/diálogo e, sem diálogo e fora de campo editável, interrompe o trabalho ativo.

## 9. Acessibilidade

Rótulos em botões de ícone, `role`/`aria` em abas, listas, diálogos e paleta, `aria-live` para status/toasts, foco preso em modais, foco visível de 2px, navegação completa por teclado nos splitters, alvos de 28–30px, estados por ícone + texto (não só cor), `prefers-reduced-motion`.

## 10. Pré-visualização com fixtures

- `src/renderer/preview/PreviewApp.tsx` e `preview-data.ts` são explicitamente PREVIEW e só renderizam em desenvolvimento com `?preview=1` (`import.meta.env.DEV`).
- Exibem o shell real com sessão fictícia (mensagens, tool cards, fila, agentes, custo/contexto e anexos), com sinalização fixa “PREVIEW — dados fictícios”. Um botão alterna um diálogo de aprovação fictício.
- O store real (`createAppStore`) não importa nem usa fixtures; produção não contém indicadores falsos.

## 11. Limitações desta camada

- Sem export OpenDesign local; sem capturas de tela nesta entrega (o integrador captura a janela Electron).
- Histórico paginado por `get_entries` é responsabilidade do host; o renderer virtualiza e preserva a âncora quando o histórico cresce.
- Threads de subagentes, Git/Monaco, terminal, contas e configurações são componentes de UI_B montados pelo shell.
