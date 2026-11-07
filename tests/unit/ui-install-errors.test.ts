import { describe, expect, test } from "bun:test";
import { installErrorKey } from "../../src/renderer/features/diagnostics/install-errors";
import { translate } from "../../src/renderer/i18n/translate";
import { LOCALES } from "../../src/renderer/i18n/types";

const KNOWN_CODES = [
	"EXISTING_INCOMPATIBLE",
	"NETWORK",
	"CHECKSUM",
	"VERSION_MISMATCH",
	"WRITE",
	"ABORTED",
	"ACTIVATION_FAILED",
	"UNSUPPORTED_PLATFORM",
];

describe("mensagens localizadas da instalação", () => {
	test("todo código conhecido tem texto traduzido nas três línguas", () => {
		for (const code of KNOWN_CODES) {
			const key = installErrorKey(code);
			expect(key).not.toBe("diag.installErrorGeneric");
			for (const locale of LOCALES) {
				const text = translate(locale, key, { message: "detalhe técnico" });
				expect(text.length).toBeGreaterThan(0);
				expect(text).not.toBe(key);
				expect(text).not.toBe(code);
			}
		}
	});

	test("código técnico cru cai no genérico localizado, nunca no código", () => {
		expect(installErrorKey("timeout")).toBe("diag.installErrorGeneric");
		expect(installErrorKey("")).toBe("diag.installErrorGeneric");
		for (const locale of LOCALES) {
			const text = translate(locale, installErrorKey("timeout"), { message: "timeout" });
			expect(text).not.toBe("timeout");
			expect(text).toContain("timeout");
		}
	});
});
