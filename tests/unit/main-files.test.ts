import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	readWorkspaceFile,
	externalOpenMode,
	isExecutableFile,
	resolveFileForExternalOpen,
} from "../../src/main/files";
import { PathValidationError } from "../../src/main/paths";

const root = await mkdtemp(path.join(tmpdir(), "omp-files-"));
await writeFile(path.join(root, "texto.txt"), "linha 1\nlinha 2\n");
await writeFile(path.join(root, "binario.bin"), Buffer.from([1, 0, 2, 3]));
await writeFile(path.join(root, "grande.txt"), "x".repeat(4096));

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("files.read", () => {
	test("lê texto dentro do workspace", async () => {
		const result = await readWorkspaceFile(root, "texto.txt");
		expect(result.content).toBe("linha 1\nlinha 2\n");
		expect(result.binary).toBe(false);
		expect(result.truncated).toBe(false);
		expect(result.size).toBeGreaterThan(0);
	});

	test("detecta binário e não devolve conteúdo", async () => {
		const result = await readWorkspaceFile(root, "binario.bin");
		expect(result.binary).toBe(true);
		expect(result.content).toBeUndefined();
	});

	test("trunca arquivos acima do limite", async () => {
		const result = await readWorkspaceFile(root, "grande.txt", 1024);
		expect(result.truncated).toBe(true);
		expect(result.content?.length).toBe(1024);
	});

	test("recusa traversal", async () => {
		await expect(readWorkspaceFile(root, "../texto.txt")).rejects.toThrow(PathValidationError);
		await expect(resolveFileForExternalOpen(root, "..\\texto.txt")).rejects.toThrow(PathValidationError);
	});

	test("allowlist abre texto/imagem/pdf e apenas revela executáveis", async () => {
		await writeFile(path.join(root, "script.bat"), "@echo off\n");
		await writeFile(path.join(root, "pagina.html"), "<script>alert(1)</script>\n");
		// O caminho continua validado dentro do workspace; o tipo decide open/reveal.
		expect(await resolveFileForExternalOpen(root, "script.bat")).toContain("script.bat");
		expect(await resolveFileForExternalOpen(root, "texto.txt")).toContain("texto.txt");

		for (const safe of [
			"texto.txt",
			"README.md",
			"dados.json",
			"config.yaml",
			"config.yml",
			"notas.toml",
			"app.log",
			"tabela.csv",
			"foto.png",
			"foto.jpg",
			"foto.webp",
			"foto.gif",
			"documento.pdf",
			"codigo.ts",
			"codigo.tsx",
			"codigo.py",
			"codigo.rs",
			"codigo.go",
			"Makefile",
			".gitignore",
		]) {
			expect(externalOpenMode(safe)).toBe("open");
		}

		for (const dangerous of [
			"script.bat",
			"script.cmd",
			"script.ps1",
			"script.vbs",
			"script.wsf",
			"script.hta",
			"script.js",
			"script.mjs",
			"script.cjs",
			"pagina.html",
			"imagem.svg",
			"dados.xml",
			"atalho.lnk",
			"atalho.url",
			"app.exe",
			"instalador.msi",
			"screensaver.scr",
			"legado.com",
			"config.reg",
			"pacote.jar",
			"arquivo.bin",
			"sem-extensao",
		]) {
			expect(externalOpenMode(dangerous)).toBe("reveal");
		}
	});

	if (process.platform !== "win32") {
		test("POSIX revela scripts de shell e qualquer arquivo executável", async () => {
			for (const script of ["script.sh", "script.bash", "script.zsh", "script.fish", "script.command", "script.run"]) {
				expect(externalOpenMode(script)).toBe("reveal");
			}
			const executable = path.join(root, "texto-executavel.txt");
			await writeFile(executable, "#!/bin/sh\necho oi\n");
			await chmod(executable, 0o755);
			expect(await isExecutableFile(executable)).toBe(true);
			await chmod(executable, 0o644);
			expect(await isExecutableFile(executable)).toBe(false);
		});
	}
});
