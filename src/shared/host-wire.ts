/**
 * Codec interno do canal JSONL host -> main.
 *
 * Mensagens pequenas continuam em uma única linha JSON (protocolo atual).
 * Mensagens maiores que `HOST_CHUNK_PAYLOAD_BYTES` são divididas em frames
 * `kind:"chunk"` contíguos, cada um com uma fatia do JSON serializado em
 * base64. O cliente remonta os bytes UTF-8 antes de decodificar/parsear, então
 * qualquer conteúdo (inclusive emoji e pares substitutos) atravessa a
 * fronteira dos fragmentos sem perda.
 *
 * O envelope é estrito: id do fluxo, índice, total de fragmentos, total de
 * bytes lógicos e a correlação (id da resposta ou identidade do evento). Não
 * há limite agregado de payload; o limite físico de cada linha JSONL continua
 * valendo.
 */
import { isRecord } from "./session-state";

export const HOST_CHUNK_KIND = "chunk";

/** Bytes UTF-8 por fragmento; mantém cada linha física bem abaixo de 64 MiB. */
export const HOST_CHUNK_PAYLOAD_BYTES = 1024 * 1024;

export interface HostChunkEventMeta {
	workspaceId: string;
	sessionId?: string;
	generation: number;
	sequence: number;
	name: string;
}

export interface HostChunkFrame {
	kind: typeof HOST_CHUNK_KIND;
	/** Identificador único do fluxo de fragmentos. */
	id: string;
	/** Índice do fragmento, começando em 0. */
	index: number;
	/** Total de fragmentos da mensagem. */
	count: number;
	/** Total de bytes UTF-8 da mensagem completa. */
	bytes: number;
	/** Id da resposta correlacionada; ausente em eventos. */
	responseId?: string;
	/** Identidade do evento correlacionado; ausente em respostas. */
	event?: HostChunkEventMeta;
	/** Fatia de bytes da mensagem em base64. */
	data: string;
}

export type HostChunkFailureReason =
	| "invalid-frame"
	| "orphan-chunk"
	| "unexpected-index"
	| "stream-mismatch"
	| "duplicate-stream"
	| "invalid-base64"
	| "invalid-utf8"
	| "bytes-mismatch";

export interface HostChunkFailure {
	id?: string;
	responseId?: string;
	event?: HostChunkEventMeta;
	reason: HostChunkFailureReason;
	detail: string;
}

export type HostChunkParseResult =
	| { ok: true; frame: HostChunkFrame }
	| { ok: false; failure: HostChunkFailure };

export interface AssembledHostChunk {
	id: string;
	responseId?: string;
	event?: HostChunkEventMeta;
	/** JSON original remontado e decodificado como UTF-8. */
	text: string;
}

export interface HostChunkPushResult {
	assembled?: AssembledHostChunk;
	failure?: HostChunkFailure;
}

interface ChunkStream {
	id: string;
	count: number;
	bytes: number;
	responseId?: string;
	event?: HostChunkEventMeta;
	nextIndex: number;
	parts: Buffer[];
	receivedBytes: number;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_ID_CHARS = 256;

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;
}

