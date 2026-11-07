import { describe, expect, test } from "bun:test";
import {
	advancedOptions,
	effectiveRole,
	expectedLayerValue,
	globalModelRoles,
	groupModels,
	modelSelector,
	normalizeAvailableModels,
	normalizeLoginProviders,
	normalizeLogoutAccounts,
	normalizeSettings,
	normalizeThinkingLevels,
	normalizeUsage,
	parseSettingInput,
	presetMapForSave,
	roleNames,
	splitModelSelector,
	validatesPreset,
	withRole,
} from "../../src/renderer/features/settings/config";

describe("normalização de settings", () => {
	test("DTO do host: camadas, presets e papéis", () => {
		const snapshot = normalizeSettings({
			global: {
				modelRoles: { default: "openai/gpt-5", executor: "openai/gpt-mini" },
				modelPresets: {
					"preset-global": { modelRoles: { default: "openai/gpt-5" } },
					"preset-global-2": { modelRoles: {}, defaultThinkingLevel: "low" },
				},
				"retry.usageAwareFallback": true,
				"retry.usageReservePct": 10,
			},
			project: {
				modelRoles: { default: "anthropic/claude" },
				modelPresets: { "preset-projeto": { modelRoles: { default: "anthropic/claude" } } },
			},
			presets: {
				"preset-global": { modelRoles: { default: "openai/gpt-5" } },
				"preset-projeto": { modelRoles: { default: "anthropic/claude" } },
				quebrado: "não é preset",
			},
			modelRoles: { default: "anthropic/claude", executor: "openai/gpt-mini" },
			updatedAt: 1700000000000,
			schema: { "retry.usageAwareFallback": { type: "boolean", description: "x" } },
		});
		expect(snapshot.global["retry.usageReservePct"]).toBe(10);
		expect(snapshot.project.modelRoles).toEqual({ default: "anthropic/claude" });
		expect(snapshot.presets["preset-global"]?.modelRoles).toEqual({ default: "openai/gpt-5" });
		expect(snapshot.presets["preset-projeto"]?.modelRoles).toEqual({ default: "anthropic/claude" });
		expect(snapshot.presets.quebrado).toBeUndefined();
		// `presetsRaw` é a camada global: o preset de projeto não pode vazar
		// para o `expectedValue` de uma gravação global.
		expect(snapshot.presetsRaw["preset-global"]).toEqual({
			modelRoles: { default: "openai/gpt-5" },
		});
		expect(snapshot.presetsRaw["preset-projeto"]).toBeUndefined();
		expect(snapshot.projectModelRoles).toEqual({ default: "anthropic/claude" });
		expect(snapshot.hasSchema).toBe(true);
		expect(snapshot.updatedAt).toBe(1700000000000);
	});

	test("config list --json: extrai value/type e omite redigido", () => {
		const snapshot = normalizeSettings({
			global: {
				"retry.usageReservePct": { value: 15, type: "number", description: "margem" },
				"auth.token": { redacted: true, type: "string" },
				"tools.approvalMode": { value: "write", type: "enum" },
			},
			project: {},
			modelRoles: {},
		});
		expect(snapshot.global["retry.usageReservePct"]).toBe(15);
		expect("auth.token" in snapshot.global).toBe(false);
		expect(snapshot.schema["retry.usageReservePct"]?.type).toBe("number");
		expect(snapshot.schema["tools.approvalMode"]?.type).toBe("enum");
	});

	test("papéis globais, efetivos e nomes", () => {
		const snapshot = normalizeSettings({
			global: { modelRoles: { default: "openai/gpt", review: "openai/o" } },
			project: { modelRoles: { review: "anthropic/c" } },
			modelRoles: { default: "openai/gpt", review: "openai/o" },
		});
		expect(roleNames(snapshot)).toEqual(["default", "review"]);
		expect(globalModelRoles(snapshot).review).toBe("openai/o");
		expect(effectiveRole(snapshot, "review")).toBe("anthropic/c");
		expect(withRole({ a: "1" }, "b", "2")).toEqual({ a: "1", b: "2" });
		expect(withRole({ a: "1", b: "2" }, "a", null)).toEqual({ b: "2" });
	});

	test("papel efetivo nunca vira expectedValue global", () => {
		const snapshot = normalizeSettings({
			global: {},
			project: { modelRoles: { default: "anthropic/c" } },
			modelRoles: { default: "anthropic/c" },
		});
		expect(globalModelRoles(snapshot)).toEqual({});
		expect(expectedLayerValue(snapshot, "global", "modelRoles")).toEqual({
			expectedMissing: true,
		});
		expect(expectedLayerValue(snapshot, "project", "modelRoles")).toEqual({
			expectedValue: { default: "anthropic/c" },
		});
	});

	test("expectedValue usa a camada crua e marca ausência", () => {
		const snapshot = normalizeSettings({
			global: { modelRoles: { default: "openai/gpt" } },
			project: {},
		});
		expect(expectedLayerValue(snapshot, "global", "modelRoles")).toEqual({
			expectedValue: { default: "openai/gpt" },
		});
		expect(expectedLayerValue(snapshot, "global", "modelPresets")).toEqual({
			expectedMissing: true,
		});
		expect(expectedLayerValue(snapshot, "project", "modelRoles")).toEqual({
			expectedMissing: true,
		});
	});

	test("preset preserva outros nomes e renomeia sem deixar órfão", () => {
		const snapshot = normalizeSettings({
			global: {
				modelPresets: {
					outro: { modelRoles: { default: "x/y" } },
					antigo: { modelRoles: { default: "a/b" } },
				},
			},
			project: {},
		});
		const next = presetMapForSave(
			snapshot,
			{ name: "novo", modelRoles: { default: "c/d" } },
			"antigo",
		);
		expect(next.outro).toEqual({ modelRoles: { default: "x/y" } });
		expect(next.novo).toEqual({ modelRoles: { default: "c/d" } });
		expect("antigo" in next).toBe(false);
	});

	test("projeção de preset remove chaves undefined", () => {
		const snapshot = normalizeSettings({
			global: {
				modelPresets: {
					existente: { modelRoles: { default: "x/y" }, defaultThinkingLevel: undefined },
				},
			},
			project: {},
		});
		const next = presetMapForSave(snapshot, {
			name: "novo",
			modelRoles: { default: "c/d" },
			defaultThinkingLevel: undefined,
		});
		expect("defaultThinkingLevel" in (next.existente as Record<string, unknown>)).toBe(false);
		expect("defaultThinkingLevel" in (next.novo as Record<string, unknown>)).toBe(false);
	});

	test("validação de preset", () => {
		expect(validatesPreset({ name: "", modelRoles: { default: "a/b" } }).ok).toBe(false);
		expect(validatesPreset({ name: "p", modelRoles: {} }).ok).toBe(false);
		expect(validatesPreset({ name: "p", modelRoles: { default: "a/b" } }).ok).toBe(true);
		expect(validatesPreset({ name: "p", modelRoles: {}, defaultThinkingLevel: "low" }).ok).toBe(true);
	});
});

