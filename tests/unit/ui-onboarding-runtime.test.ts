import { describe, expect, test } from "bun:test";
import type { RuntimeStatus } from "../../src/shared/contracts";
import {
	effectiveOnboardingRuntime,
	ompStatusKey,
} from "../../src/renderer/features/onboarding/onboarding-runtime";

const base: RuntimeStatus = {
	phase: "ready",
	ompPath: "C:\\omp\\omp.exe",
	ompVersion: "18.16.0",
	signed: false,
};

const depsA: RuntimeStatus["dependencies"] = {
	git: { state: "missing", kind: "git" },
	node: { state: "missing", kind: "node" },
};

const depsB: RuntimeStatus["dependencies"] = {
	git: {
		state: "installed",
		kind: "git",
		executablePath: "C:\\tools\\git\\cmd\\git.exe",
		version: "2.56.0",
	},
	node: { state: "installing", kind: "node", phase: "downloading", receivedBytes: 10, totalBytes: 20 },
};

describe("override do onboarding", () => {
	test("dependências vêm do store mesmo com override de OMP", () => {
		const override = { ...base, ompPath: "D:\\novo\\omp.exe", dependencies: depsA };
		const runtime = { ...base, dependencies: depsB };
		const effective = effectiveOnboardingRuntime(override, runtime);
		expect(effective?.ompPath).toBe("D:\\novo\\omp.exe");
		expect(effective?.dependencies).toEqual(depsB);
	});

	test("gitVersion também acompanha o store, não o override antigo", () => {
		const override = { ...base, gitVersion: "2.47.0", dependencies: depsA };
		const runtime = { ...base, gitVersion: "2.56.0", dependencies: depsB };
		expect(effectiveOnboardingRuntime(override, runtime)?.gitVersion).toBe("2.56.0");
		const runtimeWithoutGit = { ...base, gitVersion: undefined, dependencies: depsA };
		expect(effectiveOnboardingRuntime(override, runtimeWithoutGit)?.gitVersion).toBeUndefined();
	});

	test("sem override usa o runtime do store", () => {
		expect(effectiveOnboardingRuntime(null, { ...base, dependencies: depsB })).toEqual({
			...base,
			dependencies: depsB,
		});
	});

	test("runtime ausente preserva o override", () => {
		const override = { ...base, dependencies: depsA };
		expect(effectiveOnboardingRuntime(override, null)).toEqual(override);
	});

	test("progresso de Git/Node não muda a chave que invalida o override", () => {
		expect(ompStatusKey({ ...base, dependencies: depsA })).toBe(
			ompStatusKey({ ...base, dependencies: depsB }),
		);
	});

	test("mudança real de OMP muda a chave", () => {
		const before = ompStatusKey({ ...base, dependencies: depsA });
		expect(ompStatusKey({ ...base, phase: "starting-host", dependencies: depsA })).not.toBe(before);
		expect(ompStatusKey({ ...base, ompPath: "D:\\outro\\omp.exe", dependencies: depsA })).not.toBe(before);
		expect(
			ompStatusKey({ ...base, install: { state: "installing", phase: "downloading" }, dependencies: depsA }),
		).not.toBe(before);
	});
});
