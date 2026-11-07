import type {
	DependencyKind,
	DependencyProbe,
	DependencyRuntimeState,
} from "../shared/dependency-install-types";

/**
 * Mescla o resultado de uma sondagem que pode ter começado antes de uma
 * instalação concluir. Qualquer mudança autoritativa de estado durante o
 * `await` (geração diferente) vence o probe antigo; uma instalação em
 * andamento continua dona do estado até concluir.
 */
export function mergeDependencyProbe(
	kind: DependencyKind,
	probe: DependencyProbe,
	current: DependencyRuntimeState | undefined,
	generationBefore: number,
	generationAfter: number,
): DependencyRuntimeState {
	if (current?.state === "installing") return current;
	if (generationBefore !== generationAfter) return current ?? probe;
	return probe;
}