describe("opções avançadas", () => {
	test("mostra só chaves anunciadas e distingue override de projeto", () => {
		const snapshot = normalizeSettings({
			global: {
				"retry.usageAwareFallback": false,
				"task.softRequestBudget": 200,
				"setting.desconhecida": 1,
			},
			project: { "retry.usageReservePct": 20 },
			schema: {
				"retry.usageAwareFallback": { type: "boolean", description: "fallback" },
				"tools.approvalMode": { type: "enum", values: ["write", "yolo"] },
			},
		});
		const options = advancedOptions(snapshot);
		const keys = options.map(option => option.key);
		expect(keys).toContain("retry.usageAwareFallback");
		expect(keys).toContain("task.softRequestBudget");
		expect(keys).toContain("retry.usageReservePct");
		expect(keys).not.toContain("setting.desconhecida");
		expect(keys).toContain("tools.approvalMode");
		const reserve = options.find(option => option.key === "retry.usageReservePct");
		expect(reserve?.hasProjectOverride).toBe(true);
		expect(reserve?.type).toBe("number");
	});
});

describe("validação de valores", () => {
	test("boolean, número, string, enum, array e record", () => {
		expect(parseSettingInput("boolean", true)).toEqual({ ok: true, value: true });
		expect(parseSettingInput("boolean", "não")).toEqual({
			ok: false,
			error: "settings.validation.boolean",
		});
		expect(parseSettingInput("number", "12.5")).toEqual({ ok: true, value: 12.5 });
		expect(parseSettingInput("number", "abc").ok).toBe(false);
		expect(parseSettingInput("record", '{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
		expect(parseSettingInput("record", "[1]").ok).toBe(false);
		expect(parseSettingInput("array", "[1,2]")).toEqual({ ok: true, value: [1, 2] });
		expect(parseSettingInput("array", "{}").ok).toBe(false);
		expect(parseSettingInput("enum", "yolo", ["write", "yolo"]).ok).toBe(true);
		expect(parseSettingInput("enum", "outro", ["write", "yolo"]).ok).toBe(false);
		expect(parseSettingInput("enum", "livre").ok).toBe(true);
	});
});

describe("modelos e raciocínio", () => {
	test("projeta apenas campos seguros e ordena", () => {
		const models = normalizeAvailableModels({
			models: [
				{ provider: "openai", id: "z", name: "Z", input: ["text", "image"], reasoning: true, baseUrl: "https://x" },
				{ provider: "anthropic", id: "c", name: "C" },
				{ provider: "openai", id: "a", name: "A" },
				{ id: "sem-provider" },
			],
		});
		expect(models).toHaveLength(3);
		expect(models[0]).toEqual({
			provider: "anthropic",
			id: "c",
			name: "C",
			image: false,
			reasoning: false,
		});
		expect("baseUrl" in models[2]).toBe(false);
		expect(models[2]?.image).toBe(true);
		expect(groupModels(models).map(group => group.provider)).toEqual(["anthropic", "openai"]);
		expect(modelSelector(models[0]!)).toBe("anthropic/c");
		expect(splitModelSelector("openai/gpt-5")).toEqual({ provider: "openai", id: "gpt-5" });
		expect(splitModelSelector("sem-barra")).toBeNull();
	});

	test("níveis só os anunciados", () => {
		expect(normalizeThinkingLevels({ levels: ["low", "high", 3] })).toEqual(["low", "high"]);
		expect(normalizeThinkingLevels(null)).toEqual([]);
	});
});

describe("contas e uso", () => {
	test("provedores e contas de logout", () => {
		expect(
			normalizeLoginProviders({
				providers: [
					{ id: "anthropic", name: "Anthropic", available: true, authenticated: true, extra: "x" },
					{ id: "x" },
				],
			}),
		).toEqual([
			{ id: "anthropic", name: "Anthropic", available: true, authenticated: true },
			{ id: "x", name: "x", available: true, authenticated: false },
		]);
		expect(
			normalizeLogoutAccounts({
				accounts: [
					{
						credentialId: 7,
						provider: "anthropic",
						label: "principal",
						detail: "e***@example.com",
						type: "oauth",
						active: true,
						tokens: "nunca",
					},
				],
			})[0],
		).toEqual({
			credentialId: 7,
			provider: "anthropic",
			label: "principal",
			detail: "e***@example.com",
			type: "oauth",
			active: true,
		});
	});

	test("uso do host preserva desconhecido e nunca inventa 0%", () => {
		const usage = normalizeUsage({
			providers: [
				{
					providerId: "anthropic",
					label: "Anthropic",
					accounts: [
						{
							label: "principal",
							active: true,
							windows: [
								{ label: "5h", usedPercent: 42 },
								{ label: "7d" },
							],
						},
					],
				},
			],
			updatedAt: 1700000000000,
			unknown: false,
		});
		expect(usage.unknown).toBe(false);
		expect(usage.providers[0]?.accounts[0]?.windows[0]).toEqual({
			label: "5h",
			usedPercent: 42,
			resetsAt: undefined,
		});
		expect(usage.providers[0]?.accounts[0]?.windows[1]?.usedPercent).toBeUndefined();
	});

	test("janela sem rótulo fica neutra e active ausente continua ausente", () => {
		const usage = normalizeUsage({
			providers: [
				{
					providerId: "p",
					accounts: [{ windows: [{ usedPercent: 10 }, {}] }],
				},
			],
			unknown: false,
		});
		const account = usage.providers[0]?.accounts[0];
		expect(account?.active).toBeUndefined();
		expect(account?.windows[0]?.label).toBe("");
		expect(account?.windows[1]?.usedPercent).toBeUndefined();
	});

	test("usage desconhecido", () => {
		expect(normalizeUsage({ providers: [], unknown: true }).unknown).toBe(true);
		expect(normalizeUsage(null).unknown).toBe(true);
		expect(normalizeUsage({ providers: [{ providerId: "p", accounts: [] }] }).unknown).toBe(true);
	});

	test("payload bruto do omp usage --json", () => {
		const usage = normalizeUsage({
			generatedAt: 123,
			reports: [
				{
					provider: "anthropic",
					limits: [
						{
							label: "5 Hour",
							window: { label: "5h", resetsAt: 999 },
							amount: { usedFraction: 0.032, unit: "percent" },
						},
						{ label: "7d", amount: { used: 5, limit: 10, unit: "requests" } },
					],
				},
			],
		});
		expect(usage.updatedAt).toBe(123);
		const windows = usage.providers[0]?.accounts[0]?.windows ?? [];
		expect(windows[0]?.usedPercent).toBeCloseTo(3.2, 5);
		expect(windows[0]?.resetsAt).toBe(999);
		expect(windows[1]?.usedPercent).toBe(50);
	});
});
