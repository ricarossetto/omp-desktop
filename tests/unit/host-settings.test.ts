import { afterEach, describe, expect, test } from "bun:test";
import { YAML } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SettingsError, SettingsService } from "../../src/host/settings";

const FAKE_OMP = path.resolve(import.meta.dir, "../fixtures/fake-omp.ts");

const cleanup: string[] = [];

afterEach(async () => {
	for (const dir of cleanup.splice(0)) {
		await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

interface Harness {
	dataDir: string;
	workspaceDir: string;
	configFile: string;
	recordFile: string;
	service: SettingsService;
	setEnv(extra: Record<string, string | undefined>): void;
}

const DEFAULT_GLOBAL = {
	modelRoles: { default: "fake/fake-model" },
	modelPresets: {},
};

async function createHarness(
	options: {
		global?: Record<string, unknown>;
		project?: Record<string, unknown>;
	} = {},
): Promise<Harness> {
	const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-settings-"));
	const workspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-settings-ws-"));
	cleanup.push(dataDir, workspaceDir);
	const configFile = path.join(dataDir, "global.json");
	await fs.promises.writeFile(configFile, JSON.stringify(options.global ?? DEFAULT_GLOBAL), "utf8");
	const recordFile = path.join(dataDir, "record.jsonl");
	let projectFile: string | undefined;
	if (options.project) {
		projectFile = path.join(dataDir, "project.json");
		await fs.promises.writeFile(projectFile, JSON.stringify(options.project), "utf8");
	}
	const baseEnv: Record<string, string | undefined> = {
		FAKE_OMP_CONFIG_FILE: configFile,
		FAKE_OMP_RECORD: recordFile,
		...(projectFile ? { FAKE_OMP_PROJECT_CONFIG_FILE: projectFile } : {}),
	};
	let env = { ...baseEnv };
	const service = new SettingsService(() => ({ ompPath: FAKE_OMP, env }));
	return {
		dataDir,
		workspaceDir,
		configFile,
		recordFile,
		service,
		setEnv(extra) {
			env = { ...baseEnv, ...extra };
		},
	};
}

async function records(file: string): Promise<Array<Record<string, unknown>>> {
	try {
		const text = await fs.promises.readFile(file, "utf8");
		return text
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

async function expectError(promise: Promise<unknown>, code: string): Promise<void> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(SettingsError);
		expect((error as SettingsError).code).toBe(code);
		return;
	}
	throw new Error(`esperava SettingsError ${code}, mas a operação concluiu`);
}

async function seedProjectConfig(workspaceDir: string, config: unknown): Promise<void> {
	const dir = path.join(workspaceDir, ".omp");
	await fs.promises.mkdir(dir, { recursive: true });
	await fs.promises.writeFile(path.join(dir, "config.yml"), YAML.stringify(config, null, 2), "utf8");
}

describe("SettingsService.list", () => {
	test("expõe a camada global crua e mantém efetivos apenas para exibição", async () => {
		const harness = await createHarness({
			global: {
				modelRoles: { default: "fake/fake-model", review: "fake/fast-model" },
				modelPresets: { fast: { modelRoles: { default: "fake/fast-model" } } },
				"retry.usageReservePct": 10,
			},
			project: { modelRoles: { review: "outro/smart-model" } },
		});
		const snapshot = await harness.service.list(harness.workspaceDir);
		// Camada global exatamente como escrita: o papel sobrescrito pelo projeto
		// continua com o valor global (nunca o efetivo).
		expect(snapshot.global.modelRoles).toEqual({
			default: "fake/fake-model",
			review: "fake/fast-model",
		});
		expect(snapshot.project.modelRoles).toEqual({ review: "outro/smart-model" });
		expect(snapshot.modelRoles).toEqual({
			default: "fake/fake-model",
			review: "outro/smart-model",
		});
		expect(snapshot.global["retry.usageReservePct"]).toBe(10);
		const preset = snapshot.presets.fast;
		expect(preset.modelRoles).toEqual({ default: "fake/fast-model" });
		// Chave ausente não pode virar `defaultThinkingLevel: undefined`.
		expect(Object.hasOwn(preset, "defaultThinkingLevel")).toBe(false);
	});

	test("falha de leitura de camada não vira configuração vazia", async () => {
		const harness = await createHarness();
		harness.setEnv({ FAKE_OMP_CONFIG_FAIL: "list" });
		await expectError(harness.service.list(harness.workspaceDir), "OMP_UNAVAILABLE");
	});
});

describe("SettingsService.save", () => {
	test("compara a camada global real e detecta conflito", async () => {
		const harness = await createHarness();
		const base = {
			cwd: harness.workspaceDir,
			scope: "global" as const,
			key: "modelRoles",
		};
		await harness.service.save({
			...base,
			value: { default: "fake/fast-model" },
			expectedValue: { default: "fake/fake-model" },
		});
		const saved = JSON.parse(await fs.promises.readFile(harness.configFile, "utf8")) as {
			modelRoles: Record<string, string>;
		};
		expect(saved.modelRoles).toEqual({ default: "fake/fast-model" });
		await expectError(
			harness.service.save({
				...base,
				value: { default: "outro/smart-model" },
				expectedValue: { default: "fake/fake-model" },
			}),
			"CONFIG_CONFLICT",
		);
	});

	test("exige sentinela explícita para chave ausente", async () => {
		const harness = await createHarness();
		const base = {
			cwd: harness.workspaceDir,
			scope: "global" as const,
			key: "retry.usageReservePct",
		};
		await expectError(harness.service.save({ ...base, value: 25 }), "INVALID_REQUEST");
		await harness.service.save({ ...base, value: 25, expectedMissing: true });
		await expectError(
			harness.service.save({ ...base, value: 30, expectedMissing: true }),
			"CONFIG_CONFLICT",
		);
		const saved = JSON.parse(await fs.promises.readFile(harness.configFile, "utf8")) as Record<
			string,
			unknown
		>;
		expect(saved["retry.usageReservePct"]).toBe(25);
	});

	test("falha ao ler a camada global impede a gravação (sem fail-open)", async () => {
		const harness = await createHarness();
		harness.setEnv({ FAKE_OMP_CONFIG_FAIL: "list" });
		await expectError(
			harness.service.save({
				cwd: harness.workspaceDir,
				scope: "global",
				key: "modelRoles",
				value: { default: "fake/fast-model" },
				expectedValue: { default: "fake/fake-model" },
			}),
			"OMP_UNAVAILABLE",
		);
		expect((await records(harness.recordFile)).filter((entry) => entry.type === "config_set")).toHaveLength(0);
		const saved = JSON.parse(await fs.promises.readFile(harness.configFile, "utf8")) as {
			modelRoles: Record<string, string>;
		};
		expect(saved.modelRoles).toEqual({ default: "fake/fake-model" });
	});

	test("serializa gravações da mesma chave e relê dentro do lock", async () => {
		const harness = await createHarness();
		const base = {
			cwd: harness.workspaceDir,
			scope: "global" as const,
			key: "modelRoles",
		};
		const results = await Promise.allSettled([
			harness.service.save({
				...base,
				value: { default: "fake/fast-model" },
				expectedValue: { default: "fake/fake-model" },
			}),
			harness.service.save({
				...base,
				value: { default: "outro/smart-model" },
				expectedValue: { default: "fake/fake-model" },
			}),
		]);
		expect(results[0].status).toBe("fulfilled");
		expect(results[1].status).toBe("rejected");
		if (results[1].status === "rejected") {
			expect((results[1].reason as SettingsError).code).toBe("CONFIG_CONFLICT");
		}
		const saved = JSON.parse(await fs.promises.readFile(harness.configFile, "utf8")) as {
			modelRoles: Record<string, string>;
		};
		// A segunda gravação não pode ter sobrescrito a primeira.
		expect(saved.modelRoles).toEqual({ default: "fake/fast-model" });
	});

	test("falha do config set vira INTERNAL sem alterar o arquivo", async () => {
		const harness = await createHarness();
		harness.setEnv({ FAKE_OMP_CONFIG_FAIL: "set" });
		await expectError(
			harness.service.save({
				cwd: harness.workspaceDir,
				scope: "global",
				key: "modelRoles",
				value: { default: "fake/fast-model" },
				expectedValue: { default: "fake/fake-model" },
			}),
			"INTERNAL",
		);
		const saved = JSON.parse(await fs.promises.readFile(harness.configFile, "utf8")) as {
			modelRoles: Record<string, string>;
		};
		expect(saved.modelRoles).toEqual({ default: "fake/fake-model" });
	});

	test("executável ausente vira OMP_UNAVAILABLE, não INTERNAL", async () => {
		const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-settings-missing-"));
		cleanup.push(dataDir);
		const service = new SettingsService(() => ({
			ompPath: path.join(dataDir, "nao-existe-omp"),
		}));
		await expectError(service.list(dataDir), "OMP_UNAVAILABLE");
	});
});

describe("SettingsService.saveProject", () => {
	test("normaliza tombstones antes de comparar e limpar papéis", async () => {
		const harness = await createHarness();
		await seedProjectConfig(harness.workspaceDir, {
			modelRoles: { default: "fake/fake-model", review: "fake/fast-model" },
		});
		const base = {
			cwd: harness.workspaceDir,
			scope: "project" as const,
			key: "modelRoles",
		};
		// Remove `review`; o arquivo passa a guardar o tombstone `review: null`.
		await harness.service.save({
			...base,
			value: { default: "fake/fake-model" },
			expectedValue: { default: "fake/fake-model", review: "fake/fast-model" },
		});
		let snapshot = await harness.service.list(harness.workspaceDir);
		expect(snapshot.modelRoles).toEqual({ default: "fake/fake-model" });
		expect(snapshot.project.modelRoles).toMatchObject({ review: null });

		// Segundo save: o tombstone não pode gerar CONFIG_CONFLICT falso ao
		// comparar com os papéis normalizados.
		await harness.service.save({
			...base,
			value: { default: "fake/fake-model", review: "outro/smart-model" },
			expectedValue: { default: "fake/fake-model" },
		});
		snapshot = await harness.service.list(harness.workspaceDir);
		expect(snapshot.modelRoles.review).toBe("outro/smart-model");
	});
});

describe("SettingsService.listModels", () => {
	test("deduplica chamadas concorrentes e usa cache curto", async () => {
		const harness = await createHarness();
		const [first, second] = await Promise.all([
			harness.service.listModels(harness.workspaceDir),
			harness.service.listModels(harness.workspaceDir),
		]);
		expect(first.models).toHaveLength(3);
		expect(second.models).toHaveLength(3);
		await harness.service.listModels(harness.workspaceDir);
		const calls = (await records(harness.recordFile)).filter((entry) => entry.type === "models_ls");
		expect(calls).toHaveLength(1);
	});

	test("catálogo vazio é válido", async () => {
		const harness = await createHarness();
		harness.setEnv({ FAKE_OMP_MODELS: "empty" });
		const catalog = await harness.service.listModels(harness.workspaceDir);
		expect(catalog.models).toEqual([]);
	});

	test("falha do OMP vira OMP_UNAVAILABLE", async () => {
		const harness = await createHarness();
		harness.setEnv({ FAKE_OMP_MODELS: "error" });
		await expectError(harness.service.listModels(harness.workspaceDir), "OMP_UNAVAILABLE");
	});

	test("catálogo acima do limite tem mensagem específica", async () => {
		const harness = await createHarness();
		harness.setEnv({ FAKE_OMP_MODELS: "huge" });
		try {
			await harness.service.listModels(harness.workspaceDir);
			throw new Error("esperava erro de limite");
		} catch (error) {
			expect(error).toBeInstanceOf(SettingsError);
			const settingsError = error as SettingsError;
			expect(settingsError.code).toBe("INTERNAL");
			expect(settingsError.message).toContain("5001");
			expect(settingsError.message).toContain("limite");
		}
	});
});
