import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DesktopEvent } from "../../src/shared/contracts";

const HOST_ENTRY = path.resolve(import.meta.dir, "../../src/host/index.ts");
const FAKE_OMP = path.resolve(import.meta.dir, "../fixtures/fake-omp.ts");

interface HostProcess {
	child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	next(): Promise<Record<string, unknown>>;
	request(id: string, op: string, payload?: unknown): Promise<Record<string, unknown>>;
	close(): Promise<number>;
}

function startHost(env: Record<string, string>): HostProcess {
	const child = Bun.spawn([process.execPath, HOST_ENTRY, "--data-dir", env.DATA_DIR, "--omp-path", FAKE_OMP], {
		cwd: process.cwd(),
		env: { ...process.env, ...env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	const queue: Record<string, unknown>[] = [];
	const waiters: Array<(value: Record<string, unknown>) => void> = [];
	let done = false;
	const pump = (async () => {
		for (;;) {
			const { done: finished, value } = await reader.read();
			if (finished) break;
			if (!value) continue;
			buffer += decoder.decode(value, { stream: true });
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (!line) continue;
				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				const waiter = waiters.shift();
				if (waiter) waiter(parsed);
				else queue.push(parsed);
			}
		}
		done = true;
	})();
	const next = (): Promise<Record<string, unknown>> => {
		const queued = queue.shift();
		if (queued) return Promise.resolve(queued);
		if (done) return Promise.reject(new Error("host saiu"));
		const deferred = Promise.withResolvers<Record<string, unknown>>();
		waiters.push(deferred.resolve);
		return deferred.promise;
	};
	return {
		child,
		next,
		async request(id, op, payload = {}) {
			const line = `${JSON.stringify({ kind: "request", id, op, payload })}\n`;
			const result = child.stdin.write(line);
			if (typeof result !== "number") await result;
			await child.stdin.flush();
			for (;;) {
				const message = await next();
				if (message.kind === "response" && message.id === id) return message;
			}
		},
		async close() {
			await child.stdin.end();
			return child.exited;
		},
	};
}

describe("host process", () => {
	test("handshake, workspace, sessão e encerramento limpo", async () => {
		const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-host-proc-"));
		const workspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-host-proc-ws-"));
		const sessionFile = path.join(dataDir, "fake-session.jsonl");
		await fs.promises.writeFile(sessionFile, "", "utf8");
		const host = startHost({
			DATA_DIR: dataDir,
			FAKE_OMP_SCENARIO: "basic",
			FAKE_OMP_SESSION_FILE: sessionFile,
		});
		try {
			const status = await host.request("1", "host.status");
			expect(status.ok).toBe(true);
			const statusData = status.data as { phase: string; ompPath?: string; bunPath?: string };
			expect(statusData.phase).toBe("ready");
			expect(statusData.bunPath).toBeTruthy();
			expect(statusData.ompPath).toBe(FAKE_OMP);

			const added = await host.request("2", "workspace.add", { path: workspaceDir });
			expect(added.ok).toBe(true);
			const workspace = added.data as { workspaceId: string; available: boolean; name: string };
			expect(workspace.available).toBe(true);
			expect(workspace.workspaceId.startsWith("ws_")).toBe(true);

			const created = await host.request("3", "session.create", { workspaceId: workspace.workspaceId });
			expect(created.ok).toBe(true);
			const snapshot = created.data as { state: { sessionId: string; status: string }; sessionPath?: string };
			expect(snapshot.state.sessionId.startsWith("fake-session")).toBe(true);
			expect(snapshot.state.status).toBe("settled");
			expect(snapshot.sessionPath).toBe(sessionFile);

			const unknown = await host.request("4", "session.rpc", {
				workspaceId: workspace.workspaceId,
				sessionId: snapshot.state.sessionId,
				command: { type: "tipo-inexistente" },
			});
			expect(unknown.ok).toBe(false);
			expect((unknown.error as { code: string }).code).toBe("INVALID_REQUEST");

			const closed = await host.request("5", "session.close", {
				workspaceId: workspace.workspaceId,
				sessionId: snapshot.state.sessionId,
			});
			expect(closed.ok).toBe(true);
			expect(await host.close()).toBe(0);
			const tabs = JSON.parse(await fs.promises.readFile(path.join(dataDir, "tabs.json"), "utf8"));
			expect(Array.isArray(tabs.tabs)).toBe(true);
			expect(tabs.tabs).toHaveLength(0);
		} finally {
			host.child.kill();
			await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
			await fs.promises.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}, 30_000);

	test("evento host.status inicial chega antes do handshake", async () => {
		const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-host-proc2-"));
		const host = startHost({ DATA_DIR: dataDir, FAKE_OMP_SCENARIO: "basic" });
		try {
			const first = await host.next();
			expect(first.kind).toBe("event");
			expect(first.name).toBe("host.status");
			const data = first.data as { phase: string };
			expect(data.phase).toBe("ready");
			await host.close();
		} finally {
			host.child.kill();
			await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}, 30_000);
});

// Mantém o tipo importado usado em leitura de eventos, sem alterar o protocolo.
export type { DesktopEvent };
