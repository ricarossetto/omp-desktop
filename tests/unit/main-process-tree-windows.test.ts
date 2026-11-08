import { afterAll, describe, expect, mock, test } from "bun:test";

interface ExecCall {
	file: string;
	args: string[];
}

interface SignalCall {
	pid: number;
	signal: string | number | undefined;
}

const calls: ExecCall[] = [];
const signals: SignalCall[] = [];
const fileTime = 133_444_736_000_000_000;

mock.module("node:child_process", () => ({
	execFile: (
		file: string,
		args: string[],
		_options: unknown,
		callback: (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => void,
	) => {
		calls.push({ file, args });
		const lower = file.toLowerCase();
		if (lower.includes("powershell")) {
			callback(null, `${fileTime}|bun\n`, "");
			return;
		}
		if (lower.includes("taskkill")) {
			const error = new Error("acesso negado") as Error & { code?: number };
			error.code = 1;
			callback(error, "", "");
			return;
		}
		callback(null, "", "");
	},
}));

// O mock de `node:child_process` precisa estar registrado antes de o módulo
// ser avaliado; um import estático carregaria o `execFile` real primeiro.
const { fileTimeToEpochMs, killProcessTree } = await import("../../src/main/process-tree");

const originalPlatform = process.platform;
const originalKill = process.kill;

afterAll(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	process.kill = originalKill;
	mock.restore();
});

describe("process-tree Windows", () => {
	test("falha do taskkill não sinaliza descendentes de um PID possivelmente reciclado", async () => {
		calls.length = 0;
		signals.length = 0;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		// EPERM em signal 0: o PID "existe" para isProcessRunning mesmo sem
		// processo real, simulando a raiz viva com o PID possivelmente trocado.
		process.kill = ((pid: number, signal?: string | number) => {
			if (signal === 0) {
				const error = new Error("EPERM") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			signals.push({ pid, signal });
			return true;
		}) as typeof process.kill;

		const identity = {
			pid: 4242,
			startedAt: Date.now(),
			creationTimeMs: fileTimeToEpochMs(fileTime),
			executableName: "bun",
		};
		const killed = await killProcessTree(identity);

		expect(killed).toBe(false);
		const taskkills = calls.filter((call) => call.file.toLowerCase().includes("taskkill"));
		expect(taskkills).toHaveLength(1);
		expect(taskkills[0]?.args).toContain("/PID");
		expect(taskkills[0]?.args).toContain("4242");
		// O fallback antigo consultava Win32_Process e sinalizava os filhos por
		// PID cru antes de revalidar a raiz; nada disso pode acontecer.
		expect(calls.some((call) => call.args.join(" ").includes("Get-CimInstance"))).toBe(false);
		expect(signals).toEqual([]);
	});

	test("identidade sem criação não sinaliza nem por nome de executável", async () => {
		calls.length = 0;
		signals.length = 0;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		process.kill = ((pid: number, signal?: string | number) => {
			if (signal === 0) {
				const error = new Error("EPERM") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			signals.push({ pid, signal });
			return true;
		}) as typeof process.kill;

		// O mock do PowerShell devolve criação + nome "bun"; o nome sozinho não
		// pode autorizar o sinal quando a captura original não trouxe criação.
		const identity = { pid: 4243, startedAt: Date.now(), executableName: "bun" };
		const killed = await killProcessTree(identity);

		expect(killed).toBe(false);
		expect(calls.filter((call) => call.file.toLowerCase().includes("taskkill"))).toHaveLength(0);
		expect(signals).toEqual([]);
	});
});
