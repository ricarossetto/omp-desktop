import type { RuntimeStatus } from "@shared/contracts";

/**
 * O override local do diagnóstico embutido só pode substituir o status OMP.
 * Dependências (Git/Node) vêm sempre do store, que é a fonte única e recebe o
 * progresso/resultado da instalação. Assim, um download longo não recoloca um
 * status OMP antigo capturado no clique.
 */
export function effectiveOnboardingRuntime(
	override: RuntimeStatus | null,
	runtime: RuntimeStatus | null,
): RuntimeStatus | null {
	if (!override) return runtime;
	return {
		...override,
		// O campo legado acompanha o mesmo snapshot do store; sem isso o
		// diagnóstico embutido poderia mostrar um Git antigo enquanto a seção
		// de ferramentas já mostra o Git instalado.
		gitVersion: runtime ? runtime.gitVersion : override.gitVersion,
		dependencies: runtime?.dependencies ?? override.dependencies,
	};
}

/**
 * Chave que muda apenas quando o status OMP relevante muda. Eventos de
 * progresso de Git/Node alteram `runtime.dependencies`, mas não esta chave,
 * então não apagam a seleção de omp.exe feita no diagnóstico.
 */
export function ompStatusKey(runtime: RuntimeStatus | null): string {
	if (!runtime) return "";
	return `${runtime.phase}|${runtime.ompPath ?? ""}|${runtime.ompVersion ?? ""}|${runtime.install?.state ?? ""}`;
}
