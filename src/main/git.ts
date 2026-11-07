/**
 * Operações Git somente leitura (status/diff) e de índice (stage/unstage/commit).
 * Sem shell, sem push/reset/clean. Leitura nunca executa hooks nem ext-diff.
 */
import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import type { GitDiffResult, GitFileStatus, GitStatusResult } from "../shared/contracts";
import { assertWorkspaceDirectory, resolveWorkspacePathAllowMissing, validateRelativePath } from "./paths";

export class GitError extends Error {
	constructor(
		message: string,
		readonly stderr = "",
		readonly code?: number,
	) {
		super(message);
		this.name = "GitError";
	}
}

export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

interface GitRunResult {
	stdout: Buffer;
	stderr: Buffer;
}

interface GitRunOptions {
	optionalLocks?: boolean;
	maxBuffer?: number;
	timeoutMs?: number;
}

function buildGitEnv(optionalLocks: boolean): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_TERMINAL_PROMPT: "0" };
	if (optionalLocks) env.GIT_OPTIONAL_LOCKS = "0";
	return env;
}

function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitRunResult> {
	const fullArgs = ["-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "core.fsmonitor=false", ...args];
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			fullArgs,
			{
				cwd,
				env: buildGitEnv(options.optionalLocks ?? false),
				encoding: null,
				maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
				timeout: options.timeoutMs ?? 30_000,
				windowsHide: true,
				shell: false,
			},
			(error, stdout, stderr) => {
				const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
				const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
				if (error) {
					const code = typeof (error as NodeJS.ErrnoException).code === "number" ? Number((error as NodeJS.ErrnoException).code) : -1;
					const detail = err.toString("utf8").trim();
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						reject(
							new GitError(
								"O Git não está instalado ou não está no PATH. O painel Alterações fica indisponível até o Git ser instalado.",
								"",
								code,
							),
						);
						return;
					}
					reject(
						new GitError(
							detail.length > 0 ? detail : `O Git falhou (${error.message}).`,
							err.toString("utf8"),
							code,
						),
					);
					return;
				}
				resolve({ stdout: out, stderr: err });
			},
		);
	});
}

async function gitText(cwd: string, args: string[], options?: GitRunOptions): Promise<string> {
	const result = await runGit(cwd, args, options);
	return result.stdout.toString("utf8");
}

async function tryGitText(cwd: string, args: string[], options?: GitRunOptions): Promise<string | undefined> {
	try {
		return (await gitText(cwd, args, options)).trim();
	} catch {
		return undefined;
	}
}

function splitNul(buffer: Buffer): Buffer[] {
	const parts: Buffer[] = [];
	let start = 0;
	for (let index = 0; index < buffer.length; index += 1) {
		if (buffer[index] !== 0) continue;
		parts.push(buffer.subarray(start, index));
		start = index + 1;
	}
	if (start < buffer.length) parts.push(buffer.subarray(start));
	return parts;
}

/** Converte a saída de `git status --porcelain=v1 -z`. */
export function parsePorcelainZ(input: Buffer | string): GitFileStatus[] {
	const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
	const tokens = splitNul(buffer);
	const files: GitFileStatus[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token.length < 4) continue;
		const indexStatus = String.fromCharCode(token[0]);
		const worktreeStatus = String.fromCharCode(token[1]);
		const filePath = token.subarray(3).toString("utf8");
		let origPath: string | undefined;
		if (/[RC]/.test(indexStatus) || /[RC]/.test(worktreeStatus)) {
			const previous = tokens[index + 1];
			if (previous) {
				origPath = previous.toString("utf8");
				index += 1;
			}
		}
		files.push({
			path: filePath,
			origPath,
			index: indexStatus,
			worktree: worktreeStatus,
			untracked: indexStatus === "?" && worktreeStatus === "?",
		});
	}
	return files;
}

