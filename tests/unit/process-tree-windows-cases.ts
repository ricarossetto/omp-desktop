import { afterAll, expect, mock, test } from "bun:test";

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
let rootReused = false;

// Este arquivo roda em um processo Bun filho (não é descoberto como teste):
// `mock.module` do Bun não é isolado por arquivo, então os mocks de
// `node:child_process`, `process.platform` e `process.kill` não podem viver no
// processo da suíte.
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
			if (args.some((arg) => arg.includes("Get-CimInstance"))) {
				callback(null, "5353 4242\n", "");
			} else {
				callback(null, `${fileTime + (rootReused ? 600_000_000 : 0)}|bun\n`, "");
			}
			return;
		}
		if (lower.includes("taskkill")) {
			rootReused = true;
			const error = new Error("acesso negado") as Error & { code?: number };
			error.code = 1;
			callback(error, "", "");
			return;
		}
		callback(null, "", "");
	},
}));

// O mock precisa estar registrado antes de o módulo ser avaliado.
const { fileTimeToEpochMs, killProcessTree } = await import("../../src/main/process-tree");

const originalPlatform = process.platform;
const originalKill = process.kill;

afterAll(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	process.kill = originalKill;
	console.log("PROCESS_TREE_WINDOWS_CASES_OK");
});

function stubWindows(): void {
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
}

test("falha do taskkill não sinaliza descendentes de um PID possivelmente reciclado", async () => {
	calls.length = 0;
	signals.length = 0;
	rootReused = false;
	stubWindows();
	const identity = {
		pid: 4242,
		startedAt: Date.now(),
		creationTimeMs: fileTimeToEpochMs(fileTime),
		executableName: "bun",
	};
	const killed = await killProcessTree(identity);

	expect(killed).toBe(false);
	const taskkills = calls.filter((call) => call.file.toLowerCase().includes("taskkill"));
	const signaledPids = taskkills.map((call) => call.args[call.args.indexOf("/PID") + 1]);
	expect(signaledPids).toContain("4242");
	// A falha troca a criação da raiz. A consulta seguinte apontaria um filho
	// do processo que reutilizou o PID; esse filho não pertence ao aplicativo.
	expect(signaledPids).not.toContain("5353");
	expect(signals).toEqual([]);
});

test("identidade sem criação não sinaliza nem por nome de executável", async () => {
	calls.length = 0;
	signals.length = 0;
	rootReused = false;
	stubWindows();
	// O mock do PowerShell devolve criação + nome "bun"; o nome sozinho não
	// pode autorizar o sinal quando a captura original não trouxe criação.
	const identity = { pid: 4243, startedAt: Date.now(), executableName: "bun" };
	const killed = await killProcessTree(identity);

	expect(killed).toBe(false);
	expect(calls.filter((call) => call.file.toLowerCase().includes("taskkill"))).toHaveLength(0);
	expect(signals).toEqual([]);
});

