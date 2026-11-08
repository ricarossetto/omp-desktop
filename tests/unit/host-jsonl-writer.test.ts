import { describe, expect, test } from "bun:test";
import { JsonlWriter } from "../../src/host/jsonl-writer";
import {
	HOST_CHUNK_KIND,
	HostChunkAssembler,
	type HostChunkEventMeta,
	type HostChunkFrame,
} from "../../src/shared/host-wire";

function collectWriter(): {
	writer: JsonlWriter;
	lines: string[];
	errors: string[];
} {
	const lines: string[] = [];
	const errors: string[] = [];
	const writer = new JsonlWriter(
		(line) => {
			lines.push(line);
			return line.length;
		},
		(message) => errors.push(message),
	);
	return { writer, lines, errors };
}

function parseFrames(lines: readonly string[]): HostChunkFrame[] {
	return lines.map((line) => JSON.parse(line) as HostChunkFrame);
}

function reassemble(frames: readonly HostChunkFrame[]): string | undefined {
	const assembler = new HostChunkAssembler();
	let text: string | undefined;
	for (const frame of frames) {
		const result = assembler.push(frame);
		expect(result.failure).toBeUndefined();
		if (result.assembled) text = result.assembled.text;
	}
	return text;
}

describe("JsonlWriter", () => {
	test("mensagem pequena continua em uma única linha JSONL", async () => {
		const { writer, lines } = collectWriter();
		const message = { kind: "event", workspaceId: "ws", generation: 1, sequence: 1, name: "frame", data: { text: "ação 😀" } };
		writer.write(message);
		await writer.flush();
		expect(lines).toHaveLength(1);
		expect(lines[0]?.endsWith("\n")).toBe(true);
		expect(JSON.parse(lines[0] as string)).toEqual(message);
	});

	test("mensagem grande vira chunks contíguos e remonta idêntica", async () => {
		const { writer, lines } = collectWriter();
		const message = {
			kind: "response",
			id: "h1",
			ok: true,
			data: { text: "😀ação".repeat(250_000) },
		};
		writer.write(message);
		await writer.flush();
		expect(lines.length).toBeGreaterThan(1);
		const frames = parseFrames(lines);
		for (let index = 0; index < frames.length; index++) {
			const frame = frames[index] as HostChunkFrame;
			expect(frame.kind).toBe(HOST_CHUNK_KIND);
			expect(frame.index).toBe(index);
			expect(frame.count).toBe(frames.length);
			expect(frame.responseId).toBe("h1");
			expect(frame.event).toBeUndefined();
		}
		expect(reassemble(frames)).toBe(JSON.stringify(message));
	});

	test("evento grande carrega a identidade e não vira responseId", async () => {
		const { writer, lines } = collectWriter();
		const meta: HostChunkEventMeta = {
			workspaceId: "ws",
			sessionId: "sess",
			generation: 2,
			sequence: 9,
			name: "desktop_history",
		};
		const message = {
			kind: "event",
			workspaceId: meta.workspaceId,
			sessionId: meta.sessionId,
			generation: meta.generation,
			sequence: meta.sequence,
			name: meta.name,
			data: { messages: ["x".repeat(2 * 1024 * 1024)] },
		};
		writer.write(message);
		await writer.flush();
		const frames = parseFrames(lines);
		expect(frames.length).toBeGreaterThan(1);
		for (const frame of frames) {
			expect(frame.responseId).toBeUndefined();
			expect(frame.event).toEqual(meta);
		}
		expect(reassemble(frames)).toBe(JSON.stringify(message));
	});

	test("chunks de mensagens diferentes não se intercalam", async () => {
		const { writer, lines } = collectWriter();
		writer.write({ kind: "response", id: "h1", ok: true, data: "a".repeat(2 * 1024 * 1024) });
		writer.write({ kind: "response", id: "h2", ok: true, data: "b".repeat(2 * 1024 * 1024) });
		await writer.flush();
		const frames = parseFrames(lines);
		const firstEnd = frames.findLastIndex((frame) => frame.responseId === "h1");
		const secondStart = frames.findIndex((frame) => frame.responseId === "h2");
		expect(firstEnd).toBeGreaterThanOrEqual(0);
		expect(secondStart).toBeGreaterThan(firstEnd);
		expect(frames.filter((frame) => frame.responseId === "h1").length).toBeGreaterThan(0);
		expect(frames.filter((frame) => frame.responseId === "h2").length).toBeGreaterThan(0);
	});

	test("respeita o backpressure entre fragmentos", async () => {
		const lines: string[] = [];
		let release: (() => void) | undefined;
		let calls = 0;
		const writer = new JsonlWriter((line) => {
			lines.push(line);
			calls += 1;
			if (calls === 1) {
				const gate = Promise.withResolvers<number>();
				release = () => gate.resolve(line.length);
				return gate.promise;
			}
			return line.length;
		});
		writer.write({ kind: "response", id: "h1", ok: true, data: "x".repeat(2 * 1024 * 1024) });
		await Promise.resolve();
		await Promise.resolve();
		expect(lines).toHaveLength(1);
		expect(release).toBeDefined();
		release?.();
		await writer.flush();
		expect(lines.length).toBeGreaterThan(1);
	});

	test("falha de serialização marca o writer e não escreve", async () => {
		const { writer, lines, errors } = collectWriter();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		writer.write(circular);
		writer.write({ kind: "event", workspaceId: "ws", generation: 1, sequence: 1, name: "x", data: {} });
		await writer.flush();
		expect(lines).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("serializar");
	});
});
