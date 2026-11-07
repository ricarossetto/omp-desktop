import { describe, expect, test } from "bun:test";
import { detectLocale, isLocale, LOCALES, translate } from "../../src/renderer/i18n";
import { enUS } from "../../src/renderer/i18n/en-US";
import { ptBR } from "../../src/renderer/i18n/pt-BR";
import { zhCN } from "../../src/renderer/i18n/zh-CN";

const dictionaries = { "pt-BR": ptBR, "en-US": enUS, "zh-CN": zhCN } as const;
const keys = Object.keys(ptBR).sort();

describe("dicionários de i18n", () => {
	test("os três idiomas têm exatamente as mesmas chaves", () => {
		for (const locale of LOCALES) {
			expect(Object.keys(dictionaries[locale]).sort()).toEqual(keys);
		}
	});

	test("nenhuma tradução está vazia", () => {
		for (const locale of LOCALES) {
			for (const key of keys) {
				const value = dictionaries[locale][key as keyof typeof ptBR];
				expect(typeof value).toBe("string");
				expect(value.trim().length).toBeGreaterThan(0);
			}
		}
	});

	test("a interpolação de cada chave é preservada nos três idiomas", () => {
		for (const key of keys) {
			const expected = [...ptBR[key as keyof typeof ptBR].matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
			for (const locale of LOCALES) {
				const value = dictionaries[locale][key as keyof typeof ptBR];
				const actual = [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
				expect(actual).toEqual(expected);
			}
		}
	});

	test("en-US e zh-CN não deixam texto em português nas chaves de interface", () => {
		const suspicious = /(ção|ções|\bnão\b|\bvocê\b|\bpara\b|\buma\b|\bnada\b|Indisponível|Carregando|Fechar|Abrir|Enviar)/i;
		for (const key of keys) {
			for (const locale of ["en-US", "zh-CN"] as const) {
				const value = dictionaries[locale][key as keyof typeof ptBR];
				expect({ key, locale, leaked: suspicious.test(value) }).toEqual({ key, locale, leaked: false });
			}
		}
	});
});

describe("detectLocale", () => {
	test("reconhece os três idiomas e variantes regionais", () => {
		expect(detectLocale("pt-BR")).toBe("pt-BR");
		expect(detectLocale("pt-PT")).toBe("pt-BR");
		expect(detectLocale("en-US")).toBe("en-US");
		expect(detectLocale("en-GB")).toBe("en-US");
		expect(detectLocale("zh-CN")).toBe("zh-CN");
		expect(detectLocale("zh-TW")).toBe("zh-CN");
	});

	test("cai no pt-BR para idioma ausente ou desconhecido", () => {
		expect(detectLocale(undefined)).toBe("pt-BR");
		expect(detectLocale("")).toBe("pt-BR");
		expect(detectLocale("fr-FR")).toBe("pt-BR");
	});

	test("isLocale aceita apenas os idiomas suportados", () => {
		expect(isLocale("pt-BR")).toBe(true);
		expect(isLocale("en-US")).toBe(true);
		expect(isLocale("zh-CN")).toBe(true);
		expect(isLocale("es-ES")).toBe(false);
		expect(isLocale(undefined)).toBe(false);
	});
});

describe("translate", () => {
	test("devolve o texto chinês com pontuação chinesa", () => {
		expect(translate("zh-CN", "common.cancel")).toBe("取消");
		expect(translate("zh-CN", "common.close")).toBe("关闭");
		expect(translate("zh-CN", "dialog.confirmTitle")).toBe("需要确认");
	});

	test("interpola parâmetros no idioma pedido", () => {
		expect(translate("pt-BR", "shell.pendingApprovals", { count: 3 })).toBe("3 aprovações pendentes");
		expect(translate("en-US", "shell.pendingApprovals", { count: 3 })).toBe("3 pending approvals");
		expect(translate("zh-CN", "shell.pendingApprovals", { count: 3 })).toBe("3 个待处理审批");
	});

	test("mantém o marcador quando o parâmetro não é informado", () => {
		expect(translate("en-US", "changes.stagedMany", {})).toBe("{count} files staged.");
	});

	test("traduz erros de diálogo no idioma ativo", () => {
		expect(translate("en-US", "dialog.selectRequired")).toBe("Select an option to continue.");
		expect(translate("zh-CN", "dialog.answerAll")).toBe("请回答所有问题以继续。");
	});
});
