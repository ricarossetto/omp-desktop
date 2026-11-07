/**
 * Limites de tamanho do transporte host → main → renderer.
 *
 * O OMP mantém o histórico completo em disco; o que trafega é uma projeção de
 * exibição. Quando uma mensagem/resultado não cabe no orçamento por evento,
 * truncamos o conteúdo com uma marca EXPLÍCITA e sinalizamos a UI
 * (`resultTruncated`, imagens com `omitted`). Nada aqui altera o dado
 * persistido pelo OMP.
 *
 * Garantia: nenhuma projeção ultrapassa `maxBytes`; com o padrão de 8 MiB,
 * nenhuma linha chega perto do limite físico de 64 MiB do protocolo.
 */
import type { ChatMessage, ContentBlock, SessionSnapshot, ToolExecution } from "../shared/session-types";

/** Orçamento padrão por evento/response (8 MiB de JSON UTF-8). */
export const MAX_EVENT_BYTES = 8 * 1024 * 1024;

/** Marca visível no lugar do conteúdo omitido (mantém o dado no OMP). */
export const OMITTED_MARKER = "… [conteúdo omitido por tamanho; o dado completo continua salvo no OMP]";

const MAX_DEPTH = 24;
const MAX_ARRAY_ITEMS = 20_000;
const MAX_OBJECT_KEYS = 20_000;
const IMAGE_INLINE_LIMIT = 512 * 1024;

export function jsonBytes(value: unknown): number {
	try {
		const text = JSON.stringify(value);
		return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
	} catch {
		return Number.MAX_SAFE_INTEGER;
	}
}

export function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
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
 * Projeta um valor arbitrário (resposta RPC, snapshot, evento) para caber em
 * `maxBytes`. Preserva a forma enquanto possível; no pior caso devolve um
 * objeto com a marca de omissão, nunca uma linha gigante.
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

function compactBlock(block: ContentBlock, limit: number): { block: ContentBlock; changed: boolean } {
	switch (block.type) {
		case "text": {
			const { text, truncated } = truncateText(block.text, limit);
			return { block: truncated ? { type: "text", text } : block, changed: truncated };
		}
		case "thinking": {
			const { text, truncated } = truncateText(block.thinking, limit);
			return { block: truncated ? { type: "thinking", thinking: text } : block, changed: truncated };
		}
		case "image": {
			if (!block.data) return { block, changed: false };
			const imageLimit = Math.min(IMAGE_INLINE_LIMIT, Math.max(1024, limit * 8));
			if (block.data.length <= imageLimit) return { block, changed: false };
			return { block: { type: "image", mimeType: block.mimeType, omitted: true }, changed: true };
		}
		case "toolCall": {
			const projected = capValue(block.arguments, Math.max(1024, limit * 4));
			const changed = jsonBytes(projected) !== jsonBytes(block.arguments);
			return { block: changed ? { ...block, arguments: projected } : block, changed };
		}
		case "unknown": {
			const projected = capValue(block.raw, Math.max(512, limit));
			const changed = jsonBytes(projected) !== jsonBytes(block.raw);
			return { block: changed ? { type: "unknown", raw: projected } : block, changed };
		}
		default:
			return { block, changed: false };
	}
}

export function compactMessage(
	message: ChatMessage,
	limit: number,
): { message: ChatMessage; changed: boolean } {
	let changed = false;
	const content = message.content.map((block) => {
		const result = compactBlock(block, limit);
		if (result.changed) changed = true;
		return result.block;
	});
	const errorMessage = message.errorMessage
		? truncateText(message.errorMessage, limit)
		: undefined;
	if (errorMessage?.truncated) changed = true;
	if (!changed) return { message, changed: false };
	return {
		message: {
			...message,
			content,
			errorMessage: errorMessage ? errorMessage.text : message.errorMessage,
		},
		changed: true,
	};
}

function compactTool(tool: ToolExecution, limit: number): ToolExecution {
	let changed = false;
	const partialText = tool.partialText ? truncateText(tool.partialText, limit) : undefined;
	if (partialText?.truncated) changed = true;
	const resultText = tool.resultText ? truncateText(tool.resultText, limit) : undefined;
	if (resultText?.truncated) changed = true;
	const details = tool.details === undefined ? undefined : capValue(tool.details, Math.max(1024, limit * 4));
	if (details !== undefined && jsonBytes(details) !== jsonBytes(tool.details)) changed = true;
	if (!changed) return tool;
	return {
		...tool,
		partialText: partialText ? partialText.text : tool.partialText,
		resultText: resultText ? resultText.text : tool.resultText,
		details: details === undefined ? tool.details : details,
		resultTruncated: true,
	};
}

function compactTools(
	tools: Record<string, ToolExecution>,
	limit: number,
	maxBytes: number,
): Record<string, ToolExecution> {
	const out: Record<string, ToolExecution> = {};
	let bytes = 2;
	// Do mais novo para o mais antigo: se o orçamento acabar, os cards recentes
	// (os únicos usados pela conversa visível) sobrevivem.
	const entries = Object.entries(tools).reverse();
	for (const [key, tool] of entries) {
		const compacted = compactTool(tool, limit);
		let entryBytes = jsonBytes([key, compacted]) + 4;
		if (bytes + entryBytes <= maxBytes) {
			out[key] = compacted;
			bytes += entryBytes;
			continue;
		}
		const stub: ToolExecution = {
			toolCallId: tool.toolCallId,
			name: tool.name,
			status: tool.status,
			resultText: OMITTED_MARKER,
			resultTruncated: true,
		};
		entryBytes = jsonBytes([key, stub]) + 4;
		if (bytes + entryBytes > maxBytes) break;
		out[key] = stub;
		bytes += entryBytes;
	}
	// `out` foi montado do mais novo para o mais antigo; restaura a ordem de uso.
	return Object.fromEntries(Object.entries(out).reverse());
}

