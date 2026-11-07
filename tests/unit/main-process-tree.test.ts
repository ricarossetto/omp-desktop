import { describe, expect, test } from "bun:test";
import {
	captureProcessIdentity,
	fileTimeToEpochMs,
	isProcessRunning,
	killProcessTree,
	parseDescendants,
} from "../../src/main/process-tree";

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

	test("converte FILETIME e ordena descendentes do mais profundo ao mais raso", () => {
		expect(fileTimeToEpochMs(116_444_736_000_000_000)).toBe(0);
		expect(fileTimeToEpochMs(0)).toBeUndefined();

		const output = ["10 1", "11 10", "12 11", "13 10", "14 1"].join("\n");
		expect(parseDescendants(1, output)).toEqual([12, 11, 13, 10, 14]);
	});
});
