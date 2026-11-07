# Segurança

## Como reportar

Não abra uma issue pública para falhas de segurança. Use o recurso **Report a
vulnerability** do GitHub (aba *Security* → *Advisories*) neste repositório, com:

- versão do OMP Desktop e do OMP (`omp --version`);
- passos para reproduzir;
- impacto observado (o que vaza, o que é executado, o que é aprovado sem clique).

Você recebe uma resposta assim que a falha for avaliada.

## Escopo

Fazem parte do escopo:

- execução de código no renderer (XSS, HTML de ferramenta, link malicioso);
- aprovações respondidas sem ação do usuário;
- leitura de arquivos fora dos projetos abertos (path traversal, symlink, UNC);
- exposição de tokens, cabeçalhos ou credenciais na interface, nos logs ou no IPC;
- comandos Git/CLI com injeção de argumentos.

## O que o aplicativo já garante

- O renderer não tem Node, sistema de arquivos nem shell; só `invoke`/`subscribe`.
- Todo IPC valida o frame de origem, o schema e a associação com projeto/sessão.
- O app nunca aprova uma ferramenta sozinho.
- Nenhum prompt é reenviado automaticamente após queda ou reinício.
- Credenciais do OMP ficam no perfil dele (`~/.omp`), nunca no repositório.
