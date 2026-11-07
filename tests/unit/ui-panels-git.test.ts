import { describe, expect, test } from "bun:test";
import type { GitFileStatus } from "@shared/contracts";
import {
	describeGitFile,
	diffLanguageFor,
	displayPath,
	normalizeGitDiff,
	normalizeGitStatus,
	sortGitFiles,
	statusSummary,
} from "../../src/renderer/features/changes/git-display";

function file(partial: Partial<GitFileStatus> & { path: string }): GitFileStatus {
	return { index: " ", worktree: " ", untracked: false, ...partial };
}

describe("status Git para exibição", () => {
	test("não rastreado é destacado e não é preparado", () => {
		const view = describeGitFile(file({ path: "novo.txt", index: "?", worktree: "?", untracked: true }));
		expect(view.label).toBe("Não rastreado");
		expect(view.untracked).toBe(true);
		expect(view.staged).toBe(false);
		expect(view.unstaged).toBe(true);
	});

	test("modificado no índice e na árvore expõe as duas ações", () => {
		const view = describeGitFile(file({ path: "a.ts", index: "M", worktree: "M" }));
		expect(view.label).toBe("Modificado");
		expect(view.staged).toBe(true);
		expect(view.unstaged).toBe(true);
	});

	test("renomeado usa origPath, deletado e conflito têm tons próprios", () => {
		const renamed = describeGitFile(file({ path: "novo nome.txt", index: "R", worktree: " ", origPath: "antigo nome.txt" }));
		expect(renamed.label).toBe("Renomeado");
		expect(displayPath(renamed)).toBe("antigo nome.txt → novo nome.txt");

		expect(describeGitFile(file({ path: "x", index: "D", worktree: " " })).label).toBe("Removido");
		const conflict = describeGitFile(file({ path: "y", index: "U", worktree: "U" }));
		expect(conflict.label).toBe("Conflito");
		expect(conflict.tone).toBe("error");
	});

	test("arquivo binário carrega o aviso", () => {
		const view = describeGitFile(file({ path: "img.png", index: "A", worktree: " ", binary: true }));
		expect(view.label).toBe("Novo");
		expect(view.isBinary).toBe(true);
	});

	test("ordena não rastreados, depois preparados, por caminho", () => {
		const sorted = sortGitFiles([
			file({ path: "z.txt", index: "M", worktree: " " }),
			file({ path: "a.txt", index: "?", worktree: "?", untracked: true }),
			file({ path: "m.txt", index: " ", worktree: "M" }),
			file({ path: "b.txt", index: "?", worktree: "?", untracked: true }),
		]);
		expect(sorted.map(entry => entry.path)).toEqual(["a.txt", "b.txt", "z.txt", "m.txt"]);
	});

	test("resumo e repositório ausente", () => {
		expect(statusSummary({ isRepo: false, hasHead: false, files: [] })).toBe("Fora de um repositório Git");
		expect(
			statusSummary({
				isRepo: true,
				hasHead: true,
				files: [file({ path: "a" }), file({ path: "b" })],
			}),
		).toBe("2 arquivos alterados");
	});
});

describe("normalização defensiva de Git", () => {
	test("status aceita DTO e ignora entradas inválidas", () => {
		const status = normalizeGitStatus({
			isRepo: true,
			hasHead: false,
			branch: "main",
			files: [
				{ path: "ok.txt", index: "M", worktree: " ", untracked: false },
				{ path: "", index: "M" },
				{ path: "bin.dat", index: "A", worktree: " ", binary: true },
				"lixo",
			],
		});
		expect(status.isRepo).toBe(true);
		expect(status.hasHead).toBe(false);
		expect(status.branch).toBe("main");
		expect(status.files.map(entry => entry.path)).toEqual(["ok.txt", "bin.dat"]);
	});

	test("diff usa path/source pedidos quando payload é inválido", () => {
		const diff = normalizeGitDiff(null, "a.ts", "index");
		expect(diff.path).toBe("a.ts");
		expect(diff.source).toBe("index");
		expect(diff.original).toBe("");
		expect(diff.truncated).toBe(false);
	});
});

describe("linguagem do diff", () => {
	test("extensões conhecidas e desconhecidas", () => {
		expect(diffLanguageFor("src/a.ts")).toBe("typescript");
		expect(diffLanguageFor("UI/App.TSX")).toBe("typescript");
		expect(diffLanguageFor("docs/leiame.md")).toBe("markdown");
		expect(diffLanguageFor("Dockerfile")).toBe("dockerfile");
		expect(diffLanguageFor("arquivo.semextensao")).toBe("plaintext");
		expect(diffLanguageFor("C:\\repo\\config.yml")).toBe("yaml");
	});
});
