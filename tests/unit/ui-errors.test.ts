import { describe, expect, test } from "bun:test";
import { ERROR_CODES } from "../../src/shared/contracts";
import { DesktopError } from "../../src/renderer/api";
import {
	errorCode,
	errorDetail,
	errorText,
	localizeError,
} from "../../src/renderer/features/errors/error-messages";
import type { MessageKey } from "../../src/renderer/i18n/pt-BR";
import { translate } from "../../src/renderer/i18n/translate";
import { LOCALES } from "../../src/renderer/i18n/types";
import {
	MAX_ATTACHMENT_BYTES,
	attachmentLimitExceeded,
	createAppStore,
} from "../../src/renderer/store/create-store";

const en = (key: MessageKey, params?: Record<string, string | number>): string =>
	translate("en-US", key, params);

describe("localizeError", () => {
	test("mapeia todos os códigos de ERROR_CODES para error.<CODE> nas três línguas", () => {
		for (const code of ERROR_CODES) {
			const key = `error.${code}` as MessageKey;
			for (const locale of LOCALES) {
				const text = translate(locale, key, { detail: "detalhe-tecnico" });
				expect({ code, locale, text }).not.toEqual({ code, locale, text: key });
				expect(text).toContain("detalhe-tecnico");
				expect(text).not.toContain("{detail}");
			}
		}
	});

	test("usa a mensagem do host apenas como detalhe", () => {
		const error = new DesktopError({ code: "CONFIG_CONFLICT", message: "config.json mudou" });
		const text = localizeError(error, en);
		expect(text).toContain("configuration");
		expect(text).toContain("config.json mudou");
		expect(text).not.toContain("A configuração");
	});

	test("interpola {detail} e usa Indisponível quando o host não manda mensagem", () => {
		const text = localizeError({ code: "INTERNAL" }, en);
		expect(text).toBe(
			translate("en-US", "error.INTERNAL", { detail: translate("en-US", "common.unavailable") }),
		);
		expect(text).not.toContain("{detail}");
	});

	test("cai no detalhe para código desconhecido e no texto do erro sem código", () => {
		expect(localizeError({ code: "CODIGO_NOVO", message: "detalhe bruto" }, en)).toBe("detalhe bruto");
		expect(localizeError(new Error("falhou"), en)).toBe("falhou");
		expect(localizeError("texto simples", en)).toBe("texto simples");
		expect(localizeError({}, en)).toBe(translate("en-US", "error.unexpected"));
	});

	test("errorText respeita o locale pedido", () => {
		const error = new DesktopError({ code: "OMP_UNAVAILABLE", message: "omp sumiu" });
		expect(errorText(error, "en-US")).toContain("OMP executable");
		expect(errorText(error, "pt-BR")).toContain("executável do OMP");
		expect(errorText(error, "zh-CN")).toContain("OMP 可执行文件");
	});
});

describe("errorCode e errorDetail", () => {
	test("extraem o código do DesktopError e de objetos com code string", () => {
		expect(errorCode(new DesktopError({ code: "SESSION_BUSY", message: "x" }))).toBe("SESSION_BUSY");
		expect(errorCode({ code: "UNSUPPORTED" })).toBe("UNSUPPORTED");
		expect(errorCode({ code: 1 })).toBeUndefined();
		expect(errorCode("x")).toBeUndefined();
	});

	test("extraem o detalhe técnico sem inventar texto", () => {
		expect(errorDetail(new DesktopError({ code: "INTERNAL", message: "boom" }))).toBe("boom");
		expect(errorDetail(new Error("x"))).toBe("x");
		expect(errorDetail("x")).toBe("x");
		expect(errorDetail("   ")).toBeUndefined();
		expect(errorDetail({})).toBeUndefined();
	});
});

describe("avisos do store", () => {
	test("seguem o idioma ativo em vez de pt-BR fixo", async () => {
		const store = createAppStore();
		store.actions.setLocale("en-US");
		await store.actions.openWorkspace("projeto-ausente");
		const notice = store.getState().notices.at(-1);
		expect(notice?.text).toBe(translate("en-US", "store.workspaceMissing"));
	});

	test("traduzem o limite de anexo com o valor de 600 KiB", () => {
		expect(translate("en-US", "store.attachmentTooLarge", { limit: 600 })).toContain("600 KiB");
		expect(translate("pt-BR", "store.attachmentTooLarge", { limit: 600 })).toContain("600 KiB");
		expect(translate("zh-CN", "store.attachmentTooLarge", { limit: 600 })).toContain("600 KiB");
	});
});

describe("limite de anexo", () => {
	test("é o mesmo 600 KiB do main/host", () => {
		expect(MAX_ATTACHMENT_BYTES).toBe(600 * 1024);
		expect(attachmentLimitExceeded(MAX_ATTACHMENT_BYTES)).toBe(false);
		expect(attachmentLimitExceeded(MAX_ATTACHMENT_BYTES + 1)).toBe(true);
		expect(attachmentLimitExceeded(20 * 1024 * 1024)).toBe(true);
	});
});
