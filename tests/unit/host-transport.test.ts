import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { OmpTransport, OmpTransportError } from "../../src/host/omp-transport";

const FAKE_OMP = path.resolve(import.meta.dir, "../fixtures/fake-omp.ts");
const active: OmpTransport[] = [];

function transportFor(scenario: string, extraEnv: Record<string, string> = {}): OmpTransport {
	const transport = new OmpTransport({
		ompPath: FAKE_OMP,
		cwd: process.cwd(),
		generation: Math.floor(Math.random() * 1_000_000) + 1,
		env: { FAKE_OMP_SCENARIO: scenario, ...extraEnv },
		startupTimeoutMs: 20_000,
	});
	active.push(transport);
	return transport;
}

afterEach(async () => {
	await Promise.all(active.splice(0).map((transport) => transport.close().catch(() => undefined)));
});

describe("OmpTransport", () => {
	test("handshake real do fake: v2, estado e comandos", async () => {
		const transport = transportFor("basic");
		const ready = await transport.start();
		expect(ready.protocolVersion).toBe(2);
		expect(ready.maxFrameBytes).toBeGreaterThan(0);
		const state = await transport.request({ type: "get_state" });
		expect(state.success).toBe(true);
		if (state.success && "data" in state) {
			expect((state.data as { sessionId?: string }).sessionId?.startsWith("fake-session")).toBe(true);
		}
		const commands = await transport.request({ type: "get_available_commands" });
		expect(commands.success).toBe(true);
	});

	test("requests A/B com respostas invertidas resolvem cada solicitante", async () => {
		const transport = transportFor("echo");
		await transport.start();
		const [first, second] = await Promise.all([
			transport.request({ type: "bash", command: "a", id: "A" }),
			transport.request({ type: "bash", command: "b", id: "B" }),
		]);
		expect(first.id).toBe("A");
		expect(second.id).toBe("B");
		expect((first as { data?: { echo?: string } }).data?.echo).toBe("A");
		expect((second as { data?: { echo?: string } }).data?.echo).toBe("B");
	});

	test("timeout limpa a pendência e o transporte continua utilizável", async () => {
		const transport = transportFor("hang");
		await transport.start();
		const failed = transport.request({ type: "bash", command: "trava" }, undefined, 300);
		await expect(failed).rejects.toBeInstanceOf(OmpTransportError);
		const state = await transport.request({ type: "get_state" });
		expect(state.success).toBe(true);
	});

	test("saída do processo rejeita pendências com HOST_EXITED e dispara onExit", async () => {
		const exitSignal = Promise.withResolvers<void>();
		const transport = new OmpTransport({
			ompPath: FAKE_OMP,
			cwd: process.cwd(),
			generation: 999,
			env: { FAKE_OMP_SCENARIO: "exit" },
			onExit: () => {
				exitSignal.resolve();
			},
			startupTimeoutMs: 20_000,
		});
		active.push(transport);
		await transport.start();
		await expect(transport.request({ type: "bash", command: "sair" })).rejects.toMatchObject({
			code: "HOST_EXITED",
		});
		await exitSignal.promise;
	});

	test("frame lógico > 1 MiB com Unicode é remontado pelo decoder v2", async () => {
		const transport = transportFor("huge");
		const ready = await transport.start();
		expect(ready.protocolVersion).toBe(2);
		const state = await transport.request({ type: "get_state" });
		expect(state.success).toBe(true);
		const big = state.success && "data" in state ? (state.data as { bigString?: string }).bigString : undefined;
		expect(typeof big).toBe("string");
		expect((big ?? "").length).toBeGreaterThan(500_000);
		expect((big ?? "").includes("\u6f22")).toBe(true);
		expect((big ?? "").includes("\u{1F642}")).toBe(true);
	});

	test("sequência inválida de chunks interrompe a sessão com diagnóstico", async () => {
		const exitSignal = Promise.withResolvers<string | undefined>();
		const transport = new OmpTransport({
			ompPath: FAKE_OMP,
			cwd: process.cwd(),
			generation: 1000,
			env: { FAKE_OMP_SCENARIO: "badchunk" },
			onExit: (info) => {
				exitSignal.resolve(info.fatalReason);
			},
			startupTimeoutMs: 20_000,
		});
		active.push(transport);
		await transport.start();
		let failure: unknown;
		try {
			await transport.request({ type: "bash", command: "quebrar" });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(OmpTransportError);
		expect((failure as OmpTransportError).code).toBe("HOST_EXITED");
		const reason = await exitSignal.promise;
		expect(reason).toBeTruthy();
		expect(reason).toContain("chunk");
	});

	test("servidor só v1 continua funcionando com aviso de limite", async () => {
		const transport = transportFor("basic", { FAKE_OMP_PROTOCOL: "1" });
		const ready = await transport.start();
		expect(ready.protocolVersion).toBe(1);
		expect(ready.warnings.some((warning) => warning.includes("v1"))).toBe(true);
		const state = await transport.request({ type: "get_state" });
		expect(state.success).toBe(true);
	});

	test("pedido maior que o limite físico é recusado antes da escrita", async () => {
		const transport = transportFor("basic", { FAKE_OMP_MAX_FRAME: "4096" });
		await transport.start();
		await expect(
			transport.request({ type: "prompt", message: "x".repeat(8000) }),
		).rejects.toMatchObject({ code: "FRAME_TOO_LARGE" });
	});
});