export async function isGitRepository(rootAbs: string): Promise<boolean> {
	const root = await assertWorkspaceDirectory(rootAbs);
	const value = await tryGitText(root, ["rev-parse", "--is-inside-work-tree"], { optionalLocks: true });
	return value === "true";
}

async function hasHead(root: string): Promise<boolean> {
	const value = await tryGitText(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { optionalLocks: true });
	return Boolean(value);
}

async function branchName(root: string): Promise<string | undefined> {
	const symbolic = await tryGitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { optionalLocks: true });
	if (symbolic) return symbolic;
	return await tryGitText(root, ["rev-parse", "--short", "HEAD"], { optionalLocks: true });
}

export async function gitStatus(rootAbs: string): Promise<GitStatusResult> {
	const root = await assertWorkspaceDirectory(rootAbs);
	if (!(await isGitRepository(root))) {
		return { isRepo: false, hasHead: false, files: [] };
	}
	const [head, branch, status] = await Promise.all([
		hasHead(root),
		branchName(root),
		runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
			optionalLocks: true,
			maxBuffer: 32 * 1024 * 1024,
		}),
	]);
	return {
		isRepo: true,
		hasHead: head,
		branch,
		files: parsePorcelainZ(status.stdout),
	};
}

/** Prefixo do cwd dentro do repositório (para os specs `:path` e `HEAD:path`). */
async function repoPrefix(root: string): Promise<string> {
	const prefix = (await tryGitText(root, ["rev-parse", "--show-prefix"], { optionalLocks: true })) ?? "";
	return prefix.length > 0 && !prefix.endsWith("/") ? `${prefix}/` : prefix;
}

async function showObject(root: string, spec: string): Promise<Buffer | undefined> {
	try {
		const result = await runGit(root, ["show", spec], {
			optionalLocks: true,
			maxBuffer: MAX_DIFF_BYTES + 64 * 1024,
		});
		return result.stdout;
	} catch {
		return undefined;
	}
}

