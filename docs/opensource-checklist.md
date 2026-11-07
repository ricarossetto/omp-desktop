# Checklist de publicação

Este checklist descreve o processo de release sem dados de contas ou caminhos de desenvolvimento.

## Antes de publicar

- Executar `bun install --frozen-lockfile --ignore-scripts`, checagem de tipos, testes unitários e aceitação em Electron.
- Executar `bun audit`; registrar alcance, justificativa e data de revisão de qualquer dependência ainda sinalizada em [release-security.md](release-security.md).
- Conferir os READMEs em [português](../README.md), [inglês](README.en-US.md) e [chinês simplificado](README.zh-CN.md).
- Conferir capturas e seus metadados: não incluir contas, e-mails pessoais, diretórios de usuário, tokens ou sessões reais privadas.
- Usar identidade pública ou `noreply` nos commits. Verificar todo o histórico que ficará público, não apenas o último arquivo.
- Se o histórico antigo contiver dados privados, mantê-lo separado e privado; publicar somente um snapshot limpo, sem compartilhar objetos Git antigos.
- Preservar licenças e avisos de terceiros em `resources/licenses` e nos pacotes distribuídos.
- Construir o instalador a partir do commit destinado ao release e testar a instalação fora do checkout, com perfil temporário.
- Inspecionar o conteúdo instalado e confirmar a ausência de configurações, credenciais, logs, testes e mapas de código-fonte da aplicação.
- Calcular SHA-256 do instalador final e publicar `SHA256SUMS.txt` junto dele.
- Enviar somente os arquivos explicitamente revisados. Não enviar a pasta `release/` inteira: `builder-debug.yml` contém caminhos da máquina de build.
- Não publicar `.cache`, perfis de navegador, resultados de testes, cópias de segurança privadas ou `win-unpacked`.
- Confirmar que a tag, o código publicado, a versão do aplicativo e o instalador correspondem.

## Limites do produto

O instalador Windows x64 não tem assinatura digital nem atualização automática. Ele inclui Bun, mas não instala o executável OMP. A publicação de hashes não substitui uma assinatura de código nem uma auditoria independente.

A auditoria automatizada de acessibilidade e os testes de interface não substituem testes com pessoas usuárias e tecnologias assistivas. Dados digitados nas conversas podem conter informações sensíveis: revise qualquer material antes de compartilhá-lo.
