import { describe, expect, test } from "bun:test";
import { DEPENDENCY_ERROR_CODES } from "../../src/shared/dependency-install-types";
import { dependencyErrorKey } from "../../src/renderer/features/diagnostics/dependency-errors";
import { enUS } from "../../src/renderer/i18n/en-US";
import { ptBR } from "../../src/renderer/i18n/pt-BR";
import { zhCN } from "../../src/renderer/i18n/zh-CN";

describe("dependencyErrorKey", () => {
	test("cada código estável tem chave própria nos três idiomas", () => {
		for (const code of DEPENDENCY_ERROR_CODES) {
			const key = dependencyErrorKey(code);
			// INTERNAL usa o genérico por definição; os demais têm chave própria.
			if (code !== "INTERNAL") expect(key).not.toBe("dep.error.INTERNAL");
			expect(Object.hasOwn(ptBR, key)).toBe(true);
			expect(Object.hasOwn(enUS, key)).toBe(true);
			expect(Object.hasOwn(zhCN, key)).toBe(true);
		}
	});

	test("código desconhecido ou ausente cai no genérico", () => {
		expect(dependencyErrorKey(undefined)).toBe("dep.error.INTERNAL");
		expect(dependencyErrorKey("NOT_A_CODE")).toBe("dep.error.INTERNAL");
		// O texto principal nunca é o código cru.
		expect(enUS[dependencyErrorKey("CHECKSUM")]).not.toContain("CHECKSUM");
	});
});
