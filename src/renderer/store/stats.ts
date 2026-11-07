import type { SessionStats } from "@shared/session-types";

/**
 * Normaliza o resultado de `get_session_stats` (resposta RPC direta, possivelmente
 * aninhada em `data`). O custo é sempre o valor informado pelo OMP; nunca uma
 * soma de eventos de mensagem.
 */
export function normalizeStats(raw: unknown): SessionStats | null {
	const value = unwrap(raw);
	if (!value || typeof value !== "object") return null;
	const stats = value as Record<string, unknown>;

	const cost = pickNumber(stats.costUsd) ?? pickNumber(stats.cost);
	const tokensRaw = stats.tokens;
	let tokens: SessionStats["tokens"];
	if (tokensRaw && typeof tokensRaw === "object") {
		const t = tokensRaw as Record<string, unknown>;
		tokens = {
			input: pickNumber(t.input),
			output: pickNumber(t.output),
			cacheRead: pickNumber(t.cacheRead),
			cacheWrite: pickNumber(t.cacheWrite),
			total: pickNumber(t.total),
		};
	}

	if (cost === undefined && tokens === undefined) return null;
	return { costUsd: cost, tokens, raw: value };
}

function unwrap(raw: unknown): unknown {
	let current = raw;
	for (let depth = 0; depth < 4; depth++) {
		if (!current || typeof current !== "object") return current;
		const object = current as Record<string, unknown>;
		const looksLikeEnvelope =
			object.type === "response" || object.command === "get_session_stats" || object.success === true;
		if (looksLikeEnvelope && object.data !== undefined) {
			current = object.data;
			continue;
		}
		if (object.result !== undefined) {
			current = object.result;
			continue;
		}
		break;
	}
	return current;
}

function pickNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Formata custo estimado em dólar; ausência continua ausência. */
export function formatCostUsd(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "Indisponível";
	if (value === 0) return "US$ 0,00";
	if (value < 0.01) return `US$ ${value.toFixed(4).replace(".", ",")}`;
	return `US$ ${value.toFixed(2).replace(".", ",")}`;
}

/** Percentual de contexto já vem 0–100 do OMP. */
export function formatContextPercent(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "Indisponível";
	const rounded = Math.round(value * 10) / 10;
	return `${String(rounded).replace(".", ",")}%`;
}
