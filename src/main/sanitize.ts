/**
 * Segunda barreira defensiva entre host e renderer.
 *
 * Separa duas coisas que não podem ser confundidas (mesma política de
 * `src/host/sanitize.ts`):
 * - Campos de TRANSPORTE (providerPayload, headers do provedor, tokens, apiKey,
 *   baseUrl com credenciais) são removidos/redigidos.
 * - CONTEÚDO de conversa (`arguments`/`args`/`content`/`details`/`result`/
 *   `partialResult`/`update`/`toolCall`/`toolResult`) é preservado literalmente.
 *   Uma ferramenta pode ler um arquivo com as chaves `headers`/`secret` e isso é
 *   dado, não segredo.
 *
 * Nenhuma redaction por prefixo (`sk-...`) é aplicada a texto: isso corromperia
 * mensagens do usuário. Segredos só em campos de transporte e nos logs.
 *
 * Módulo puro, sem dependência de Electron.
 */
export const REDACTED = "[removido]";

const DROP_KEYS: Record<string, true> = {
	providerpayload: true,
	providermetadata: true,
	providerfile: true,
	providerfilereference: true,
	headers: true,
	requestheaders: true,
	responseheaders: true,
	apikey: true,
	api_key: true,
	authorization: true,
	accesstoken: true,
	access_token: true,
	refreshtoken: true,
	refresh_token: true,
	idtoken: true,
	id_token: true,
	clientsecret: true,
	client_secret: true,
};

/** Chaves de topo que só existem para o dump da TUI e incham o transporte. */
const DROP_TOP_LEVEL: Record<string, true> = { systemprompt: true, dumptools: true, raw: true };

/**
 * Subárvores que carregam CONTEÚDO, não transporte: a projeção para de
 * remover chaves a partir daqui.
 */
const CONTENT_KEYS: Record<string, true> = {
	arguments: true,
	args: true,
	content: true,
	details: true,
	partialResult: true,
	result: true,
	update: true,
	toolCall: true,
	toolResult: true,
};

const MAX_DEPTH = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Chave de transporte, exata ou aninhada em mapas de configuração (`providers.x.apiKey`). */
function droppedTransportKey(key: string): boolean {
	const plain = key.toLowerCase();
	if (DROP_KEYS[plain] === true) return true;
	const dot = plain.lastIndexOf(".");
	return dot >= 0 && DROP_KEYS[plain.slice(dot + 1)] === true;
}

function isBaseUrlKey(key: string): boolean {
	const plain = key.toLowerCase();
	return plain === "baseurl" || plain.endsWith(".baseurl");
}

function scrubbedBaseUrl(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		const url = new URL(value);
		if (url.username || url.password) return "[redigido: credenciais na URL]";
		return value;
	} catch {
		return value;
	}
}

function scrub(
	value: unknown,
	depth: number,
	topLevel: boolean,
	content: boolean,
	seen: WeakSet<object>,
): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value !== "object") return value;
	if (value instanceof Date) return new Date(value.getTime());
	if (value instanceof Uint8Array) return value;
	if (depth > MAX_DEPTH) return REDACTED;
	if (seen.has(value)) return REDACTED;
	seen.add(value);

	if (Array.isArray(value)) {
		const out = value.map((item) => scrub(item, depth + 1, false, content, seen));
		seen.delete(value);
		return out;
	}
	if (!isPlainObject(value)) {
		seen.delete(value);
		return value;
	}

	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === "__proto__") continue;
		if (!content && droppedTransportKey(key)) continue;
		if (!content && topLevel && DROP_TOP_LEVEL[key.toLowerCase()] === true) continue;
		if (!content && isBaseUrlKey(key)) {
			out[key] = scrubbedBaseUrl(item);
			continue;
		}
		out[key] = scrub(item, depth + 1, false, content || CONTENT_KEYS[key] === true, seen);
	}
	seen.delete(value);
	return out;
}

/**
 * Copia profunda removendo somente campos de transporte. Uint8Array/Buffer e
 * Date são preservados; referências circulares são cortadas com `REDACTED`.
 */
export function sanitizeForRenderer<T>(value: T): T {
	return scrub(value, 0, false, false, new WeakSet<object>()) as T;
}
