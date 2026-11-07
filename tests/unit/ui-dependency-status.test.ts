import { describe, expect, test } from "bun:test";
import { asDependencySnapshot } from "../../src/renderer/features/diagnostics/dependency-status";

const missing = { state: "missing", kind: "git" };

describe("asDependencySnapshot", () => {
	test("aceita os quatro estados e preserva progresso", () => {
		const snapshot = asDependencySnapshot({
			git: {
				state: "installed",
				kind: "git",
				executablePath: "C:\\tools\\git\\cmd\\git.exe",
				version: "2.56.0",
			},
			node: {
				state: "installing",
				kind: "node",
				phase: "downloading",
				receivedBytes: 1024,
				totalBytes: 4096,
			},
		});
		expect(snapshot?.git).toMatchObject({ state: "installed", version: "2.56.0" });
		expect(snapshot?.node).toMatchObject({
			state: "installing",
			phase: "downloading",
			receivedBytes: 1024,
			totalBytes: 4096,
		});
	});

	test("aceita missing e error com código", () => {
		const snapshot = asDependencySnapshot({
			git: { state: "error", kind: "git", code: "EXISTING_INCOMPATIBLE", message: "folder exists" },
			node: { state: "missing", kind: "node" },
		});
		expect(snapshot?.git).toMatchObject({ state: "error", code: "EXISTING_INCOMPATIBLE" });
		expect(snapshot?.node).toEqual({ state: "missing", kind: "node" });
	});

	test("descarta snapshot incompleto ou com estado inválido", () => {
		expect(asDependencySnapshot({ git: missing })).toBeUndefined();
		expect(
			asDependencySnapshot({
				git: missing,
				node: { state: "installed", kind: "node", version: "26.13.0" },
			}),
		).toBeUndefined();
		expect(
			asDependencySnapshot({
				git: { ...missing, kind: "node" },
				node: { state: "missing", kind: "node" },
			}),
		).toBeUndefined();
		expect(
			asDependencySnapshot({
				git: { state: "installing", kind: "git", phase: "unknown" },
				node: { state: "missing", kind: "node" },
			}),
		).toBeUndefined();
		expect(asDependencySnapshot(null)).toBeUndefined();
	});

	test("não inventa números de progresso ausentes", () => {
		const snapshot = asDependencySnapshot({
			git: { state: "installing", kind: "git", phase: "extracting" },
			node: { state: "missing", kind: "node" },
		});
		expect(snapshot?.git).toEqual({
			state: "installing",
			kind: "git",
			phase: "extracting",
			receivedBytes: undefined,
			totalBytes: undefined,
		});
	});
});
