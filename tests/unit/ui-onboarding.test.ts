import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry } from "@shared/contracts";
import { createI18n } from "../../src/renderer/i18n";
import {
	filterModelCatalog,
	groupModelCatalog,
	selectorMatchesRole,
	withDefaultRole,
} from "../../src/renderer/features/onboarding/onboarding-model";
import {
	filterProviders,
	isEventForSession,
	matchesAccountQuery,
	redactUrlForDisplay,
} from "../../src/renderer/features/accounts/accounts-filter";

const models: ModelCatalogEntry[] = [
	{
		provider: "fake",
		id: "fake-model",
		name: "Fake Model",
		selector: "fake/fake-model",
		contextWindow: 200_000,
		reasoning: true,
	},
	{
		provider: "fake",
		id: "fast-model",
		name: "Fast Model",
		selector: "fake/fast-model",
	},
	{
		provider: "outro",
		id: "smart-model",
		name: "Smart Model",
		selector: "outro/smart-model",
		contextWindow: 1_000_000,
	},
];

describe("busca do catálogo de modelos", () => {
	test("sem busca devolve a lista inteira", () => {
		expect(filterModelCatalog(models, "  ")).toHaveLength(3);
	});

	test("filtra por nome, provedor, id e seletor", () => {
		expect(filterModelCatalog(models, "fast").map((model) => model.id)).toEqual(["fast-model"]);
		expect(filterModelCatalog(models, "outro").map((model) => model.id)).toEqual(["smart-model"]);
		expect(filterModelCatalog(models, "smart-model").map((model) => model.id)).toEqual(["smart-model"]);
		expect(filterModelCatalog(models, "fake/").map((model) => model.id)).toEqual([
			"fake-model",
			"fast-model",
		]);
	});

	test("busca sem resultado devolve lista vazia", () => {
		expect(filterModelCatalog(models, "inexistente")).toEqual([]);
	});

	test("agrupa por provedor preservando a ordem", () => {
		const groups = groupModelCatalog(models);
		expect(groups.map((group) => group.provider)).toEqual(["fake", "outro"]);
		expect(groups[0]?.models).toHaveLength(2);
		expect(groups[1]?.models[0]?.id).toBe("smart-model");
	});
});

describe("papel default", () => {
	test("compara ignorando o sufixo de raciocínio", () => {
		expect(selectorMatchesRole("fake/fake-model", "fake/fake-model")).toBe(true);
		expect(selectorMatchesRole("fake/fake-model", "fake/fake-model:high")).toBe(true);
		expect(selectorMatchesRole("fake/fake-model", "fake/outro:high")).toBe(false);
		expect(selectorMatchesRole("fake/fake-model", undefined)).toBe(false);
	});

	test("troca só o papel default preservando os demais", () => {
		const next = withDefaultRole({ default: "fake/fake-model", smol: "fake/fast-model" }, "outro/smart-model");
		expect(next).toEqual({ default: "outro/smart-model", smol: "fake/fast-model" });
	});

	test("remover o default não apaga outros papéis", () => {
		expect(withDefaultRole({ default: "fake/fake-model", smol: "fake/fast-model" }, null)).toEqual({
			smol: "fake/fast-model",
		});
	});
});

describe("formatação de percentual", () => {
	test("desconhecido vira Indisponível no idioma ativo", () => {
		expect(createI18n("pt-BR").formatPercent(undefined)).toBe("Indisponível");
		expect(createI18n("en-US").formatPercent(Number.NaN)).toBe("Unavailable");
		expect(createI18n("zh-CN").formatPercent(undefined)).toBe("不可用");
	});

	test("percentual conhecido continua formatado", () => {
		expect(createI18n("pt-BR").formatPercent(42)).toBe("42%");
		expect(createI18n("en-US").formatPercent(3.2)).toBe("3.2%");
	});
});

describe("busca de contas", () => {
	test("compara nome, e-mail, plano, tipo e id de credencial", () => {
		expect(matchesAccountQuery("dev@", ["dev@example.com"])).toBe(true);
		expect(matchesAccountQuery("pro", ["Pro"])).toBe(true);
		expect(matchesAccountQuery("42", [42])).toBe(true);
		expect(matchesAccountQuery("  ", [undefined])).toBe(true);
		expect(matchesAccountQuery("nada", ["dev@example.com", "Pro"])).toBe(false);
	});

	test("mantém o provedor quando o nome ou uma conta corresponde", () => {
		const providers = [
			{ id: "fake", name: "Fake" },
			{ id: "outro", name: "Outro" },
		];
		const accounts: Record<string, Array<{ credentialId?: number; label?: string; detail?: string; type?: string }>> = {
			fake: [{ credentialId: 7, label: "dev@example.com", detail: "Pro", type: "oauth" }],
			outro: [{ credentialId: 8, label: "equipe@example.com", detail: "Free", type: "api_key" }],
		};
		expect(
			filterProviders(providers, "dev@", (id) => accounts[id] ?? []).map((provider) => provider.id),
		).toEqual(["fake"]);
		expect(
			filterProviders(providers, "outro", (id) => accounts[id] ?? []).map((provider) => provider.id),
		).toEqual(["outro"]);
		expect(
			filterProviders(providers, "8", (id) => accounts[id] ?? []).map((provider) => provider.id),
		).toEqual(["outro"]);
		expect(filterProviders(providers, "", (id) => accounts[id] ?? [])).toHaveLength(2);
	});

	test("redige credenciais em query e fragmento da URL", () => {
		const redacted = redactUrlForDisplay(
			"https://auth.example/cb?code=abc&state=ok#access_token=segredo&token_type=bearer",
		);
		expect(redacted).toContain("code=***");
		expect(redacted).toContain("state=ok");
		expect(redacted).toContain("access_token=***");
		expect(redacted).not.toContain("segredo");
	});

	test("evento de login só vale para a mesma janela e sessão", () => {
		expect(isEventForSession({ workspaceId: "w", sessionId: "s" }, "w", "s")).toBe(true);
		expect(isEventForSession({ workspaceId: "w", sessionId: "outra" }, "w", "s")).toBe(false);
		expect(isEventForSession({ workspaceId: "outro", sessionId: "s" }, "w", "s")).toBe(false);
		expect(isEventForSession({ workspaceId: "w" }, "w", "s")).toBe(false);
	});
});
