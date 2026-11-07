import { describe, expect, test, vi } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
	buildHostEnv,
	HostClient,
	JsonlLineDecoder,
	redactLogLine,
	type HostProcessLike,
	type HostSpawn,
} from "../../src/main/host-client";
import type { DesktopEvent } from "../../src/shared/contracts";

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
	respond(id: string, data: unknown, ok = true): void {
		this.stdout.write(
			`${JSON.stringify(ok ? { kind: "response", id, ok: true, data } : { kind: "response", id, ok: false, error: data })}\n`,
		);
	}
	lastRequest(): { id: string; op: string; payload: unknown } {
		const line = this.written.at(-1) ?? "";
		return JSON.parse(line) as { id: string; op: string; payload: unknown };
	}
	requestAt(index: number): { id: string; op: string; payload: unknown } {
		const line = this.written[index] ?? "";
		return JSON.parse(line) as { id: string; op: string; payload: unknown };
	}
}

function createClient(
	onEvent: (event: DesktopEvent) => void = () => undefined,
	spawnImpl?: HostSpawn,
	maxLineBytes?: number,
): { client: HostClient; child: FakeChild } {
	const child = new FakeChild();
	const spawn: HostSpawn = spawnImpl ?? (() => child);
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

describe("HostClient", () => {
	test("correlaciona respostas fora de ordem pelos ids", async () => {
		const { client, child } = createClient();
		await client.start();
		const first = client.request<string>("workspace.list", { a: 1 });
		const second = client.request<string>("session.list", { b: 2 });
		const lineA = child.requestAt(0);
		const lineB = child.requestAt(1);
		expect(lineA.op).toBe("workspace.list");
		expect(lineB.op).toBe("session.list");
		child.respond(lineB.id, "B");
		child.respond(lineA.id, "A");
		expect(await first).toBe("A");
		expect(await second).toBe("B");
	});

	test("exit rejeita requests pendentes", async () => {
		const { client, child } = createClient();
		await client.start();
		const pending = client.request("session.snapshot", {});
		child.emitExit(1);
		await expect(pending).rejects.toMatchObject({ code: "HOST_EXITED" });
		expect(client.running).toBe(false);
	});

	test("timeout limpa a pendência e resposta tardia é ignorada", async () => {
		const { client, child } = createClient();
		await client.start();
		vi.useFakeTimers();
		try {
			const pending = client.request("settings.list", {}, { timeoutMs: 20 });
			vi.advanceTimersByTime(25);
			await expect(pending).rejects.toMatchObject({ code: "INTERNAL" });
		} finally {
			vi.useRealTimers();
		}
		const line = child.requestAt(0);
		child.respond(line.id, { ok: 1 });
		expect(client.running).toBe(true);
	});

	test("linha acima do limite falha só a request correspondente e mantém o host vivo", async () => {
		const { client, child } = createClient(undefined, undefined, 128);
		await client.start();
		const pending = client.request("session.snapshot", {});
		const request = child.requestAt(0);
		child.stdout.write(
			`{"kind":"response","id":"${request.id}","ok":true,"data":"${"x".repeat(600)}"}\n`,
		);
		await expect(pending).rejects.toMatchObject({ code: "FRAME_TOO_LARGE" });
		expect(client.running).toBe(true);
		expect(child.killCalls).toBe(0);

		const next = client.request<string>("workspace.list", {});
		const nextRequest = child.requestAt(child.written.length - 1);
		child.respond(nextRequest.id, "ok");
		expect(await next).toBe("ok");
		expect(client.running).toBe(true);
	});

	test("respeita backpressure do stdin", async () => {
		class BlockingStdin extends PassThrough {
			private blockedOnce = false;
			override write(chunk: string | Buffer, ...rest: unknown[]): boolean {
				super.write(chunk);
				if (!this.blockedOnce) {
					this.blockedOnce = true;
					return false;
				}
				return true;
			}
		}
		const child = new FakeChild();
		Object.defineProperty(child, "stdin", { value: new BlockingStdin() });
		const written: string[] = [];
		(child.stdin as PassThrough).on("data", (chunk: Buffer) => written.push(chunk.toString()));
		const client = new HostClient({
			bunPath: "bun",
			hostScript: "host.js",
			spawnImpl: () => child,
			onEvent: () => undefined,
			onExit: () => undefined,
			requestTimeoutMs: 5000,
		});
		await client.start();
		const first = client.request("a", {});
		const second = client.request("b", {});
		expect(written).toHaveLength(1);
		(child.stdin as PassThrough).emit("drain");
		expect(written).toHaveLength(2);
		const firstLine = JSON.parse(written[0]) as { id: string };
		const secondLine = JSON.parse(written[1]) as { id: string };
		child.respond(firstLine.id, 1);
		child.respond(secondLine.id, 2);
		expect(await first).toBe(1);
		expect(await second).toBe(2);
	});

	test("UTF-8 dividido entre chunks e linha grande são preservados", async () => {
		const { client, child } = createClient();
		await client.start();
		const pending = client.request<string>("session.snapshot", {});
		const request = child.requestAt(0);
		const payload = JSON.stringify({ kind: "response", id: request.id, ok: true, data: "😀ação" });
		const buffer = Buffer.from(payload, "utf8");
		const emojiStart = buffer.indexOf(Buffer.from("😀", "utf8"));
		child.stdout.write(buffer.subarray(0, emojiStart + 2));
		child.stdout.write(buffer.subarray(emojiStart + 2));
		child.stdout.write("\n");
		expect(await pending).toBe("😀ação");

		const big = "á".repeat(600_000);
		const bigPending = client.request<string>("workspace.list", {});
		const bigRequest = child.requestAt(child.written.length - 1);
		child.stdout.write(
			`${JSON.stringify({ kind: "response", id: bigRequest.id, ok: true, data: big })}\n`,
		);
		expect((await bigPending).length).toBe(600_000);
	});

	test("eventos são encaminhados e JSON inválido não derruba o cliente", async () => {
		const received = Promise.withResolvers<DesktopEvent>();
		const { client, child } = createClient((event) => received.resolve(event));
		await client.start();
		child.stdout.write("não é json\n");
		child.stdout.write(
			`${JSON.stringify({ kind: "event", workspaceId: "ws", generation: 1, sequence: 1, name: "frame", data: { type: "message_start" } })}\n`,
		);
		const event = await received.promise;
		expect(event.workspaceId).toBe("ws");
		expect(event.name).toBe("frame");
	});

	test("close encerra após o host fechar stdin", async () => {
		const { client, child } = createClient();
		await client.start();
		expect(child.pid).toBe(0);
		await client.close(200);
		expect(client.running).toBe(false);
	});
});

describe("JsonlLineDecoder", () => {
	test("mantém o restante entre chunks e remove CRLF", () => {
		const decoder = new JsonlLineDecoder(1024);
		expect(decoder.push('{"a":1}\r')).toEqual([]);
		expect(decoder.push("\n{")).toEqual(['{"a":1}']);
		expect(decoder.push('"b":2}\n')).toEqual(['{"b":2}']);
	});

	test("descarta linha acima do limite e ressincroniza sem acumular", () => {
		const decoder = new JsonlLineDecoder(8);
		expect(decoder.push("123456789")).toEqual([]);
		expect(decoder.pendingBytes).toBe(0);
		expect(decoder.takeDiscarded()).toHaveLength(0);
		expect(decoder.push("abcdef\n{\"a\":1}\n")).toEqual(['{"a":1}']);
		const dropped = decoder.takeDiscarded();
		expect(dropped).toHaveLength(1);
		expect(dropped[0]?.bytes).toBe(15);
		expect(dropped[0]?.prefix.startsWith("123456789")).toBe(true);
		expect(decoder.pendingBytes).toBe(0);
	});

	test("linha grande com newline no mesmo chunk não é entregue", () => {
		const decoder = new JsonlLineDecoder(8);
		expect(decoder.push('123456789\n{"b":2}\n')).toEqual(['{"b":2}']);
		expect(decoder.takeDiscarded()).toHaveLength(1);
	});
});

describe("ambiente e logs", () => {
	test("env mínimo mantém perfil/rede e remove segredos desconhecidos", () => {
		const env = buildHostEnv({
			PATH: "C:\\bin",
			APPDATA: "C:\\Users\\x\\AppData\\Roaming",
			OPENAI_API_KEY: "sk-real",
			MY_SERVICE_KEY: "não deve passar",
			OMP_PROFILE: "pessoal",
			OMP_SECRET_TOKEN: "não deve passar",
			ELECTRON_RUN_AS_NODE: "1",
		});
		expect(env.PATH).toBe("C:\\bin");
		expect(env.APPDATA).toContain("AppData");
		expect(env.OPENAI_API_KEY).toBe("sk-real");
		expect(env.OMP_PROFILE).toBe("pessoal");
		expect(env.MY_SERVICE_KEY).toBeUndefined();
		expect(env.OMP_SECRET_TOKEN).toBeUndefined();
		expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
	});

	test("redige tokens, headers e códigos OAuth", () => {
		const line = redactLogLine(
			'Authorization: Bearer abc.def.ghi api_key=sk-1234567890abcdef endpoint?code=segredo&x=1 C:\\Users\\Fulano\\arquivo',
		);
		expect(line).not.toContain("abc.def.ghi");
		expect(line).not.toContain("sk-1234567890abcdef");
		expect(line).not.toContain("segredo");
		expect(line).toContain("[removido]");
		expect(line).toContain("[usuario]");
		expect(line).not.toContain("Fulano");
	});
});