const MESSAGE_LIMITS = [200_000, 50_000, 12_000, 3_000, 800, 200] as const;
const EMPTY_MESSAGE_MARKER = `${OMITTED_MARKER} (mensagem antiga; abra-a no OMP para ver o conteúdo completo)`;

function markMessageEmpty(message: ChatMessage): ChatMessage {
	return {
		...message,
		content: [{ type: "text", text: EMPTY_MESSAGE_MARKER }],
		errorMessage: undefined,
	};
}

export interface CompactedHistory {
	messages: ChatMessage[];
	tools: Record<string, ToolExecution>;
	/** Mensagens mais antigas que não couberam nem na forma mínima. */
	dropped: number;
	truncated: boolean;
}

/**
 * Projeta histórico (mensagens + tool cards) para o orçamento do evento.
 *
 * Ordem de degradação: limite por campo → marca de conteúdo em mensagens
 * antigas → descarte das mais antigas (o OMP continua com o histórico).
 */
export function compactHistory(
	messages: readonly ChatMessage[],
	tools: Record<string, ToolExecution>,
	maxBytes: number = MAX_EVENT_BYTES,
): CompactedHistory {
	// Reserva espaço para metadados do evento/reducer (sequence, generation...).
	const budget = Math.max(1024, maxBytes - Math.min(256 * 1024, Math.floor(maxBytes / 4)));
	for (const limit of MESSAGE_LIMITS) {
		const compacted = messages.map((message) => compactMessage(message, limit).message);
		const compactedTools = compactTools(tools, limit, budget);
		const size = jsonBytes({ messages: compacted, tools: compactedTools });
		if (size <= budget) return { messages: compacted, tools: compactedTools, dropped: 0, truncated: limit !== MESSAGE_LIMITS[0] };
	}
	const minimal = messages.map(markMessageEmpty);
	const minimalTools = compactTools(tools, 200, Math.floor(budget / 4));
	if (jsonBytes({ messages: minimal, tools: minimalTools }) <= budget) {
		return { messages: minimal, tools: minimalTools, dropped: 0, truncated: true };
	}
	// Ainda grande: mantém as mensagens mais recentes que couberem. O orçamento
	// é dividido (mensagens + tool cards) e o resultado é medido de novo.
	const toolsBudget = Math.max(512, Math.floor(budget / 4));
	const perMessage = Math.max(128, jsonBytes(minimal.at(-1) ?? {}) + 1);
	const keep = Math.max(1, Math.floor(Math.max(512, budget - toolsBudget) / perMessage));
	let kept = minimal.slice(Math.max(0, minimal.length - keep));
	let keptTools = compactTools(minimalTools, 200, toolsBudget);
	while (kept.length > 1 && jsonBytes({ messages: kept, tools: keptTools }) > maxBytes) {
		kept = kept.slice(1);
	}
	if (jsonBytes({ messages: kept, tools: keptTools }) > maxBytes) {
		keptTools = {};
		kept = kept.slice(-1);
	}
	return {
		messages: kept,
		tools: keptTools,
		dropped: messages.length - kept.length,
		truncated: true,
	};
}

/** Projeta um snapshot para o orçamento de uma resposta. */
export function compactSnapshot(
	snapshot: SessionSnapshot,
	maxBytes: number = MAX_EVENT_BYTES,
): SessionSnapshot {
	const history = compactHistory(snapshot.state.messages, snapshot.state.tools, maxBytes);
	const base = {
		...snapshot.state,
		messages: history.messages,
		tools: history.tools,
	};
	const remaining = Math.max(0, maxBytes - jsonBytes({ state: base, sessionPath: snapshot.sessionPath }));
	const share = Math.max(8 * 1024, Math.floor(remaining / 6));
	const state: SessionSnapshot["state"] = {
		...base,
		meta: capValue(base.meta, share) as SessionSnapshot["state"]["meta"],
		notices: capValue(base.notices, share) as SessionSnapshot["state"]["notices"],
		stats: capValue(base.stats, share) as SessionSnapshot["state"]["stats"],
		queue: capValue(base.queue, share) as SessionSnapshot["state"]["queue"],
		agents: capValue(base.agents, share) as SessionSnapshot["state"]["agents"],
		pendingDialogs: capValue(base.pendingDialogs, share) as SessionSnapshot["state"]["pendingDialogs"],
	};
	if (jsonBytes({ state, sessionPath: snapshot.sessionPath }) <= maxBytes) {
		return { state, sessionPath: snapshot.sessionPath };
	}
	return {
		state: {
			...base,
			meta: null,
			stats: null,
			agents: [],
			notices: base.notices.slice(-5),
			queue: { steering: [], followUp: [], liveSteered: base.queue.liveSteered },
		},
		sessionPath: snapshot.sessionPath,
	};
}