async function readWorkingFile(root: string, relativePath: string): Promise<Buffer | undefined> {
	let resolved;
	try {
		resolved = await resolveWorkspacePathAllowMissing(root, relativePath);
	} catch {
		return undefined;
	}
	try {
		const info = await stat(resolved.realPath);
		if (!info.isFile()) return undefined;
		const limit = MAX_DIFF_BYTES + 1;
		const handle = await open(resolved.realPath, "r");
		try {
			const buffer = Buffer.alloc(Math.min(limit, Math.max(1, info.size + 1)));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return buffer.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

export function isBinaryBuffer(buffer: Buffer | undefined): boolean {
	if (!buffer || buffer.length === 0) return false;
	const limit = Math.min(buffer.length, 8192);
	for (let index = 0; index < limit; index += 1) {
		if (buffer[index] === 0) return true;
	}
	return false;
}

function decodeBuffer(buffer: Buffer | undefined): { text: string; truncated: boolean } {
	if (!buffer) return { text: "", truncated: false };
	const truncated = buffer.length > MAX_DIFF_BYTES;
	const usable = truncated ? buffer.subarray(0, MAX_DIFF_BYTES) : buffer;
	return { text: usable.toString("utf8"), truncated };
}

export async function gitDiff(
	rootAbs: string,
	relativePath: string,
	source: "working" | "index",
): Promise<GitDiffResult> {
	const normalized = validateRelativePath(relativePath);
	const root = await assertWorkspaceDirectory(rootAbs);
	if (!(await isGitRepository(root))) {
		throw new GitError("A pasta do projeto não é um repositório Git.");
	}
	const prefix = await repoPrefix(root);
	const spec = `${prefix}${normalized}`;
	let original: Buffer | undefined;
	let modified: Buffer | undefined;
	if (source === "working") {
		original = await showObject(root, `:${spec}`);
		modified = await readWorkingFile(root, normalized);
	} else {
		original = await showObject(root, `HEAD:${spec}`);
		modified = await showObject(root, `:${spec}`);
		if (!original) {
			// Renomeado: o blob antigo ainda está em HEAD sob o caminho de origem.
			// O status sem pathspec mantém a detecção de rename (R antigo → novo).
			const status = await runGit(root, ["status", "--porcelain=v1", "-z"], {
				optionalLocks: true,
				maxBuffer: 32 * 1024 * 1024,
			});
			const entry = parsePorcelainZ(status.stdout).find((file) => file.path === normalized);
			if (entry?.origPath) {
				original = await showObject(root, `HEAD:${prefix}${entry.origPath}`);
			}
		}
	}
	const binary = isBinaryBuffer(original) || isBinaryBuffer(modified);
	const originalDecoded = decodeBuffer(original);
	const modifiedDecoded = decodeBuffer(modified);
	return {
		path: normalized,
		source,
		binary,
		original: binary ? "" : originalDecoded.text,
		modified: binary ? "" : modifiedDecoded.text,
		truncated: originalDecoded.truncated || modifiedDecoded.truncated,
	};
}

function normalizePathList(paths: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of paths) {
		const normalized = validateRelativePath(item);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	if (result.length === 0) throw new GitError("Selecione ao menos um arquivo.");
	return result;
}

async function indexFilesAt(root: string, paths: string[]): Promise<string[]> {
	const result = await runGit(root, ["ls-files", "-z", "--", ...paths], { optionalLocks: true });
	return splitNul(result.stdout)
		.map((entry) => entry.toString("utf8"))
		.filter((entry) => entry.length > 0);
}

export async function gitStage(rootAbs: string, paths: string[]): Promise<{ paths: string[] }> {
	const normalized = normalizePathList(paths);
	const root = await assertWorkspaceDirectory(rootAbs);
	if (!(await isGitRepository(root))) {
		throw new GitError("A pasta do projeto não é um repositório Git.");
	}
	try {
		await runGit(root, ["add", "--", ...normalized], { timeoutMs: 120_000 });
	} catch (error) {
		throw new GitError(
			`O Git não conseguiu preparar os arquivos: ${(error as GitError).message}`,
			(error as GitError).stderr,
			(error as GitError).code,
		);
	}
	return { paths: normalized };
}

export async function gitUnstage(rootAbs: string, paths: string[]): Promise<{ paths: string[] }> {
	const normalized = normalizePathList(paths);
	const root = await assertWorkspaceDirectory(rootAbs);
	if (!(await isGitRepository(root))) {
		throw new GitError("A pasta do projeto não é um repositório Git.");
	}
	const tracked = await indexFilesAt(root, normalized);
	if (tracked.length === 0) return { paths: [] };
	if (await hasHead(root)) {
		await runGit(root, ["restore", "--staged", "--", ...tracked], { timeoutMs: 120_000 });
	} else {
		// Repositório sem HEAD: remove apenas do índice, mantendo a árvore intacta.
		await runGit(root, ["rm", "--cached", "--quiet", "--", ...tracked], { timeoutMs: 120_000 });
	}
	return { paths: tracked };
}

export interface GitCommitResult {
	commit?: string;
	output: string;
}

export async function gitCommit(rootAbs: string, message: string): Promise<GitCommitResult> {
	const trimmed = message.trim();
	if (trimmed.length === 0) {
		throw new GitError("Digite uma mensagem de commit antes de confirmar.");
	}
	const root = await assertWorkspaceDirectory(rootAbs);
	if (!(await isGitRepository(root))) {
		throw new GitError("A pasta do projeto não é um repositório Git.");
	}
	try {
		const result = await runGit(root, ["commit", "-m", message], { timeoutMs: 120_000 });
		const commit = await tryGitText(root, ["rev-parse", "--short", "HEAD"], { optionalLocks: true });
		return { commit, output: result.stdout.toString("utf8").trim() };
	} catch (error) {
		const gitError = error as GitError;
		throw new GitError(
			`O Git recusou o commit. Os arquivos não foram alterados. ${gitError.message}`,
			gitError.stderr,
			gitError.code,
		);
	}
}
