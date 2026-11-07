import { describe, expect, test } from "bun:test";
import { mergeDependencyProbe } from "../../src/main/dependency-state";

const missing = { state: "missing" as const, kind: "git" as const };
const installed = {
	state: "installed" as const,
	kind: "git" as const,
	executablePath: "C:\\tools\\git\\cmd\\git.exe",
	version: "2.56.0",
};

describe("mergeDependencyProbe", () => {
	test("probe iniciado antes da instalação não sobrescreve installed", () => {
		// Sondagem começou na geração 0, a instalação concluiu (geração 1) e o
		// probe antigo devolveu missing; o estado instalado deve vencer.
		expect(mergeDependencyProbe("git", missing, installed, 0, 1)).toEqual(installed);
	});

	test("probe sem mudança de geração é autoritativo", () => {
		expect(mergeDependencyProbe("git", missing, installed, 3, 3)).toEqual(missing);
	});

	test("instalação em andamento continua dona do estado", () => {
		const installing = { state: "installing" as const, kind: "git" as const, phase: "downloading" as const };
		expect(mergeDependencyProbe("git", missing, installing, 1, 1)).toEqual(installing);
		expect(mergeDependencyProbe("git", installed, installing, 1, 2)).toEqual(installing);
	});

	test("mudança de geração sem estado atual usa o probe", () => {
		expect(mergeDependencyProbe("git", missing, undefined, 0, 1)).toEqual(missing);
	});

	test("erro de instalação recente não é apagado por probe antigo", () => {
		const failed = {
			state: "error" as const,
			kind: "git" as const,
			code: "CHECKSUM" as const,
			message: "checksum mismatch",
		};
		expect(mergeDependencyProbe("git", missing, failed, 0, 1)).toEqual(failed);
	});
});
