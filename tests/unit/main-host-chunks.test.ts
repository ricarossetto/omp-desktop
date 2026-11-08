import { describe, expect, test, vi } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { HostClient, type HostProcessLike, type HostSpawn } from "../../src/main/host-client";
import type { DesktopEvent } from "../../src/shared/contracts";
import type { HostChunkEventMeta, HostChunkFrame } from "../../src/shared/host-wire";

class FakeChild implements HostProcessLike {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly written: string[] = [];
	killCalls = 0;
	private readonly emitter = new EventEmitter();
	constructor(readonly pid = 0) {
		this.stdin.on("data", (chunk: Buffer | string) => this.written.push(chunk.toString()));
		this.stdin.on("finish", () => this.emitExit(0));
	}
	on(event: string, listener: (...args: never[]) => void): unknown {
		this.emitter.on(event, listener as (...args: unknown[]) => void);
		return this;
	}
	kill(): boolean {
		this.killCalls += 1;
		return true;
	}
	emitExit(code: number | null): void {
		this.emitter.emit("exit", code, null);
	}
	lastRequest(): { id: string; op: string; payload: unknown } {
		const line = this.written.at(-1) ?? "";
		return JSON.parse(line) as { id: string; op: string; payload: unknown };
	}
}

function createClient(
	onEvent: (event: DesktopEvent) => void = () => undefined,
	maxLineBytes?: number,
): { client: HostClient; child: FakeChild } {
	const child = new FakeChild();
	const spawn: HostSpawn = () => child;
	const client = new HostClient({
		bunPath: "bun",
		hostScript: "host.js",
		spawnImpl: spawn,
		onEvent,
		onExit: () => undefined,
		requestTimeoutMs: 5000,
		maxLineBytes,
	});
	return { client, child };
}

function chunkLines(
	text: string,
	options: {
		id: string;
		chunkBytes?: number;
		responseId?: string;
		event?: HostChunkEventMeta;
	},
): string[] {
	const bytes = Buffer.from(text, "utf8");
	const chunkBytes = options.chunkBytes ?? 1024 * 1024;
	const count = Math.max(1, Math.ceil(bytes.length / chunkBytes));
	const lines: string[] = [];
	for (let index = 0; index < count; index++) {
		const start = index * chunkBytes;
		const end = Math.min(start + chunkBytes, bytes.length);
		const frame: HostChunkFrame = {
			kind: "chunk",
			id: options.id,
			index,
			count,
			bytes: bytes.length,
			...(options.responseId ? { responseId: options.responseId } : {}),
			...(options.event ? { event: options.event } : {}),
			data: bytes.subarray(start, end).toString("base64"),
		};
		lines.push(`${JSON.stringify(frame)}\n`);
	}
	return lines;
}

function firstMessageText(event: DesktopEvent): string | undefined {
	const data = event.data;
	if (typeof data !== "object" || data === null || !("messages" in data)) return undefined;
	const messages = data.messages;
	if (!Array.isArray(messages)) return undefined;
	const first = messages[0];
	if (typeof first !== "object" || first === null || !("text" in first)) return undefined;
	return typeof first.text === "string" ? first.text : undefined;
}

