/**
 * Apresentação de status Git e utilitários puros do painel de alterações.
 * O host entrega GitStatusResult já parseado do porcelain v1.
 */
import type { GitDiffResult, GitFileStatus, GitStatusResult } from "@shared/contracts";
import { translate } from "../../i18n/translate";
import type { Locale } from "../../i18n/types";
import type { MessageKey } from "../../i18n/pt-BR";
import { isRecord, unwrapRpcData } from "../agents/ui-utils";

export type GitTone = "normal" | "warning" | "error" | "muted";

export interface GitFileDisplay {
	path: string;
	label: string;
	staged: boolean;
	unstaged: boolean;
	untracked: boolean;
	renamedFrom?: string;
	tone: GitTone;
	codes: string[];
	isBinary: boolean;
}

type GitFileKind =
	| "untracked"
	| "conflict"
	| "renamed"
	| "deleted"
	| "added"
	| "copied"
	| "typeChanged"
	| "modified"
	| "changed";

const KIND_KEYS: Record<GitFileKind, MessageKey> = {
	untracked: "changes.fileUntracked",
	conflict: "changes.fileConflict",
	renamed: "changes.fileRenamed",
	deleted: "changes.fileDeleted",
	added: "changes.fileAdded",
	copied: "changes.fileCopied",
	typeChanged: "changes.fileTypeChanged",
	modified: "changes.fileModified",
	changed: "changes.fileChanged",
};

function kindForCodes(index: string, worktree: string, untracked: boolean, renamedFrom?: string): GitFileKind {
	if (untracked || index === "?" || worktree === "?") return "untracked";
	const both = `${index}${worktree}`;
	if (index === "U" || worktree === "U" || both === "AA" || both === "DD") return "conflict";
	if (index === "R" || worktree === "R" || renamedFrom) return "renamed";
	if (index === "D" || worktree === "D") return "deleted";
	if (index === "A" || worktree === "A") return "added";
	if (index === "C" || worktree === "C") return "copied";
	if (index === "T" || worktree === "T") return "typeChanged";
	if (index === "M" || worktree === "M") return "modified";
	return "changed";
}

function toneForKind(kind: GitFileKind): GitTone {
	if (kind === "conflict") return "error";
	if (kind === "deleted") return "warning";
	if (kind === "untracked" || kind === "added") return "normal";
	return "muted";
}

/** Traduz os códigos X/Y do porcelain v1 para rótulos e ações possíveis. */
export function describeGitFile(file: GitFileStatus, locale: Locale = "pt-BR"): GitFileDisplay {
	const index = file.index || " ";
	const worktree = file.worktree || " ";
	const untracked = file.untracked || index === "?" || worktree === "?";
	const kind = kindForCodes(index, worktree, untracked, file.origPath);
	const codes = [index.trim(), worktree.trim()].filter(Boolean);
	const staged = !untracked && index !== " " && index !== "?" && index !== "";
	const unstaged = untracked || (worktree !== " " && worktree !== "?" && worktree !== "");
	return {
		path: file.path,
		label: translate(locale, KIND_KEYS[kind]),
		staged,
		unstaged,
		untracked,
		renamedFrom: file.origPath,
		tone: toneForKind(kind),
		codes,
		isBinary: file.binary === true,
	};
}

export function sortGitFiles(files: readonly GitFileStatus[], locale: Locale = "pt-BR"): GitFileStatus[] {
	return [...files].sort((left, right) => {
		const leftDisplay = describeGitFile(left);
		const rightDisplay = describeGitFile(right);
		if (leftDisplay.untracked !== rightDisplay.untracked) return leftDisplay.untracked ? -1 : 1;
		if (leftDisplay.staged !== rightDisplay.staged) return leftDisplay.staged ? -1 : 1;
		return left.path.localeCompare(right.path, locale);
	});
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "json",
	json5: "json",
	css: "css",
	scss: "scss",
	less: "less",
	html: "html",
	htm: "html",
	xml: "xml",
	svg: "xml",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	kts: "kotlin",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	ps1: "powershell",
	psm1: "powershell",
	bat: "bat",
	cmd: "bat",
	yml: "yaml",
	yaml: "yaml",
	toml: "ini",
	ini: "ini",
	sql: "sql",
	graphql: "graphql",
	gql: "graphql",
	dockerfile: "dockerfile",
};

