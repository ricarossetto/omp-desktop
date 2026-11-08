import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { OmpTransport } from "../../src/host/omp-transport";
import { isRecord } from "../../src/shared/session-state";

const FAKE_OMP = path.resolve(import.meta.dir, "../fixtures/fake-omp.ts");
const active: OmpTransport[] = [];

function transportFor(scenario: string): OmpTransport {
	const transport = new OmpTransport({
		ompPath: FAKE_OMP,
		cwd: process.cwd(),
		generation: Math.floor(Math.random() * 1_000_000) + 1,
		env: {
			FAKE_OMP_SCENARIO: scenario,
			FAKE_OMP_ENTRIES: undefined,
			FAKE_OMP_SESSION_FILE: undefined,
			FAKE_OMP_SESSION_ID: undefined,
		},
		startupTimeoutMs: 20_000,
	});
	active.push(transport);
	return transport;
}

function stateDataOf(response: RpcResponse): Record<string, unknown> | undefined {
	return response.success && "data" in response && isRecord(response.data) ? response.data : undefined;
}

afterEach(async () => {
	await Promise.all(active.splice(0).map((transport) => transport.close().catch(() => undefined)));
});

describe("sessão padrão do fake-omp", () => {
	test("não herda histórico de PID reutilizado", async () => {
		// Simula a reutilização de PID do Windows: o wrapper grava um arquivo no
		// caminho antigo `fake-omp-<pid>.jsonl` e só então inicia a fixture no
		// mesmo processo. Um default derivado só do PID carregaria "STALE" e o
		// fallback paginado o devolveria junto com o fixture do teste.
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-fake-pid-"));
		const wrapper = path.join(dir, "wrapper.ts");
		const staleLine = JSON.stringify({
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "STALE-PID-REUSE" }], timestamp: 1 },
		});
		await fs.promises.writeFile(
			wrapper,
			[
				'import * as fs from "node:fs";',
				'import * as os from "node:os";',
				'import * as path from "node:path";',
				'const stale = path.join(os.tmpdir(), `fake-omp-${process.pid}.jsonl`);',
				`fs.writeFileSync(stale, ${JSON.stringify(`${staleLine}\n`)}, "utf8");`,
				// Import dinâmico de propósito: o arquivo stale precisa existir antes
				// de a fixture carregar o histórico; um import estático seria hoisted.
				`await import(${JSON.stringify(pathToFileURL(FAKE_OMP).href)});`,
			].join("\n"),
			"utf8",
		);
		const transport = new OmpTransport({
			ompPath: wrapper,
			cwd: process.cwd(),
			generation: 1001,
			env: {
				FAKE_OMP_SCENARIO: "basic",
				FAKE_OMP_ENTRIES: undefined,
				FAKE_OMP_SESSION_FILE: undefined,
				FAKE_OMP_SESSION_ID: undefined,
			},
			startupTimeoutMs: 20_000,
		});
		active.push(transport);
		let stalePath: string | undefined;
		try {
			const ready = await transport.start();
			if (typeof ready.pid !== "number") throw new Error("fake sem pid");
			stalePath = path.join(os.tmpdir(), `fake-omp-${ready.pid}.jsonl`);
			const state = stateDataOf(await transport.request({ type: "get_state" }));
			expect(typeof state?.sessionFile).toBe("string");
			expect(state?.sessionFile).not.toBe(stalePath);
			const page = stateDataOf(await transport.request({ type: "get_messages_page" }));
			const messages = page && Array.isArray(page.messages) ? page.messages : [];
			expect(JSON.stringify(messages)).not.toContain("STALE-PID-REUSE");
		} finally {
			await transport.close().catch(() => undefined);
			if (stalePath) await fs.promises.rm(stalePath, { force: true }).catch(() => undefined);
			await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test("duas sessões simultâneas têm arquivo e id distintos", async () => {
		const first = transportFor("basic");
		const second = transportFor("basic");
		await Promise.all([first.start(), second.start()]);
		const [a, b] = await Promise.all([
			first.request({ type: "get_state" }),
			second.request({ type: "get_state" }),
		]);
		const aData = stateDataOf(a);
		const bData = stateDataOf(b);
		expect(typeof aData?.sessionFile).toBe("string");
		expect(typeof bData?.sessionFile).toBe("string");
		expect(aData?.sessionFile).not.toBe(bData?.sessionFile);
		expect(aData?.sessionId).not.toBe(bData?.sessionId);
	});
});