describe("HostClient com fragmentos", () => {
	test("recompõe resposta fragmentada acima de 8 MiB e resolve uma vez", async () => {
		const { client, child } = createClient();
		await client.start();
		const pending = client.request<string>("session.snapshot", {});
		const request = child.lastRequest();
		const big = `${"a".repeat(4 * 1024 * 1024)}😀${"b".repeat(4 * 1024 * 1024)}`;
		const text = JSON.stringify({ kind: "response", id: request.id, ok: true, data: big });
		const lines = chunkLines(text, { id: "c1", responseId: request.id });
		expect(lines.length).toBeGreaterThan(8);
		for (const line of lines) child.stdout.write(line);
		expect(await pending).toBe(big);
		expect(client.running).toBe(true);
	});

	test("recompõe evento fragmentado acima de 8 MiB e entrega completo", async () => {
		const events: DesktopEvent[] = [];
		const first = Promise.withResolvers<DesktopEvent>();
		const { client, child } = createClient((event) => {
			events.push(event);
			first.resolve(event);
		});
		await client.start();
		const big = "😀".repeat(2_200_000);
		const meta: HostChunkEventMeta = {
			workspaceId: "ws",
			sessionId: "sess",
			generation: 1,
			sequence: 7,
			name: "desktop_history",
		};
		const event = { kind: "event", ...meta, data: { messages: [{ text: big }] } };
		const lines = chunkLines(JSON.stringify(event), { id: "ce", event: meta });
		expect(lines.length).toBeGreaterThan(8);
		for (const line of lines) child.stdout.write(line);
		const delivered = await first.promise;
		expect(events).toHaveLength(1);
		expect(delivered.name).toBe("desktop_history");
		expect(firstMessageText(delivered)).toBe(big);
	});

	test("intercala duas respostas fragmentadas sem trocar dados", async () => {
		const { client, child } = createClient();
		await client.start();
		const first = client.request<string>("a", {});
		const firstRequest = child.lastRequest();
		const second = client.request<string>("b", {});
		const secondRequest = child.lastRequest();
		const textA = JSON.stringify({ kind: "response", id: firstRequest.id, ok: true, data: "A".repeat(3000) });
		const textB = JSON.stringify({ kind: "response", id: secondRequest.id, ok: true, data: "B".repeat(3000) });
		const linesA = chunkLines(textA, { id: "ca", chunkBytes: 100, responseId: firstRequest.id });
		const linesB = chunkLines(textB, { id: "cb", chunkBytes: 100, responseId: secondRequest.id });
		const max = Math.max(linesA.length, linesB.length);
		for (let index = 0; index < max; index++) {
			if (linesA[index]) child.stdout.write(linesA[index] as string);
			if (linesB[index]) child.stdout.write(linesB[index] as string);
		}
		expect(await first).toBe("A".repeat(3000));
		expect(await second).toBe("B".repeat(3000));
	});

	test("não resolve a request antes do último fragmento", async () => {
		const { client, child } = createClient();
		await client.start();
		const pending = client.request<string>("session.snapshot", {});
		const request = child.lastRequest();
		const text = JSON.stringify({ kind: "response", id: request.id, ok: true, data: "x".repeat(500) });
		const lines = chunkLines(text, { id: "c1", chunkBytes: 100, responseId: request.id });
		let settled = false;
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		for (const line of lines.slice(0, -1)) child.stdout.write(line);
		await Promise.resolve();
		expect(settled).toBe(false);
		child.stdout.write(lines.at(-1) as string);
		expect(await pending).toBe("x".repeat(500));
	});

	test("sequência fora de ordem rejeita a request correlacionada e mantém o host vivo", async () => {
		const { client, child } = createClient();
		await client.start();
		const pending = client.request<string>("session.snapshot", {});
		const request = child.lastRequest();
		const text = JSON.stringify({ kind: "response", id: request.id, ok: true, data: "x".repeat(500) });
		const lines = chunkLines(text, { id: "c1", chunkBytes: 100, responseId: request.id });
		child.stdout.write(lines[0] as string);
		child.stdout.write(lines[2] as string);
		await expect(pending).rejects.toMatchObject({ code: "INTERNAL" });
		expect(client.running).toBe(true);

		const next = client.request<string>("workspace.list", {});
		const nextRequest = child.lastRequest();
		child.stdout.write(`${JSON.stringify({ kind: "response", id: nextRequest.id, ok: true, data: "ok" })}\n`);
		expect(await next).toBe("ok");
	});

	test("resposta fragmentada com id divergente não resolve a request", async () => {
		const { client, child } = createClient();
		await client.start();
		const pending = client.request<string>("session.snapshot", {});
		const request = child.lastRequest();
		const text = JSON.stringify({ kind: "response", id: "outra", ok: true, data: "x" });
		const lines = chunkLines(text, { id: "c1", chunkBytes: 10, responseId: request.id });
		for (const line of lines) child.stdout.write(line);
		await expect(pending).rejects.toMatchObject({ code: "INTERNAL" });
	});

	test("host exit limpa fragmentos incompletos e rejeita pendências", async () => {
		const events: DesktopEvent[] = [];
		const { client, child } = createClient((event) => events.push(event));
		await client.start();
		const pending = client.request<string>("session.snapshot", {});
		const request = child.lastRequest();
		const text = JSON.stringify({ kind: "response", id: request.id, ok: true, data: "x".repeat(500) });
		const lines = chunkLines(text, { id: "c1", chunkBytes: 100, responseId: request.id });
		child.stdout.write(lines[0] as string);
		child.emitExit(1);
		await expect(pending).rejects.toMatchObject({ code: "HOST_EXITED" });
		expect(client.running).toBe(false);
		expect(events).toHaveLength(0);
	});

	test("timeout de request descarta o payload parcial sem entregar", async () => {
		const events: DesktopEvent[] = [];
		const { client, child } = createClient((event) => events.push(event));
		await client.start();
		vi.useFakeTimers();
		try {
			const pending = client.request<string>("session.snapshot", {}, { timeoutMs: 20 });
			const request = child.lastRequest();
			const text = JSON.stringify({ kind: "response", id: request.id, ok: true, data: "x".repeat(500) });
			const lines = chunkLines(text, { id: "c1", chunkBytes: 100, responseId: request.id });
			child.stdout.write(lines[0] as string);
			vi.advanceTimersByTime(25);
			await expect(pending).rejects.toMatchObject({ code: "INTERNAL" });
			for (const line of lines.slice(1)) child.stdout.write(line);
			await Promise.resolve();
			expect(events).toHaveLength(0);
			expect(client.running).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	test("base64 inválido falha a request correlacionada", async () => {
		const { client, child } = createClient();
		await client.start();
		const pending = client.request<string>("session.snapshot", {});
		const request = child.lastRequest();
		child.stdout.write(
			`${JSON.stringify({
				kind: "chunk",
				id: "c1",
				index: 0,
				count: 1,
				bytes: 3,
				responseId: request.id,
				data: "!!!!",
			})}\n`,
		);
		await expect(pending).rejects.toMatchObject({ code: "INTERNAL" });
	});

	test("fragmento acima do limite físico falha a request correlacionada", async () => {
		const { client, child } = createClient(undefined, 256);
		await client.start();
		const pending = client.request<string>("session.snapshot", {});
		const request = child.lastRequest();
		const text = JSON.stringify({ kind: "response", id: request.id, ok: true, data: "x".repeat(1000) });
		const lines = chunkLines(text, { id: "c1", chunkBytes: 100, responseId: request.id });
		child.stdout.write(lines[0] as string);
		const oversized = `${JSON.stringify({
			kind: "chunk",
			id: "c1",
			index: 1,
			count: lines.length,
			bytes: Buffer.byteLength(text),
			responseId: request.id,
			data: Buffer.alloc(1000, 0x61).toString("base64"),
		})}\n`;
		child.stdout.write(oversized);
		await expect(pending).rejects.toMatchObject({ code: "FRAME_TOO_LARGE" });
		expect(client.running).toBe(true);
	});

	test("fragmento de evento acima do limite físico sinaliza resync", async () => {
		const events: DesktopEvent[] = [];
		const { client, child } = createClient((event) => events.push(event), 256);
		await client.start();
		const meta: HostChunkEventMeta = {
			workspaceId: "ws",
			sessionId: "sess",
			generation: 1,
			sequence: 5,
			name: "desktop_history",
		};
		const oversized = `${JSON.stringify({
			kind: "chunk",
			id: "ce",
			index: 0,
			count: 2,
			bytes: 2000,
			event: meta,
			data: Buffer.alloc(1000, 0x61).toString("base64"),
		})}\n`;
		child.stdout.write(oversized);
		await Promise.resolve();
		expect(events).toHaveLength(1);
		expect(events[0]?.name).toBe("wire.resync");
		expect(events[0]?.workspaceId).toBe("ws");
		expect(events[0]?.sessionId).toBe("sess");
		expect(events[0]?.sequence).toBe(6);
	});

	test("evento fragmentado incompleto sinaliza resync uma vez e não entrega parcial", async () => {
		const events: DesktopEvent[] = [];
		const { client, child } = createClient((event) => events.push(event));
		await client.start();
		const meta: HostChunkEventMeta = {
			workspaceId: "ws",
			sessionId: "sess",
			generation: 1,
			sequence: 5,
			name: "desktop_history",
		};
		const text = JSON.stringify({ kind: "event", ...meta, data: { messages: ["x".repeat(500)] } });
		const lines = chunkLines(text, { id: "ce", chunkBytes: 100, event: meta });
		child.stdout.write(lines[0] as string);
		child.stdout.write(lines[2] as string);
		await Promise.resolve();
		expect(client.pendingChunkStreams).toBe(0);
		expect(events).toHaveLength(1);
		expect(events[0]?.name).toBe("wire.resync");
		expect(events[0]?.workspaceId).toBe("ws");
		expect(events[0]?.sessionId).toBe("sess");
		expect(events[0]?.sequence).toBe(6);
		for (const line of lines.slice(3)) child.stdout.write(line);
		await Promise.resolve();
		expect(events).toHaveLength(1);
	});

	test("evento incompleto expira, libera memória e sinaliza resync", async () => {
		const events: DesktopEvent[] = [];
		const { client, child } = createClient((event) => events.push(event));
		await client.start();
		vi.useFakeTimers();
		try {
			const meta: HostChunkEventMeta = {
				workspaceId: "ws",
				sessionId: "sess",
				generation: 1,
				sequence: 5,
				name: "desktop_history",
			};
			const text = JSON.stringify({ kind: "event", ...meta, data: { messages: ["x".repeat(500)] } });
			const lines = chunkLines(text, { id: "ce", chunkBytes: 100, event: meta });
			child.stdout.write(lines[0] as string);
			await Promise.resolve();
			expect(client.pendingChunkStreams).toBe(1);
			expect(client.pendingChunkBytes).toBeGreaterThan(0);
			expect(events).toHaveLength(0);

			vi.advanceTimersByTime(5000);
			await Promise.resolve();
			expect(client.pendingChunkStreams).toBe(0);
			expect(client.pendingChunkBytes).toBe(0);
			expect(events).toHaveLength(1);
			expect(events[0]?.name).toBe("wire.resync");
			expect(events[0]?.sequence).toBe(6);

			// O fluxo retoma depois do deadline: os fragmentos restantes não
			// remontam nem entregam o evento perdido.
			for (const line of lines.slice(1)) child.stdout.write(line);
			await Promise.resolve();
			expect(client.pendingChunkStreams).toBe(0);
			expect(events).toHaveLength(1);

			// O cliente continua funcional para o próximo evento.
			const nextMeta: HostChunkEventMeta = { ...meta, sequence: 7 };
			const nextText = JSON.stringify({ kind: "event", ...nextMeta, data: { messages: ["ok"] } });
			for (const line of chunkLines(nextText, { id: "cf", event: nextMeta })) child.stdout.write(line);
			await Promise.resolve();
			expect(client.pendingChunkStreams).toBe(0);
			expect(events).toHaveLength(2);
			expect(events[1]?.name).toBe("desktop_history");
			expect(events[1]?.sequence).toBe(7);
		} finally {
			vi.useRealTimers();
		}
	});

	test("evento remontado com identidade divergente sinaliza resync", async () => {
		const events: DesktopEvent[] = [];
		const { client, child } = createClient((event) => events.push(event));
		await client.start();
		const meta: HostChunkEventMeta = {
			workspaceId: "ws",
			sessionId: "sess",
			generation: 1,
			sequence: 5,
			name: "desktop_history",
		};
		const text = JSON.stringify({
			kind: "event",
			workspaceId: "ws",
			sessionId: "sess",
			generation: 1,
			sequence: 6,
			name: "desktop_history",
			data: {},
		});
		const lines = chunkLines(text, { id: "ce", chunkBytes: 10, event: meta });
		for (const line of lines) child.stdout.write(line);
		await Promise.resolve();
		expect(events).toHaveLength(1);
		expect(events[0]?.name).toBe("wire.resync");
		expect(events[0]?.sequence).toBe(6);
	});

	test("mensagem pequena continua resolvendo pelo caminho de uma linha", async () => {
		const { client, child } = createClient();
		await client.start();
		const pending = client.request<string>("workspace.list", {});
		const request = child.lastRequest();
		child.stdout.write(`${JSON.stringify({ kind: "response", id: request.id, ok: true, data: "ok" })}\n`);
		expect(await pending).toBe("ok");
	});
});