function isSafeInteger(value: unknown, minimum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function parseEventMeta(value: unknown): HostChunkEventMeta | undefined {
	if (!isRecord(value)) return undefined;
	const workspaceId = value.workspaceId;
	const sessionId = value.sessionId;
	const generation = value.generation;
	const sequence = value.sequence;
	const name = value.name;
	if (!isIdentifier(workspaceId)) return undefined;
	if (sessionId !== undefined && !isIdentifier(sessionId)) return undefined;
	if (typeof generation !== "number" || !Number.isFinite(generation)) return undefined;
	if (typeof sequence !== "number" || !Number.isFinite(sequence)) return undefined;
	if (!isIdentifier(name)) return undefined;
	return {
		workspaceId,
		...(sessionId !== undefined ? { sessionId } : {}),
		generation,
		sequence,
		name,
	};
}

function invalid(failure: HostChunkFailure): HostChunkParseResult {
	return { ok: false, failure };
}

/**
 * Valida o envelope de um fragmento. Campos desconhecidos são ignorados, mas
 * todo campo conhecido precisa ter o tipo/faixa corretos.
 */
export function parseHostChunkFrame(value: unknown): HostChunkParseResult {
	if (!isRecord(value)) {
		return invalid({ reason: "invalid-frame", detail: "o fragmento não é um objeto JSON." });
	}
	const id = isIdentifier(value.id) ? value.id : undefined;
	const responseId = isIdentifier(value.responseId) ? value.responseId : undefined;
	const event = parseEventMeta(value.event);
	if (value.kind !== HOST_CHUNK_KIND) {
		return invalid({ id, responseId, event, reason: "invalid-frame", detail: 'kind diferente de "chunk".' });
	}
	if (!id) {
		return invalid({ responseId, event, reason: "invalid-frame", detail: "id do fluxo ausente ou inválido." });
	}
	const index = value.index;
	const count = value.count;
	const bytes = value.bytes;
	if (!isSafeInteger(index, 0)) {
		return invalid({ id, responseId, event, reason: "invalid-frame", detail: "index ausente ou inválido." });
	}
	if (!isSafeInteger(count, 1)) {
		return invalid({ id, responseId, event, reason: "invalid-frame", detail: "count ausente ou inválido." });
	}
	if (index >= count) {
		return invalid({
			id,
			responseId,
			event,
			reason: "invalid-frame",
			detail: `index ${index} não é menor que count ${count}.`,
		});
	}
	if (!isSafeInteger(bytes, 1)) {
		return invalid({ id, responseId, event, reason: "invalid-frame", detail: "bytes ausente ou inválido." });
	}
	if (value.responseId !== undefined && !responseId) {
		return invalid({ id, event, reason: "invalid-frame", detail: "responseId inválido." });
	}
	if (value.event !== undefined && !event) {
		return invalid({ id, responseId, reason: "invalid-frame", detail: "event inválido." });
	}
	if (responseId && event) {
		return invalid({
			id,
			reason: "invalid-frame",
			detail: "fragmento não pode ter responseId e event ao mesmo tempo.",
		});
	}
	const data = value.data;
	if (typeof data !== "string" || data.length === 0) {
		return invalid({ id, responseId, event, reason: "invalid-frame", detail: "data ausente ou vazio." });
	}
	if (data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) {
		return invalid({ id, responseId, event, reason: "invalid-frame", detail: "data não é base64 canônico." });
	}
	return {
		ok: true,
		frame: {
			kind: HOST_CHUNK_KIND,
			id,
			index,
			count,
			bytes,
			...(responseId ? { responseId } : {}),
			...(event ? { event } : {}),
			data,
		},
	};
}

function failureFor(stream: ChunkStream, reason: HostChunkFailureReason, detail: string): HostChunkFailure {
	return {
		id: stream.id,
		responseId: stream.responseId,
		event: stream.event,
		reason,
		detail,
	};
}

function sameEvent(left: HostChunkEventMeta | undefined, right: HostChunkEventMeta | undefined): boolean {
	if (!left || !right) return left === right;
	return (
		left.workspaceId === right.workspaceId &&
		left.sessionId === right.sessionId &&
		left.generation === right.generation &&
		left.sequence === right.sequence &&
		left.name === right.name
	);
}

/**
 * Remonta fragmentos por `id`. Fluxos diferentes podem se intercalar; dentro de
 * um fluxo os índices precisam ser contíguos. Qualquer violação remove o fluxo
 * da memória e devolve uma falha explícita — nunca entrega texto parcial.
 */
export class HostChunkAssembler {
	private readonly streams = new Map<string, ChunkStream>();

	push(frame: HostChunkFrame): HostChunkPushResult {
		const existing = this.streams.get(frame.id);
		if (frame.index === 0) {
			if (existing) {
				this.streams.delete(frame.id);
				return {
					failure: failureFor(
						existing,
						"duplicate-stream",
						`novo índice 0 para o fluxo "${frame.id}" antes de completar ${existing.count} fragmentos.`,
					),
				};
			}
			const stream: ChunkStream = {
				id: frame.id,
				count: frame.count,
				bytes: frame.bytes,
				responseId: frame.responseId,
				event: frame.event,
				nextIndex: 0,
				parts: [],
				receivedBytes: 0,
			};
			this.streams.set(frame.id, stream);
			return this.append(stream, frame);
		}
		if (!existing) {
			return {
				failure: {
					id: frame.id,
					responseId: frame.responseId,
					event: frame.event,
					reason: "orphan-chunk",
					detail: `fragmento ${frame.index} sem o fragmento 0 do fluxo "${frame.id}".`,
				},
			};
		}
		if (
			existing.count !== frame.count ||
			existing.bytes !== frame.bytes ||
			existing.responseId !== frame.responseId ||
			!sameEvent(existing.event, frame.event)
		) {
			this.streams.delete(frame.id);
			return {
				failure: failureFor(
					existing,
					"stream-mismatch",
					`metadados divergentes no fragmento ${frame.index} do fluxo "${frame.id}".`,
				),
			};
		}
		if (frame.index !== existing.nextIndex) {
			this.streams.delete(frame.id);
			return {
				failure: failureFor(
					existing,
					"unexpected-index",
					`esperado fragmento ${existing.nextIndex} do fluxo "${frame.id}", recebido ${frame.index}.`,
				),
			};
		}
		return this.append(existing, frame);
	}

	private append(stream: ChunkStream, frame: HostChunkFrame): HostChunkPushResult {
		const decoded = Buffer.from(frame.data, "base64");
		if (decoded.length === 0) {
			this.streams.delete(stream.id);
			return { failure: failureFor(stream, "invalid-base64", "fragmento decodificou para zero bytes.") };
		}
		if (stream.receivedBytes + decoded.length > stream.bytes) {
			this.streams.delete(stream.id);
			return {
				failure: failureFor(
					stream,
					"bytes-mismatch",
					`fragmento ${frame.index} excede os ${stream.bytes} bytes declarados.`,
				),
			};
		}
		stream.parts.push(decoded);
		stream.receivedBytes += decoded.length;
		stream.nextIndex += 1;
		if (stream.nextIndex < stream.count) return {};
		if (stream.receivedBytes !== stream.bytes) {
			this.streams.delete(stream.id);
			return {
				failure: failureFor(
					stream,
					"bytes-mismatch",
					`recebidos ${stream.receivedBytes} bytes, esperados ${stream.bytes}.`,
				),
			};
		}
		const complete =
			stream.parts.length === 1
				? (stream.parts[0] as Buffer)
				: Buffer.concat(stream.parts, stream.receivedBytes);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(complete);
		} catch {
			this.streams.delete(stream.id);
			return { failure: failureFor(stream, "invalid-utf8", "bytes remontados não são UTF-8 válido.") };
		}
		this.streams.delete(stream.id);
		return {
			assembled: {
				id: stream.id,
				...(stream.responseId ? { responseId: stream.responseId } : {}),
				...(stream.event ? { event: stream.event } : {}),
				text,
			},
		};
	}

	/** Remove um fluxo por id (ex.: linha física descartada). */
	dropById(id: string): void {
		this.streams.delete(id);
	}

	/** Identidade do evento de um fluxo ativo, se houver. */
	eventOf(id: string): HostChunkEventMeta | undefined {
		return this.streams.get(id)?.event;
	}

	/** Remove fluxos correlacionados a uma resposta (timeout/erro/exit). */
	dropResponse(responseId: string): void {
		for (const [id, stream] of this.streams) {
			if (stream.responseId === responseId) this.streams.delete(id);
		}
	}

	clear(): void {
		this.streams.clear();
	}

	get pendingStreams(): number {
		return this.streams.size;
	}

	get pendingBytes(): number {
		let total = 0;
		for (const stream of this.streams.values()) total += stream.receivedBytes;
		return total;
	}
}
