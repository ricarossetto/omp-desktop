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
	await symlink(outside, path.join(root, "link-externo"), "junction");
} catch {
	symlinkAvailable = false;
}

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

describe("validateRelativePath", () => {
	test("rejeita traversal, absolutos, UNC, ADS e NUL", () => {
		const invalid = [
			"",
			"..",
			"../segredo.txt",
			"..\\segredo.txt",
			"sub/../../segredo.txt",
			"C:\\Windows\\System32",
			"C:Windows",
			"c:/Windows",
			"/etc/passwd",
			"\\Windows",
			"\\\\servidor\\share\\arquivo.txt",
			"//servidor/share/arquivo.txt",
			"arquivo.txt:stream",
			"pasta/arquivo.txt:stream",
			"arquivo\u0000.txt",
			'a<b>.txt',
		];
		for (const value of invalid) {
			expect(() => validateRelativePath(value)).toThrow(PathValidationError);
		}
	});

	test("normaliza separadores e aceita nomes com Unicode/espaços", () => {
		expect(validateRelativePath("sub\\arquivo.txt")).toBe("sub/arquivo.txt");
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
		const resolved = await resolveWorkspacePath(root, "sub\\arquivo.txt");
		expect(resolved.relativePath).toBe("sub/arquivo.txt");
		expect(resolved.realPath.toLowerCase()).toContain("arquivo.txt");
		expect(isWithin(resolved.rootRealPath, resolved.realPath)).toBe(true);
	});

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
