/**
 * Funções puras do onboarding: busca, agrupamento e comparação de modelos.
 * Ficam fora do componente para serem testadas sem React/DOM.
 */
import type { ModelCatalogEntry } from "@shared/contracts";

export interface ModelGroup {
	provider: string;
	models: ModelCatalogEntry[];
}

/** Busca por nome, provedor, id ou seletor; sem busca devolve a lista inteira. */
export function filterModelCatalog(
	models: readonly ModelCatalogEntry[],
	query: string,
): ModelCatalogEntry[] {
	const needle = query.trim().toLocaleLowerCase();
	if (needle.length === 0) return [...models];
	return models.filter((model) => {
		const haystack =
			`${model.provider} ${model.id} ${model.name} ${model.selector}`.toLocaleLowerCase();
		return haystack.includes(needle);
	});
}

/** Agrupa por provedor preservando a ordem estável do catálogo. */
export function groupModelCatalog(models: readonly ModelCatalogEntry[]): ModelGroup[] {
	const groups = new Map<string, ModelCatalogEntry[]>();
	for (const model of models) {
		const list = groups.get(model.provider) ?? [];
		list.push(model);
		groups.set(model.provider, list);
	}
	return [...groups.entries()].map(([provider, entries]) => ({ provider, models: entries }));
}

/**
 * `modelRoles` pode carregar um nível de raciocínio no sufixo
 * (`provider/modelo:high`); para destacar o padrão comparamos só o seletor.
 */
export function selectorMatchesRole(selector: string, roleValue: string | undefined): boolean {
	if (!roleValue) return false;
	const base = roleValue.split(":")[0] ?? roleValue;
	return base === selector;
}

/** Mantém o mapa de papéis intacto ao trocar apenas o papel `default`. */
export function withDefaultRole(
	roles: Record<string, string>,
	selector: string | null,
): Record<string, string> {
	const next = { ...roles };
	if (selector) next.default = selector;
	else delete next.default;
	return next;
}
