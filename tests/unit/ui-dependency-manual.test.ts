import { describe, expect, test } from "bun:test";
import {
	NATIVE_GIT_COMMANDS,
	type DependencyErrorCode,
} from "../../src/shared/dependency-install-types";
import { dependencyErrorKey } from "../../src/renderer/features/diagnostics/dependency-errors";
import {
	manualInstructions,
	runtimePlatform,
} from "../../src/renderer/features/diagnostics/dependency-platform";
import { translate } from "../../src/renderer/i18n/translate";
import { LOCALES } from "../../src/renderer/i18n/types";
import { enUS } from "../../src/renderer/i18n/en-US";
import { ptBR } from "../../src/renderer/i18n/pt-BR";
import { zhCN } from "../../src/renderer/i18n/zh-CN";

const dictionaries = { "pt-BR": ptBR, "en-US": enUS, "zh-CN": zhCN } as const;

describe("instruções manuais por plataforma", () => {
	test("Linux/Git mostra comandos fixos apt e pacman, sem executá-los", () => {
		const instructions = manualInstructions("linux", "git");
		expect(instructions.url).toBe("https://git-scm.com/download/linux");
		expect(instructions.commands).toEqual([
			{ distro: "debian", command: NATIVE_GIT_COMMANDS.debian },
			{ distro: "arch", command: NATIVE_GIT_COMMANDS.arch },
		]);
		expect(NATIVE_GIT_COMMANDS.debian).toBe("sudo apt install git");
		expect(NATIVE_GIT_COMMANDS.arch).toBe("sudo pacman -S git");
	});

	test("Windows/Git mantém a página oficial e não mostra apt/pacman", () => {
		const instructions = manualInstructions("win32", "git");
		expect(instructions.url).toBe("https://git-scm.com/download/win");
		expect(instructions.commands).toEqual([]);
	});

	test("Node usa a página oficial em qualquer plataforma", () => {
		for (const platform of ["win32", "linux"] as const) {
			expect(manualInstructions(platform, "node")).toEqual({
				url: "https://nodejs.org/en/download",
				commands: [],
			});
		}
	});

	test("runtimePlatform cai no Windows quando o campo está ausente", () => {
		expect(runtimePlatform(null)).toBe("win32");
		expect(runtimePlatform({ phase: "ready", signed: false })).toBe("win32");
		expect(runtimePlatform({ phase: "ready", platform: "linux", signed: false })).toBe("linux");
	});
});

describe("mensagens da instalação nativa", () => {
	const codes: DependencyErrorCode[] = ["MANUAL_INSTALL_REQUIRED", "MISSING_SYSTEM_LIBRARY"];

	test("códigos têm chave própria e texto nos três idiomas", () => {
		for (const code of codes) {
			const key = dependencyErrorKey(code);
			expect(key).not.toBe("dep.error.INTERNAL");
			for (const locale of LOCALES) {
				const text = translate(locale, key);
				expect(text.length).toBeGreaterThan(0);
				expect(text).not.toBe(key);
				expect(text).not.toBe(code);
			}
		}
	});

	test("as chaves novas existem nos três dicionários", () => {
		for (const key of [
			"dep.nativeGitTitle",
			"dep.nativeGitBody",
			"dep.debianUbuntu",
			"dep.archLinux",
			"dep.copyCommand",
			"dep.copied",
			"dep.copyFailed",
			"dep.error.MANUAL_INSTALL_REQUIRED",
			"dep.error.MISSING_SYSTEM_LIBRARY",
		] as const) {
			for (const locale of LOCALES) {
				expect(Object.hasOwn(dictionaries[locale], key)).toBe(true);
			}
		}
	});
});
