# Segurança das dependências — 0.3.0

Revisão: 7 de novembro de 2026. Próxima revisão das exceções: 7 de dezembro de 2026, ou antes se uma atualização do OMP ou do empacotador mudar os caminhos descritos abaixo.

## Correção aplicada

O Monaco 0.57.0 inclui DOMPurify 3.4.15 tanto como dependência quanto como cópia interna. A versão 0.3.0 fixa DOMPurify em **3.4.17** no lockfile e redireciona a importação interna do Monaco para essa mesma versão no Vite. Assim, a correção não se limita a alterar o resultado do gerenciador de pacotes: o renderer também usa o código corrigido.

Referências: [GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7), [GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr).

## Avisos residuais e alcance

`bun audit` ainda pode retornar código de saída 1 pelos avisos abaixo. Isso não significa uma auditoria sem achados. Não foi aplicado override de versão principal para ocultá-los.

| Dependência | Aviso | Alcance observado e decisão |
| --- | --- | --- |
| `zod@3.25.76`, via OMP → `puppeteer-core@25.3.0` → `chromium-bidi@16.0.1` | Alto: [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | O Zod direto do aplicativo é 4.6.7, corrigido. A cópia 3.x pertence ao adaptador WebDriver BiDi do Puppeteer; o fluxo de navegador do OMP inspecionado usa CDP, não BiDi. O adaptador carrega dinamicamente no caminho BiDi. Não foi encontrada versão 3.x corrigida. Forçar Zod 4 quebraria o contrato declarado do adaptador. Exceção condicionada a manter esse caminho não utilizado; reavaliar se o OMP passar a usar BiDi. |
| `minimatch@9.0.9` e `10.2.6`, via `electron-builder` | Moderado: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Ferramenta de build, fora das dependências de produção. O empacotamento usa padrões definidos no próprio projeto, não padrões enviados por usuários. A correção exige minimatch 11; não foi forçada uma atualização incompatível. Reavaliar com a atualização do electron-builder. |

Essas conclusões são uma análise dos caminhos existentes, não garantia de ausência de vulnerabilidades nem autorização para ativar outros modos sem revisão.

## Verificação reproduzível

```powershell
bun install --frozen-lockfile --ignore-scripts
bun audit
bun run typecheck
bun run test
bun run test:acceptance
bun run dist:win
```

O instalador não é assinado. Verifique sua origem no GitHub Releases e compare o SHA-256 com `SHA256SUMS.txt`. Não desative o antivírus ou o SmartScreen para contornar um alerta.

Para reportar uma vulnerabilidade sem publicar dados sensíveis, consulte [SECURITY.md](../SECURITY.md).