/** Linguagem do Monaco a partir da extensão/nome; desconhecida vira texto puro. */
export function diffLanguageFor(path: string): string {
	const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
	if (name === "dockerfile") return "dockerfile";
	if (name === "makefile") return "makefile";
	if (name.startsWith(".env")) return "ini";
	const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
	return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}

export interface FileReadView {
	path?: string;
	content: string;
	truncated: boolean;
	binary: boolean;
	size?: number;
	error?: string;
}

/** Normaliza `files.read` (main) aceitando string crua ou objeto. */
export function normalizeFileRead(raw: unknown, locale: Locale = "pt-BR"): FileReadView {
	const value = unwrapRpcData(raw);
	if (typeof value === "string") {
		return { content: value, truncated: false, binary: false };
	}
	if (!isRecord(value)) {
		return { content: "", truncated: false, binary: false, error: translate(locale, "changes.readFailed") };
	}
	const content = typeof value.content === "string" ? value.content : "";
	const size = typeof value.size === "number" ? value.size : undefined;
	const binary = value.binary === true;
	return {
		path: typeof value.path === "string" ? value.path : undefined,
		content,
		truncated: value.truncated === true,
		binary,
		size,
		error: binary
			? undefined
			: content.length === 0 && size !== undefined && size > 0
				? translate(locale, "changes.noTextContent")
				: undefined,
	};
}

export function statusSummary(status: GitStatusResult, locale: Locale = "pt-BR"): string {
	if (!status.isRepo) return translate(locale, "changes.statusNoRepo");
	const total = status.files.length;
	if (total === 0) return translate(locale, "changes.statusClean");
	return total === 1
		? translate(locale, "changes.statusOne")
		: translate(locale, "changes.statusMany", { count: total });
}

/** Normaliza `git.status` sem confiar cegamente no payload do main. */
export function normalizeGitStatus(raw: unknown): GitStatusResult {
	const value = unwrapRpcData(raw);
	if (!isRecord(value)) return { isRepo: false, hasHead: false, files: [] };
	const files: GitFileStatus[] = [];
	for (const entry of Array.isArray(value.files) ? value.files : []) {
		if (!isRecord(entry) || typeof entry.path !== "string" || entry.path.length === 0) continue;
		files.push({
			path: entry.path,
			origPath: typeof entry.origPath === "string" ? entry.origPath : undefined,
			index: typeof entry.index === "string" ? entry.index : " ",
			worktree: typeof entry.worktree === "string" ? entry.worktree : " ",
			untracked: entry.untracked === true,
			binary: entry.binary === true ? true : undefined,
		});
	}
	return {
		isRepo: value.isRepo === true,
		hasHead: value.hasHead === true,
		branch: typeof value.branch === "string" ? value.branch : undefined,
		files,
	};
}

/** Normaliza `git.diff`; mantém o path/source pedidos quando o payload omite. */
export function normalizeGitDiff(
	raw: unknown,
	fallbackPath: string,
	fallbackSource: "working" | "index",
): GitDiffResult {
	const value = unwrapRpcData(raw);
	if (!isRecord(value)) {
		return {
			path: fallbackPath,
			source: fallbackSource,
			binary: false,
			original: "",
			modified: "",
			truncated: false,
		};
	}
	return {
		path: typeof value.path === "string" ? value.path : fallbackPath,
		source: value.source === "index" || value.source === "working" ? value.source : fallbackSource,
		binary: value.binary === true,
		original: typeof value.original === "string" ? value.original : "",
		modified: typeof value.modified === "string" ? value.modified : "",
		truncated: value.truncated === true,
	};
}

/** Caminho exibido sem permitir navegação; apenas texto. */
export function displayPath(item: GitFileDisplay): string {
	return item.renamedFrom ? `${item.renamedFrom} → ${item.path}` : item.path;
}
