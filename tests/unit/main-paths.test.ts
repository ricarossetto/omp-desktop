import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	assertWorkspaceDirectory,
	isWithin,
	PathValidationError,
	resolveWorkspacePath,
	resolveWorkspacePathAllowMissing,
	validateRelativePath,
} from "../../src/main/paths";

const root = await mkdtemp(path.join(tmpdir(), "omp-paths-"));
const outside = await mkdtemp(path.join(tmpdir(), "omp-outside-"));
await mkdir(path.join(root, "sub"), { recursive: true });
await writeFile(path.join(root, "sub", "arquivo.txt"), "ok");
await writeFile(path.join(outside, "segredo.txt"), "não deveria ser lido");
await writeFile(path.join(root, "raiz.txt"), "raiz");

let symlinkAvailable = true;
try {
	await symlink(outside, path.join(root, "link-externo"), process.platform === "win32" ? "junction" : "dir");
} catch {
	symlinkAvailable = false;
}

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

describe("validateRelativePath", () => {
	test("rejeita traversal, absolutos POSIX, UNC e NUL em qualquer plataforma", () => {
		const invalid = [
			"",
			"..",
			"../segredo.txt",
			"sub/../../segredo.txt",
			"/etc/passwd",
			"//servidor/share/arquivo.txt",
			"arquivo\u0000.txt",
			"linha\nquebrada.txt",
		];
		for (const value of invalid) {
			expect(() => validateRelativePath(value)).toThrow(PathValidationError);
		}
	});

	if (process.platform === "win32") {
		test("rejeita regras exclusivas do Windows", () => {
			const invalid = [
				"..\\segredo.txt",
				"\\Windows",
				"\\\\servidor\\share\\arquivo.txt",
				"C:\\Windows\\System32",
				"C:Windows",
				"c:/Windows",
				"arquivo.txt:stream",
				"pasta/arquivo.txt:stream",
				'a<b>.txt',
			];
			for (const value of invalid) {
				expect(() => validateRelativePath(value)).toThrow(PathValidationError);
			}
		});
	} else {
		test("aceita nomes POSIX válidos que o Windows recusaria", () => {
			expect(validateRelativePath("pasta:com:dois/arquivo.txt")).toBe("pasta:com:dois/arquivo.txt");
			expect(validateRelativePath("a<b>.txt")).toBe("a<b>.txt");
			expect(validateRelativePath("C:relativo.txt")).toBe("C:relativo.txt");
			expect(validateRelativePath("C:\\Windows\\System32")).toBe("C:\\Windows\\System32");
			expect(validateRelativePath("arquivo.txt:stream")).toBe("arquivo.txt:stream");
			expect(validateRelativePath("..\\segredo.txt")).toBe("..\\segredo.txt");
			expect(validateRelativePath("\\Windows")).toBe("\\Windows");
			expect(validateRelativePath("\\\\servidor\\share\\arquivo.txt")).toBe(
				"\\\\servidor\\share\\arquivo.txt",
			);
		});
	}

	test("normaliza separadores e aceita nomes com Unicode/espaços", () => {
		if (process.platform === "win32") {
			expect(validateRelativePath("sub\\arquivo.txt")).toBe("sub/arquivo.txt");
		} else {
			// No POSIX a barra invertida é um caractere válido do nome.
			expect(validateRelativePath("sub\\arquivo.txt")).toBe("sub\\arquivo.txt");
		}
		expect(validateRelativePath("./sub//arquivo.txt")).toBe("sub/arquivo.txt");
		expect(validateRelativePath("olá mundo/ção.txt")).toBe("olá mundo/ção.txt");
	});
});

describe("isWithin", () => {
	test("compara caixa e separadores no Windows", () => {
		expect(isWithin(root, path.join(root, "sub", "arquivo.txt"))).toBe(true);
		expect(isWithin(root, root)).toBe(true);
		expect(isWithin(root, outside)).toBe(false);
		expect(isWithin(root, path.join(root, "..", "fora.txt"))).toBe(false);
	});
});

describe("resolveWorkspacePath", () => {
	test("resolve arquivo dentro do workspace", async () => {
		const relative = process.platform === "win32" ? "sub\\arquivo.txt" : "sub/arquivo.txt";
		const resolved = await resolveWorkspacePath(root, relative);
		expect(resolved.relativePath).toBe("sub/arquivo.txt");
		expect(resolved.realPath.toLowerCase()).toContain("arquivo.txt");
		expect(isWithin(resolved.rootRealPath, resolved.realPath)).toBe(true);
	});

	if (process.platform !== "win32") {
		test("aceita nome POSIX com barra invertida literal", async () => {
			const literal = "sub\\literal.txt";
			await writeFile(path.join(root, literal), "ok");
			const resolved = await resolveWorkspacePath(root, literal);
			expect(resolved.relativePath).toBe(literal);
			expect(resolved.realPath).toContain(literal);
			expect(isWithin(resolved.rootRealPath, resolved.realPath)).toBe(true);
		});
	}

	test("recusa traversal e UNC mesmo antes de tocar no disco", async () => {
		await expect(resolveWorkspacePath(root, "../segredo.txt")).rejects.toThrow(PathValidationError);
		await expect(resolveWorkspacePath(root, "\\\\servidor\\share")).rejects.toThrow(PathValidationError);
	});

	test("recusa link simbólico que escapa do workspace", async () => {
		if (!symlinkAvailable) return;
		await expect(resolveWorkspacePath(root, "link-externo/segredo.txt")).rejects.toThrow(PathValidationError);
		await expect(resolveWorkspacePathAllowMissing(root, "link-externo/segredo.txt")).rejects.toThrow(
			PathValidationError,
		);
	});

	test("allowMissing aceita arquivo deletado cujo pai existe", async () => {
		const resolved = await resolveWorkspacePathAllowMissing(root, "sub/deletado.txt");
		expect(resolved.relativePath).toBe("sub/deletado.txt");
		expect(isWithin(resolved.rootRealPath, resolved.realPath)).toBe(true);
	});

	test("allowMissing recusa pai inexistente", async () => {
		await expect(resolveWorkspacePathAllowMissing(root, "nao-existe/arquivo.txt")).rejects.toThrow(
			PathValidationError,
		);
	});

	test("assertWorkspaceDirectory exige diretório existente", async () => {
		expect((await assertWorkspaceDirectory(root)).toLowerCase()).toBe((await realpath(root)).toLowerCase());
		await expect(assertWorkspaceDirectory(path.join(root, "raiz.txt"))).rejects.toThrow(PathValidationError);
		await expect(assertWorkspaceDirectory(path.join(root, "sumiu"))).rejects.toThrow(PathValidationError);
	});
});
