import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	captureProcessIdentity,
	fileTimeToEpochMs,
	isProcessRunning,
	killProcessTree,
	parseDescendants,
} from "../../src/main/process-tree";

/**
 * Espera real de reaping do SO: o neto não é filho deste processo, então não
 * há promessa/evento para aguardar. O polling curto é a única forma de
 * observar o processo sumir após o SIGKILL; o limite evita espera fixa longa.
 * Um zumbi já não executa nada e conta como encerrado.
 */
async function waitUntilGone(pid: number, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessRunning(pid)) return true;
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			if (stat.slice(close + 2, close + 3) === "Z") return true;
		} catch {
			return true;
		}
		await Bun.sleep(50);
	}
	return !isProcessRunning(pid);
}

describe("process-tree", () => {
	test("rejeita PIDs inválidos sem enviar sinal", async () => {
		expect(await killProcessTree(0)).toBe(false);
		expect(await killProcessTree(-5)).toBe(false);
		expect(isProcessRunning(0)).toBe(false);
		expect(isProcessRunning(-1)).toBe(false);
	});

	test("reconhece o próprio processo e desconhece PID inexistente", () => {
		expect(isProcessRunning(process.pid)).toBe(true);
		expect(isProcessRunning(2_000_000_000)).toBe(false);
	});

	test("não encerra quando a identidade não corresponde ao processo iniciado", async () => {
		const identity = await captureProcessIdentity(process.pid, "executavel-que-nao-e-este");
		const impostor = { ...identity, creationTimeMs: 1, executableName: "definitely-not-bun" };
		expect(await killProcessTree(impostor)).toBe(false);
		expect(isProcessRunning(process.pid)).toBe(true);
	}, 20_000);

	test("número cru nunca encerra processo, nem o próprio runner", async () => {
		expect(await killProcessTree(process.pid)).toBe(false);
		expect(isProcessRunning(process.pid)).toBe(true);
	});

	test("identidade sem criação nem nome não encerra processo", async () => {
		expect(await killProcessTree({ pid: process.pid, startedAt: Date.now() })).toBe(false);
		expect(isProcessRunning(process.pid)).toBe(true);
	});

	test("converte FILETIME e ordena descendentes do mais profundo ao mais raso", () => {
		expect(fileTimeToEpochMs(116_444_736_000_000_000)).toBe(0);
		expect(fileTimeToEpochMs(0)).toBeUndefined();

		const output = ["10 1", "11 10", "12 11", "13 10", "14 1"].join("\n");
		expect(parseDescendants(1, output)).toEqual([12, 11, 13, 10, 14]);
	});
});

if (process.platform === "linux") {
	describe("process-tree Linux", () => {
		test("captura hora de criação e nome do processo pelo /proc", async () => {
			const identity = await captureProcessIdentity(process.pid, process.execPath);
			expect(typeof identity.creationTimeMs).toBe("number");
			expect(identity.executableName).toBeTruthy();
		});

		test("encerra o shell e os filhos reais sem tocar em outros processos", async () => {
			// PATH explícito: outros testes não podem remover `sleep` do ambiente.
			const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C" };
			const child = Bun.spawn(["/bin/sh", "-c", "sleep 30 & echo $!; wait"], {
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			});
			expect(typeof child.pid).toBe("number");
			const reader = child.stdout.getReader();
			const first = await reader.read();
			expect(first.done).toBe(false);
			const grandchild = Number(new TextDecoder().decode(first.value ?? new Uint8Array()).trim());
			expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
			expect(isProcessRunning(grandchild)).toBe(true);

			const identity = await captureProcessIdentity(child.pid as number, "/bin/sh");
			expect(typeof identity.creationTimeMs).toBe("number");
			expect(await killProcessTree(identity)).toBe(true);
			await child.exited;
			expect(await waitUntilGone(child.pid as number)).toBe(true);
			expect(await waitUntilGone(grandchild)).toBe(true);
			// O runner (este processo) continua vivo: nenhuma identidade foi
			// confundida com o PID do shell encerrado.
			expect(isProcessRunning(process.pid)).toBe(true);
		}, 20_000);

		test("recusa identidade de um PID cuja criação não coincide", async () => {
			const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", LANG: "C" };
			const child = Bun.spawn(["/bin/sh", "-c", "sleep 30"], {
				env,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			const identity = await captureProcessIdentity(child.pid as number, "/bin/sh");
			const stale = { ...identity, creationTimeMs: (identity.creationTimeMs ?? 0) - 60_000 };
			expect(await killProcessTree(stale)).toBe(false);
			expect(isProcessRunning(child.pid as number)).toBe(true);

			// No Linux nome/PID sozinhos não bastam: sem criação, não sinaliza.
			const withoutCreation = { ...identity, creationTimeMs: undefined };
			expect(await killProcessTree(withoutCreation)).toBe(false);
			expect(isProcessRunning(child.pid as number)).toBe(true);

			await killProcessTree(identity);
			await child.exited;
		}, 20_000);
	});
}
