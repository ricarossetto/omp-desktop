import { describe, expect, test } from "bun:test";
import {
	HOST_CHUNK_KIND,
	HostChunkAssembler,
	parseHostChunkFrame,
	type AssembledHostChunk,
	type HostChunkEventMeta,
	type HostChunkFailure,
	type HostChunkFrame,
} from "../../src/shared/host-wire";

const EVENT: HostChunkEventMeta = {
	workspaceId: "ws-1",
	sessionId: "sess-1",
	generation: 3,
	sequence: 42,
	name: "desktop_history",
};

function buildFrames(
	text: string,
	options: {
		id?: string;
		chunkBytes?: number;
		responseId?: string;
		event?: HostChunkEventMeta;
		bytesDelta?: number;
	} = {},
): HostChunkFrame[] {
	const id = options.id ?? "c1";
	const chunkBytes = options.chunkBytes ?? 7;
	const bytes = Buffer.from(text, "utf8");
	const count = Math.max(1, Math.ceil(bytes.length / chunkBytes));
	const frames: HostChunkFrame[] = [];
	for (let index = 0; index < count; index++) {
		const start = index * chunkBytes;
		const end = Math.min(start + chunkBytes, bytes.length);
		frames.push({
			kind: HOST_CHUNK_KIND,
			id,
			index,
			count,
			bytes: bytes.length + (options.bytesDelta ?? 0),
			...(options.responseId ? { responseId: options.responseId } : {}),
			...(options.event ? { event: options.event } : {}),
			data: bytes.subarray(start, end).toString("base64"),
		});
	}
	return frames;
}

function assemble(frames: readonly HostChunkFrame[]): {
	text?: string;
	failure?: HostChunkFailure;
	assembled?: AssembledHostChunk;
} {
	const assembler = new HostChunkAssembler();
	let text: string | undefined;
	let assembled: AssembledHostChunk | undefined;
	let failure: HostChunkFailure | undefined;
	for (const frame of frames) {
		const result = assembler.push(frame);
		if (result.failure) failure = result.failure;
		if (result.assembled) {
			assembled = result.assembled;
			text = result.assembled.text;
		}
	}
	return { text, failure, assembled };
}

describe("parseHostChunkFrame", () => {
	test("aceita frame de resposta e frame de evento", () => {
		const response = buildFrames("resposta", { responseId: "h7" })[0] as HostChunkFrame;
		const parsedResponse = parseHostChunkFrame(response);
		expect(parsedResponse.ok).toBe(true);
		if (parsedResponse.ok) {
			expect(parsedResponse.frame.responseId).toBe("h7");
			expect(parsedResponse.frame.event).toBeUndefined();
		}

		const event = buildFrames("evento", { event: EVENT })[0] as HostChunkFrame;
		const parsedEvent = parseHostChunkFrame(event);
		expect(parsedEvent.ok).toBe(true);
		if (parsedEvent.ok) {
			expect(parsedEvent.frame.event).toEqual(EVENT);
			expect(parsedEvent.frame.responseId).toBeUndefined();
		}
	});

	test("rejeita campos fora do envelope estrito", () => {
		const base = buildFrames("conteúdo", { responseId: "h1" })[0] as HostChunkFrame;
		const invalids: unknown[] = [
			null,
			[],
			{ ...base, kind: "event" },
			{ ...base, id: "" },
			{ ...base, index: -1 },
			{ ...base, count: 0 },
			{ ...base, index: 2, count: 2 },
			{ ...base, bytes: 0 },
			{ ...base, data: "" },
			{ ...base, data: "%%%=" },
			{ ...base, responseId: 7 },
			{ ...base, event: { workspaceId: "ws" } },
			{ ...base, event: EVENT },
		];
		for (const value of invalids) {
			expect(parseHostChunkFrame(value).ok).toBe(false);
		}
	});

	test("ignora campos desconhecidos", () => {
		const frame = { ...(buildFrames("ok")[0] as HostChunkFrame), extra: true };
		const parsed = parseHostChunkFrame(frame);
		expect(parsed.ok).toBe(true);
	});
});

