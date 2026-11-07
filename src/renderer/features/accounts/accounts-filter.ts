/**
 * Busca da tela de contas: pura para ser testada sem React.
 * Compara nome, e-mail/rótulo, plano/detalhe, tipo e id de credencial.
 */

export interface SearchableAccount {
	credentialId?: number;
	label?: string;
	detail?: string;
	type?: string;
}

export interface SearchableProvider {
	id: string;
	name: string;
}

/** Remove credenciais de URLs de autorização antes de exibi-las. */
export function redactUrlForDisplay(url: string): string {
	try {
		const parsed = new URL(url);
		for (const key of [...parsed.searchParams.keys()]) {
			if (/token|secret|password|code|key/i.test(key)) parsed.searchParams.set(key, "***");
		}
		// OAuth implícito devolve credenciais no fragmento (`#access_token=…`).
		if (parsed.hash) {
			const raw = parsed.hash.slice(1);
			const params = new URLSearchParams(raw);
			let changed = false;
			for (const key of [...params.keys()]) {
				if (/token|secret|password|code|key/i.test(key)) {
					params.set(key, "***");
					changed = true;
				}
			}
			if (changed) parsed.hash = params.toString();
			else if (/token|secret|password|code|key/i.test(raw)) parsed.hash = "***";
		}
		return parsed.toString();
	} catch {
		return url;
	}
}

/** Eventos de login só valem para a janela e a sessão que iniciaram o fluxo. */
export function isEventForSession(
	event: { workspaceId?: string; sessionId?: string },
	workspaceId: string,
	sessionId: string | undefined,
): boolean {
	return event.workspaceId === workspaceId && event.sessionId === sessionId;
}

export function matchesAccountQuery(
	query: string,
	fields: readonly (string | number | undefined)[],
): boolean {
	const needle = query.trim().toLocaleLowerCase();
	if (needle.length === 0) return true;
	return fields.some((field) => {
		if (field === undefined) return false;
		return String(field).toLocaleLowerCase().includes(needle);
	});
}

export function filterProviders<T extends SearchableProvider>(
	providers: readonly T[],
	query: string,
	accountsFor: (providerId: string) => readonly SearchableAccount[],
): T[] {
	const needle = query.trim();
	if (needle.length === 0) return [...providers];
	return providers.filter((provider) => {
		if (matchesAccountQuery(needle, [provider.id, provider.name])) return true;
		return accountsFor(provider.id).some((account) =>
			matchesAccountQuery(needle, [
				account.credentialId,
				account.label,
				account.detail,
				account.type,
			]),
		);
	});
}
