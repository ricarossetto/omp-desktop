import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	gitCommit,
	gitDiff,
	gitStage,
	gitStatus,
	gitUnstage,
	isBinaryBuffer,
	parsePorcelainZ,
} from "../../src/main/git";

async function git(cwd: string, args: string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} falhou: ${stderr}`);
	return stdout;
}

let root = "";
let noRepo = "";

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp git ção-"));
	noRepo = await mkdtemp(path.join(tmpdir(), "omp sem git-"));
	await git(root, ["init", "--quiet"]);
	await git(root, ["config", "user.name", "Teste OMP"]);
	await git(root, ["config", "user.email", "teste@example.invalid"]);
	await git(root, ["config", "core.autocrlf", "false"]);
	await mkdir(path.join(root, "sub"), { recursive: true });
	await writeFile(path.join(root, "olá mundo.txt"), "conteúdo\n");
	await writeFile(path.join(root, "sub", "nota.txt"), "nota\n");
	await writeFile(path.join(root, "binário.dat"), Buffer.from([0, 1, 2, 3, 0]));
	await writeFile(path.join(root, "a[b].txt"), "literal\n");
	await writeFile(path.join(root, "ab.txt"), "não deve ser preparado junto\n");
	await writeFile(path.join(root, "diff.txt"), "linha um\n");
	await writeFile(path.join(root, "remover.txt"), "remover\n");
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
	await rm(noRepo, { recursive: true, force: true });
});

describe("parsePorcelainZ", () => {
	test("lê status, renomeado e untracked", () => {
		const files = parsePorcelainZ(Buffer.from("R  novo nome.txt\0antigo nome.txt\0?? solto.txt\0", "utf8"));
		expect(files).toHaveLength(2);
		expect(files[0]).toMatchObject({
			path: "novo nome.txt",
			origPath: "antigo nome.txt",
			index: "R",
			worktree: " ",
		});
		expect(files[1]).toMatchObject({ path: "solto.txt", untracked: true });
	});
});

describe("Git em repositório descartável", () => {
	test("repo sem HEAD lista untracked e stage/unstage não altera a árvore", async () => {
		const status = await gitStatus(root);
		expect(status.isRepo).toBe(true);
		expect(status.hasHead).toBe(false);
		const untracked = status.files.filter((file) => file.untracked).map((file) => file.path);
		expect(untracked).toContain("olá mundo.txt");
		expect(untracked).toContain("binário.dat");
		expect(untracked).toContain("a[b].txt");

		const before = await readFile(path.join(root, "olá mundo.txt"), "utf8");
		await gitStage(root, ["olá mundo.txt"]);
		const staged = await gitStatus(root);
		const entry = staged.files.find((file) => file.path === "olá mundo.txt");
		expect(entry?.index).toBe("A");
		expect(await readFile(path.join(root, "olá mundo.txt"), "utf8")).toBe(before);

		await gitUnstage(root, ["olá mundo.txt"]);
		const unstaged = await gitStatus(root);
		expect(unstaged.files.find((file) => file.path === "olá mundo.txt")?.untracked).toBe(true);
		expect(await readFile(path.join(root, "olá mundo.txt"), "utf8")).toBe(before);
	});

	test("pathspec literal prepara só o arquivo com colchetes", async () => {
		await gitStage(root, ["a[b].txt"]);
		const status = await gitStatus(root);
		expect(status.files.find((file) => file.path === "a[b].txt")?.index).toBe("A");
		expect(status.files.find((file) => file.path === "ab.txt")?.untracked).toBe(true);
	});

	test("commit exige mensagem e não altera arquivos", async () => {
		await expect(gitCommit(root, "   ")).rejects.toThrow(/mensagem de commit/i);
		const status = await gitStatus(root);
		expect(status.hasHead).toBe(false);
	});

	test("primeiro commit cria HEAD e o arquivo continua na árvore", async () => {
		await gitStage(root, ["olá mundo.txt", "sub/nota.txt", "diff.txt", "remover.txt"]);
		const result = await gitCommit(root, "primeiro commit");
		expect(result.commit).toBeDefined();
		const status = await gitStatus(root);
		expect(status.hasHead).toBe(true);
		expect(status.files.find((file) => file.path === "olá mundo.txt")).toBeUndefined();
		expect(await readFile(path.join(root, "olá mundo.txt"), "utf8")).toBe("conteúdo\n");
	});

	test("working e index são diferentes e o diff traz original/modified", async () => {
		await writeFile(path.join(root, "diff.txt"), "linha dois\n");
		const working = await gitDiff(root, "diff.txt", "working");
		expect(working.path).toBe("diff.txt");
		expect(working.binary).toBe(false);
		expect(working.original).toBe("linha um\n");
		expect(working.modified).toBe("linha dois\n");
		expect(working.truncated).toBe(false);

		const index = await gitDiff(root, "diff.txt", "index");
		expect(index.original).toBe("linha um\n");
		expect(index.modified).toBe("linha um\n");

		await gitStage(root, ["diff.txt"]);
		const staged = await gitDiff(root, "diff.txt", "index");
		expect(staged.original).toBe("linha um\n");
		expect(staged.modified).toBe("linha dois\n");
	});

	test("unstage com HEAD mantém a árvore de trabalho", async () => {
		await gitUnstage(root, ["diff.txt"]);
		const status = await gitStatus(root);
		const entry = status.files.find((file) => file.path === "diff.txt");
		expect(entry?.index).toBe(" ");
		expect(entry?.worktree).toBe("M");
		expect(await readFile(path.join(root, "diff.txt"), "utf8")).toBe("linha dois\n");
	});

	test("detecta binário e alteração de arquivo removido", async () => {
		const binary = await gitDiff(root, "binário.dat", "working");
		expect(binary.binary).toBe(true);
		expect(binary.original).toBe("");
		expect(binary.modified).toBe("");
		expect(isBinaryBuffer(Buffer.from([1, 2, 0, 3]))).toBe(true);

		await unlink(path.join(root, "remover.txt"));
		const status = await gitStatus(root);
		expect(status.files.find((file) => file.path === "remover.txt")?.worktree).toBe("D");
		const removed = await gitDiff(root, "remover.txt", "working");
		expect(removed.original).toBe("remover\n");
		expect(removed.modified).toBe("");
	});

	test("renomeado é reportado com origem e destino", async () => {
		await git(root, ["mv", "olá mundo.txt", "olá renomeado.txt"]);
		const status = await gitStatus(root);
		const renamed = status.files.find((file) => file.path === "olá renomeado.txt");
		expect(renamed).toBeDefined();
		expect(renamed?.origPath).toBe("olá mundo.txt");
		expect(renamed?.index).toBe("R");
		const diff = await gitDiff(root, "olá renomeado.txt", "index");
		expect(diff.original).toBe("conteúdo\n");
		expect(diff.modified).toBe("conteúdo\n");
	});

	test("fora de repositório não inicializa nada", async () => {
		const status = await gitStatus(noRepo);
		expect(status.isRepo).toBe(false);
		expect(status.files).toEqual([]);
		await expect(gitDiff(noRepo, "arquivo.txt", "working")).rejects.toThrow(/repositório Git/i);
	});
});
