/**
 * Descoberta e execução do executável OMP e utilidades de processo.
 *
 * - `OMP_DESKTOP_OMP_PATH` tem precedência, depois `--omp-path` (argv do host) e PATH.
 * - Spawn sempre por argv; `.cmd`/`.bat` usam `cmd.exe /d /s /c` (exigido pelo
 *   Windows e por fixtures), `.js/.ts` usam o próprio Bun, `.exe` é direto.
 * - Nenhum processo é encerrado por nome: só a árvore do PID iniciado.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface LaunchSpec {
	command: string;
	args: string[];
	/** Quando o comando é uma linha pronta para cmd.exe (já cotada). */
	windowsVerbatimArguments?: boolean;
}

const SCRIPT_RE = /\.(?:[cm]?[jt]s)$/i;
const CMD_RE = /\.(?:cmd|bat)$/i;

/**
 * Cotação no estilo do runtime C da Microsoft (CommandLineToArgvW). É o que o
 * executável final, iniciado pelo `cmd.exe`, espera decodificar.
 */
function crtQuote(value: string): string {
	if (value.length > 0 && !/[\s"]/.test(value)) return value;
	let out = '"';
	let backslashes = 0;
	for (const char of value) {
		if (char === "\\") {
			backslashes += 1;
			continue;
		}
		if (char === '"') {
			out += `${"\\".repeat(backslashes * 2 + 1)}"`;
			backslashes = 0;
			continue;
		}
		out += `${"\\".repeat(backslashes)}${char}`;
		backslashes = 0;
	}
	return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * `cmd.exe` expande `%VAR%` mesmo dentro de aspas, e a expansão pode conter
 * espaços (quebrando a linha). Sem alvo real resolvido, recusamos esses
 * argumentos em vez de enviar um valor corrompido.
 */
function assertCmdSafe(value: string, ompPath: string): void {
	if (/[\r\n\0]/.test(value) || /%[A-Za-z_][A-Za-z0-9_]*%/.test(value)) {
		throw new Error(
			`O executável ${ompPath} é um script .cmd sem alvo resolvido e o argumento contém "%" (o cmd.exe o expandiria). Selecione o omp.exe real na tela de diagnóstico.`,
		);
	}
}

interface ShimTarget {
	path: string;
	kind: "exe" | "script";
}

/**
 * `.cmd`/`.bat` podem ser apenas shims. Preferimos o alvo real (`.exe` irmão ou
 * o script apontado por `%~dp0`/`%dp0%`) para nunca passar JSON por cmd.exe.
 * Só cai em `cmd.exe` quando o alvo não é resolvível.
 */
function resolveCmdShim(ompPath: string): ShimTarget | undefined {
	const exeSibling = ompPath.replace(CMD_RE, ".exe");
	try {
		if (fs.statSync(exeSibling).isFile()) return { path: exeSibling, kind: "exe" };
	} catch {
		/* sem irmão .exe */
	}
	let content: string;
	try {
		content = fs.readFileSync(ompPath, "utf8");
	} catch {
		return undefined;
	}
	const match = /"?%(?:~?dp0|~?DP0)%?[/\\]([^"\r\n]+?\.(?:[cm]?[jt]s|exe))"?/i.exec(content);
	if (!match?.[1]) return undefined;
	const target = path.resolve(path.dirname(ompPath), match[1]);
	try {
		if (!fs.statSync(target).isFile()) return undefined;
	} catch {
		return undefined;
	}
	return { path: target, kind: /\.exe$/i.test(target) ? "exe" : "script" };
}

/** Monta o comando de lançamento para um executável/script OMP. */
export function ompLaunchSpec(ompPath: string, args: readonly string[]): LaunchSpec {
	if (CMD_RE.test(ompPath)) {
		const target = resolveCmdShim(ompPath);
		if (target?.kind === "exe") return { command: target.path, args: [...args] };
		if (target) return { command: process.execPath, args: [target.path, ...args] };
		for (const value of [ompPath, ...args]) assertCmdSafe(value, ompPath);
		const comspec = process.env.ComSpec ?? "cmd.exe";
		// A linha inteira vai entre aspas e é passada verbatim: `/s` remove só o
		// par externo. Testado com JSON (`{"a":1}`), `&`, `(` e aspas embutidas.
		const line = `"${[ompPath, ...args].map(crtQuote).join(" ")}"`;
		return {
			command: comspec,
			args: ["/d", "/v:off", "/s", "/c", line],
			windowsVerbatimArguments: true,
		};
	}
	if (SCRIPT_RE.test(ompPath)) {
		return { command: process.execPath, args: [ompPath, ...args] };
	}
	return { command: ompPath, args: [...args] };
}

export function resolveOmpPath(explicit?: string): string | undefined {
	const configured = explicit ?? process.env.OMP_DESKTOP_OMP_PATH;
	if (configured && configured.trim().length > 0) {
		const resolved = path.resolve(configured.trim());
		try {
			if (fs.statSync(resolved).isFile()) return resolved;
		} catch {
			/* cai para o PATH */
		}
	}
	return Bun.which("omp") ?? undefined;
}

export interface OmpVersionInfo {
	raw: string;
	major: number;
	minor: number;
	patch: number;
	compatible: boolean;
}

export async function readOmpVersion(ompPath: string): Promise<OmpVersionInfo | undefined> {
	const result = await runOmp(ompPath, ["--version"], { timeoutMs: 30_000 });
	if (result.exitCode !== 0) return undefined;
	const text = `${result.stdout}\n${result.stderr}`;
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	if (!match) return undefined;
	const raw = match[0];
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	const compatible = major > 18 || (major === 18 && (minor > 16 || (minor === 16 && patch >= 0)));
	return { raw, major, minor, patch, compatible };
}

export interface RunOmpOptions {
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
	maxStdoutBytes?: number;
	maxStderrBytes?: number;
}

export interface RunOmpResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** Executa o OMP/CLI uma vez, por argv, sem shell, com timeout e saída limitada. */
export async function runOmp(
	ompPath: string,
	args: readonly string[],
	options: RunOmpOptions = {},
): Promise<RunOmpResult> {
	const spec = ompLaunchSpec(ompPath, args);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
		if (typeof value === "string") env[key] = value;
	}
	const timeoutMs = options.timeoutMs ?? 60_000;
	const maxStdout = options.maxStdoutBytes ?? 32 * 1024 * 1024;
	const maxStderr = options.maxStderrBytes ?? 64 * 1024;
	const child = Bun.spawn([spec.command, ...spec.args], {
		cwd: options.cwd,
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void killProcessTree(child.pid);
	}, timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			readCapped(child.stdout, maxStdout),
			readCapped(child.stderr, maxStderr),
			child.exited,
		]);
		return { exitCode, stdout, stderr, timedOut };
	} finally {
		clearTimeout(timer);
	}
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let text = "";
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > limit) {
				const remaining = Math.max(0, limit - (total - value.byteLength));
				text += decoder.decode(value.subarray(0, remaining), { stream: true });
				text += "\n[saída truncada]";
				await reader.cancel().catch(() => undefined);
				break;
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	return text;
}

/** Encerra a árvore do PID iniciado pelo app; nunca busca processos por nome. */
export async function killProcessTree(pid: number | undefined): Promise<void> {
	if (!pid || pid <= 0) return;
	if (process.platform === "win32") {
		try {
			const child = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				windowsHide: true,
			});
			await child.exited;
		} catch {
			/* processo já saiu */
		}
		return;
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		/* processo já saiu */
	}
}

/** Espera o processo sair por até `ms`; devolve `false` no timeout. */
export async function waitForExit(exited: Promise<number>, ms: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => resolve(false), ms);
	const result = await Promise.race([exited.then(() => true), promise]);
	clearTimeout(timer);
	return result;
}

export function parseJsonOutput<T>(text: string): T | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		return undefined;
	}
}
