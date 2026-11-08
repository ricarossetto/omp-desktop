/**
 * Limites de tamanho do transporte host → main → renderer.
 *
 * O OMP mantém o histórico completo em disco. Histórico e snapshots NÃO são
 * mais projetados aqui: o writer fragmenta a linha física e o HostClient
 * remonta o payload lógico, então mensagens/resultados grandes atravessam o
 * canal intactos. `capValue` permanece como teto para respostas e eventos que
 * não carregam histórico (estado, comandos, estatísticas, frames live).
 *
 * Nada aqui altera o dado persistido pelo OMP.
 */

/** Orçamento padrão por evento/response que não carrega histórico (8 MiB de JSON UTF-8). */
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;

/** Marca visível no lugar do conteúdo omitido (mantém o dado no OMP). */
export const OMITTED_MARKER = "… [conteúdo omitido por tamanho; o dado completo continua salvo no OMP]";

const MAX_DEPTH = 24;
const MAX_ARRAY_ITEMS = 20_000;
const MAX_OBJECT_KEYS = 20_000;

export function jsonBytes(value: unknown): number {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const head = Math.max(1, Math.floor(limit * 0.6));
	const tail = Math.max(0, limit - head - OMITTED_MARKER.length);
	const suffix = tail > 0 ? text.slice(-tail) : "";
	return { text: `${text.slice(0, head)} ${OMITTED_MARKER}${suffix}`, truncated: true };
}

interface DeepCapOptions {
	stringLimit: number;
	arrayLimit: number;
	depth: number;
}

function deepCap(value: unknown, options: DeepCapOptions): unknown {
	if (options.depth > MAX_DEPTH) return OMITTED_MARKER;
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") return truncateText(value, options.stringLimit).text;
	if (Array.isArray(value)) {
		const limit = Math.min(options.arrayLimit, MAX_ARRAY_ITEMS);
		const kept = value
			.slice(0, limit)
			.map((item) => deepCap(item, { ...options, depth: options.depth + 1 }));
		if (value.length > limit) kept.push(`${OMITTED_MARKER} (${value.length - limit} itens)`);
		return kept;
	}
	if (typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.type === "image" &&
		typeof record.data === "string" &&
		record.data.length > options.stringLimit * 2
	) {
		const { data: _data, ...rest } = record;
		return { ...rest, omitted: true };
	}
	const out: Record<string, unknown> = {};
	const keys = Object.keys(record);
	for (const key of keys.slice(0, Math.min(options.arrayLimit, MAX_OBJECT_KEYS))) {
		out[key] = deepCap(record[key], { ...options, depth: options.depth + 1 });
	}
	if (keys.length > options.arrayLimit) out[`__omitidos`] = `${keys.length - options.arrayLimit} campos`;
	return out;
}

/**
 * Projeta um valor arbitrário (resposta RPC/evento sem histórico) para caber
 * em `maxBytes`. Preserva a forma enquanto possível; no pior caso devolve um
 * objeto com a marca de omissão, nunca uma linha gigante.
 *
 * NUNCA use em histórico/snapshot: esses payloads precisam atravessar
 * íntegros e são fragmentados pelo wire host → main.
 */
export function capValue(value: unknown, maxBytes: number = MAX_EVENT_BYTES): unknown {
	if (jsonBytes(value) <= maxBytes) return value;
	let stringLimit = Math.max(256, Math.floor(maxBytes / 32));
	let arrayLimit = MAX_ARRAY_ITEMS;
	for (let attempt = 0; attempt < 10; attempt++) {
		const projected = deepCap(value, { stringLimit, arrayLimit, depth: 0 });
		if (jsonBytes(projected) <= maxBytes) return projected;
		stringLimit = Math.max(64, Math.floor(stringLimit / 4));
		arrayLimit = Math.max(200, Math.floor(arrayLimit / 4));
	}
	const minimal = deepCap(value, { stringLimit: 64, arrayLimit: 200, depth: 0 });
	if (jsonBytes(minimal) <= maxBytes) return minimal;
	return { omitted: true, reason: OMITTED_MARKER };
}