describe("HostChunkAssembler", () => {
	test("remonta UTF-8 e emoji mesmo cortando no meio de um par substituto", () => {
		const text = JSON.stringify({ text: "ação 😀🚀 fim", nested: { emoji: "👩‍💻" } });
		const frames = buildFrames(text, { chunkBytes: 3 });
		const result = assemble(frames);
		expect(result.failure).toBeUndefined();
		expect(result.text).toBe(text);
	});

	test("preserva a identidade do evento remontado", () => {
		const text = JSON.stringify({
			kind: "event",
			workspaceId: EVENT.workspaceId,
			sessionId: EVENT.sessionId,
			generation: EVENT.generation,
			sequence: EVENT.sequence,
			name: EVENT.name,
			data: { messages: ["😀"] },
		});
		const result = assemble(buildFrames(text, { event: EVENT, chunkBytes: 5 }));
		expect(result.failure).toBeUndefined();
		expect(result.assembled?.event).toEqual(EVENT);
		expect(result.text).toBe(text);
	});

	test("intercala fluxos diferentes sem trocar bytes", () => {
		const textA = JSON.stringify({ stream: "a", text: "ação 😀" });
		const textB = JSON.stringify({ stream: "b", text: "🚀 fim" });
		const framesA = buildFrames(textA, { id: "ca", chunkBytes: 3, responseId: "ha" });
		const framesB = buildFrames(textB, { id: "cb", chunkBytes: 4, responseId: "hb" });
		const assembler = new HostChunkAssembler();
		const assembled = new Map<string, string>();
		const max = Math.max(framesA.length, framesB.length);
		for (let index = 0; index < max; index++) {
			for (const frame of [framesA[index], framesB[index]]) {
				if (!frame) continue;
				const result = assembler.push(frame);
				expect(result.failure).toBeUndefined();
				if (result.assembled) assembled.set(result.assembled.id, result.assembled.text);
			}
		}
		expect(assembled.get("ca")).toBe(textA);
		expect(assembled.get("cb")).toBe(textB);
		expect(assembler.pendingStreams).toBe(0);
	});

	test("índice fora de ordem falha, limpa o fluxo e não entrega parcial", () => {
		const frames = buildFrames("abcdefghij", { chunkBytes: 3, responseId: "h1" });
		const assembler = new HostChunkAssembler();
		expect(assembler.push(frames[0] as HostChunkFrame).failure).toBeUndefined();
		const failure = assembler.push(frames[2] as HostChunkFrame).failure;
		expect(failure?.reason).toBe("unexpected-index");
		expect(failure?.responseId).toBe("h1");
		expect(assembler.pendingStreams).toBe(0);
	});

	test("bytes declarados divergentes falham no fechamento", () => {
		const frames = buildFrames("abcdef", { chunkBytes: 4, bytesDelta: 1 });
		const result = assemble(frames);
		expect(result.failure?.reason).toBe("bytes-mismatch");
		expect(result.text).toBeUndefined();
	});

	test("metadados divergentes entre fragmentos falham", () => {
		const frames = buildFrames("abcdefgh", { chunkBytes: 4, responseId: "h1" });
		const assembler = new HostChunkAssembler();
		expect(assembler.push(frames[0] as HostChunkFrame).failure).toBeUndefined();
		const failure = assembler.push({
			...(frames[1] as HostChunkFrame),
			count: (frames[1] as HostChunkFrame).count + 1,
		}).failure;
		expect(failure?.reason).toBe("stream-mismatch");
		expect(assembler.pendingStreams).toBe(0);
	});

	test("evento divergente entre fragmentos falha", () => {
		const frames = buildFrames("abcdefgh", { chunkBytes: 4, event: EVENT });
		const assembler = new HostChunkAssembler();
		expect(assembler.push(frames[0] as HostChunkFrame).failure).toBeUndefined();
		const failure = assembler.push({
			...(frames[1] as HostChunkFrame),
			event: { ...EVENT, sequence: EVENT.sequence + 1 },
		}).failure;
		expect(failure?.reason).toBe("stream-mismatch");
		expect(failure?.event).toEqual(EVENT);
	});

	test("chunk órfão não cria fluxo", () => {
		const frames = buildFrames("abcdef", { chunkBytes: 3, responseId: "h1" });
		const assembler = new HostChunkAssembler();
		const failure = assembler.push(frames[1] as HostChunkFrame).failure;
		expect(failure?.reason).toBe("orphan-chunk");
		expect(failure?.responseId).toBe("h1");
		expect(assembler.pendingStreams).toBe(0);
	});

	test("novo índice 0 com id ativo falha o fluxo anterior", () => {
		const frames = buildFrames("abcdef", { chunkBytes: 3 });
		const assembler = new HostChunkAssembler();
		expect(assembler.push(frames[0] as HostChunkFrame).failure).toBeUndefined();
		const failure = assembler.push(frames[0] as HostChunkFrame).failure;
		expect(failure?.reason).toBe("duplicate-stream");
		expect(assembler.pendingStreams).toBe(0);
	});

	test("base64 inválido falha e limpa o fluxo", () => {
		const frame = buildFrames("abc")[0] as HostChunkFrame;
		const assembler = new HostChunkAssembler();
		const failure = assembler.push({ ...frame, data: "AAAA" }).failure;
		expect(failure).toBeUndefined();
		expect(assembler.pendingStreams).toBe(0);

		const invalid = new HostChunkAssembler();
		const invalidFailure = invalid.push({ ...frame, data: "====" }).failure;
		expect(invalidFailure?.reason).toBe("invalid-base64");
		expect(invalid.pendingStreams).toBe(0);
	});

	test("UTF-8 inválido falha em vez de substituir", () => {
		const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
		const frame: HostChunkFrame = {
			kind: HOST_CHUNK_KIND,
			id: "c1",
			index: 0,
			count: 1,
			bytes: bytes.length,
			data: bytes.toString("base64"),
		};
		const assembler = new HostChunkAssembler();
		const failure = assembler.push(frame).failure;
		expect(failure?.reason).toBe("invalid-utf8");
		expect(assembler.pendingStreams).toBe(0);
	});

	test("dropResponse remove só o fluxo correlacionado", () => {
		const framesA = buildFrames("abcdef", { id: "ca", chunkBytes: 3, responseId: "ha" });
		const framesB = buildFrames("ghijkl", { id: "cb", chunkBytes: 3, responseId: "hb" });
		const assembler = new HostChunkAssembler();
		assembler.push(framesA[0] as HostChunkFrame);
		assembler.push(framesB[0] as HostChunkFrame);
		expect(assembler.pendingStreams).toBe(2);
		assembler.dropResponse("ha");
		expect(assembler.pendingStreams).toBe(1);
		assembler.clear();
		expect(assembler.pendingStreams).toBe(0);
	});
});
