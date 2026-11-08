/**
 * Descoberta do ambiente local: Bun empacotado/dev, OMP no PATH/configuração,
 * Git e shell. Sem import de Electron; o main injeta os caminhos do app.
 */
import { execFile } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import * as path from "node:path";
import type { RuntimeStatus } from "../shared/contracts";
import type { DependencyRuntimeSnapshot } from "../shared/dependency-install-types";
import { readJsonFile, writeJsonAtomic } from "./json-store";

/**
 * Plataforma exposta no contrato de status. O aplicativo é suportado em
 * Windows, Linux e macOS; qualquer outro valor de `process.platform` cai em
 * `win32` apenas para manter o contrato existente.
 */
export function desktopPlatform(): "win32" | "linux" | "darwin" {
	if (process.platform === "linux") return "linux";
	if (process.platform === "darwin") return "darwin";
	return "win32";
}

export const OMP_BASELINE_VERSION = "18.16.0";
/**
 * O protocolo RPC foi verificado com a série 18.x. Versões com major maior são
 * aceitas (o host também aceita) para não bloquear o aplicativo, mas ficam
 * marcadas como não validadas no status.
 */
export const OMP_SUPPORTED_MAJOR = 18;

/**
 * Mesma política de `src/host/omp-cli.ts`: major >= 18 é compatível. A versão
 * exata é conferida pelo host antes de abrir o processo OMP.
 */
export function isOmpVersionCompatible(version: string | undefined): boolean {
	if (!version) return false;
	const major = Number.parseInt(version.split(".")[0] ?? "", 10);
	return Number.isInteger(major) && major >= OMP_SUPPORTED_MAJOR;
}

/** Aviso exibido no status quando a versão é mais nova que a validada. */
export function ompVersionWarning(version: string | undefined): string | undefined {
	if (!version) return undefined;
	const major = Number.parseInt(version.split(".")[0] ?? "", 10);
	if (!Number.isInteger(major) || major <= OMP_SUPPORTED_MAJOR) return undefined;
	return `OMP ${version} ainda não foi validado com este aplicativo (validado com ${OMP_BASELINE_VERSION}). O aplicativo vai continuar, mas alguns recursos podem se comportar de forma diferente.`;
}

interface ExecOutcome {
	stdout: string;
	stderr: string;
	code: number;
}

function execFileCaptured(
	file: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecOutcome> {
	const { promise, resolve } = Promise.withResolvers<ExecOutcome>();
	const settle = (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => {
		const code =
			error && typeof error.code === "number" ? error.code : error ? -1 : 0;
		resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
	};
	try {
		execFile(
			file,
			args,
			{
				env: options.env ?? process.env,
				windowsHide: true,
				timeout: options.timeoutMs ?? 5000,
				maxBuffer: 1_048_576,
				encoding: "utf8",
				...(options.signal ? { signal: options.signal } : {}),
			},
			(error, stdout, stderr) => settle(error, stdout ?? "", stderr ?? ""),
		);
	} catch (error) {
		settle(error as Error, "", (error as Error).message);
	}
	return promise;
}

export function parseOmpVersion(output: string): string | undefined {
	const match = output.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
	return match?.[1];
}

export function parseGitVersion(output: string): string | undefined {
	const match = output.match(/git version\s+(\d+\.\d+\.\d+)/i);
	return match?.[1];
}

const SCRIPT_FILE_RE = /\.(?:[cm]?[jt]s)$/i;

async function executableExists(file: string): Promise<boolean> {
	try {
		const info = await stat(file);
		if (!info.isFile()) return false;
		// Scripts .js/.ts são executados pelo Bun (process.execPath), então não
		// precisam do bit de execução; binários e .cmd/.bat precisam.
		if (SCRIPT_FILE_RE.test(file)) return true;
		await access(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Procura no PATH do processo. No POSIX a varredura é feita diretamente (sem
 * depender de `which`), aceitando apenas arquivos com bit de execução; no
 * Windows `where.exe` continua respeitando PATHEXT.
 */
async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	if (process.platform !== "win32") {
		const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
		for (const dir of dirs) {
			const candidate = path.resolve(dir, name);
			if (await executableExists(candidate)) return candidate;
		}
		return undefined;
	}
	const result = await execFileCaptured("where.exe", [name], { env, timeoutMs: 4000 });
	if (result.code !== 0) return undefined;
	const first = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!first) return undefined;
	return (await executableExists(first)) ? first : undefined;
}

export interface OmpProbeResult {
	ompPath?: string;
	ompVersion?: string;
	compatible: boolean;
	source?: "env" | "config" | "path";
	message?: string;
}

export interface RuntimeResolverOptions {
	userDataDir: string;
	appPath: string;
	resourcesPath: string;
	isPackaged: boolean;
	env?: NodeJS.ProcessEnv;
	/** `process.execPath`; em dev pode ser o próprio bun. */
	execPath?: string;
	/**
	 * Sondagem das ferramentas opcionais (Git/Node). O main injeta o instalador
	 * gerenciado; testes sem ele continuam usando o PATH como antes.
	 */
	probeDependencies?: () => Promise<DependencyRuntimeSnapshot>;
}

const RUNTIME_CONFIG_FILE = "runtime.json";

/** Configuração persistida em userData (nunca na árvore do projeto). */
export interface RuntimeConfigFile {
	ompPath?: string;
}

export class RuntimeResolver {
	private readonly opts: RuntimeResolverOptions;
	private readonly env: NodeJS.ProcessEnv;
	private statusCache: { at: number; value: RuntimeStatus } | null = null;

	constructor(options: RuntimeResolverOptions) {
		this.opts = options;
		this.env = options.env ?? process.env;
	}

	get configFile(): string {
		return path.join(this.opts.userDataDir, RUNTIME_CONFIG_FILE);
	}

	async readConfig(): Promise<RuntimeConfigFile> {
		const value = await readJsonFile<RuntimeConfigFile>(this.configFile, {});
		return typeof value === "object" && value !== null ? value : {};
	}

	async saveOmpPath(ompPath: string): Promise<void> {
		const current = await this.readConfig();
		await writeJsonAtomic(this.configFile, { ...current, ompPath });
	}

	/** Scripts de fixture rodam via Bun; .cmd/.bat só existem no Windows. */
	private async probeCommand(ompPath: string): Promise<{ file: string; args: string[] }> {
		const extension = path.extname(ompPath).toLowerCase();
		if (extension === ".js" || extension === ".mjs" || extension === ".cjs" || extension === ".ts") {
			const bun = await this.resolveBun();
			if (bun) return { file: bun, args: [ompPath, "--version"] };
		}
		if (extension === ".cmd" || extension === ".bat") {
			// No POSIX esses arquivos não são executáveis; o binário oficial do
			// OMP é um ELF sem extensão. Recusar cedo evita um spawn confuso.
			if (process.platform !== "win32") {
				throw new Error("Arquivos .cmd/.bat do Windows não executam no Linux. Selecione o binário `omp`.");
			}
			const comspec = this.env.ComSpec ?? "cmd.exe";
			return { file: comspec, args: ["/d", "/s", "/c", `"${ompPath}" --version`] };
		}
		return { file: ompPath, args: ["--version"] };
	}

	async probeOmpPath(ompPath: string, options: { signal?: AbortSignal } = {}): Promise<OmpProbeResult> {
		if (process.platform !== "win32" && /\.(?:cmd|bat)$/i.test(ompPath)) {
			return {
				ompPath,
				compatible: false,
				message: "Arquivos .cmd/.bat do Windows não executam no Linux. Selecione o binário `omp`.",
			};
		}
		if (!(await executableExists(ompPath))) {
			return { compatible: false, message: "O executável do OMP não foi encontrado nesse caminho." };
		}
		let command: { file: string; args: string[] };
		try {
			command = await this.probeCommand(ompPath);
		} catch (error) {
			return { ompPath, compatible: false, message: (error as Error).message };
		}
		const result = await execFileCaptured(command.file, command.args, {
			env: this.env,
			timeoutMs: 10_000,
			...(options.signal ? { signal: options.signal } : {}),
		});
		if (result.code !== 0) {
			const detail = result.stderr.trim() || `código ${result.code}`;
			return {
				ompPath,
				compatible: false,
				message: `Não foi possível executar o OMP selecionado: ${detail}`,
			};
		}
		const version = parseOmpVersion(result.stdout) ?? parseOmpVersion(result.stderr);
		if (!version) {
			return {
				ompPath,
				compatible: false,
				message: "O executável selecionado não informou uma versão reconhecida do OMP.",
			};
		}
		if (!isOmpVersionCompatible(version)) {
			return {
				ompPath,
				ompVersion: version,
				compatible: false,
				message: `OMP ${version} não é compatível com esta versão do aplicativo (protocolo validado com ${OMP_BASELINE_VERSION}).`,
			};
		}
		const warning = ompVersionWarning(version);
		return {
			ompPath,
			ompVersion: version,
			compatible: true,
			...(warning ? { message: warning } : {}),
		};
	}

	/**
	 * Precedência: configuração salva (seleção manual em Diagnóstico) >
	 * `OMP_DESKTOP_OMP_PATH` > PATH. A escolha manual é persistida em userData
	 * justamente para não ser sobrescrita pela variável de ambiente; a env é
	 * apenas fallback quando ainda não há escolha salva.
	 */
	async resolveOmp(): Promise<OmpProbeResult> {
		const config = await this.readConfig();
		if (config.ompPath) {
			const probe = await this.probeOmpPath(config.ompPath);
			if (probe.compatible) return { ...probe, source: "config" };
			const envProbe = await this.probeEnvOmp();
			if (envProbe?.compatible) return envProbe;
			const fromPath = await this.findOmpOnPath();
			if (fromPath) return fromPath;
			return { ...probe, source: "config" };
		}
		const envProbe = await this.probeEnvOmp();
		if (envProbe) return envProbe;
		const fromPath = await this.findOmpOnPath();
		return fromPath ?? {
			compatible: false,
			message: "OMP não encontrado. Instale o OMP ou selecione o executável em Diagnóstico.",
		};
	}

	private async probeEnvOmp(): Promise<OmpProbeResult | undefined> {
		const envPath = this.env.OMP_DESKTOP_OMP_PATH;
		if (!envPath || envPath.trim().length === 0) return undefined;
		const probe = await this.probeOmpPath(envPath.trim());
		return { ...probe, source: "env" };
	}

	private async findOmpOnPath(): Promise<OmpProbeResult | undefined> {
		const names = process.platform === "win32" ? ["omp.exe", "omp"] : ["omp"];
		for (const name of names) {
			const found = await findOnPath(name, this.env);
			if (!found) continue;
			const probe = await this.probeOmpPath(found);
			return { ...probe, source: "path" };
		}
		return undefined;
	}

	/** Em produção usa somente o Bun incluído no instalador. */
	async resolveBun(): Promise<string | undefined> {
		if (this.opts.isPackaged) {
			const bundled = path.join(
				this.opts.resourcesPath,
				"bun",
				process.platform === "win32" ? "bun.exe" : "bun",
			);
			return (await executableExists(bundled)) ? bundled : undefined;
		}
		const configured = this.env.OMP_DESKTOP_BUN_PATH;
		if (configured && (await executableExists(configured))) return configured;
		const execName = path.basename(this.opts.execPath ?? "");
		if (/^bun(\.exe)?$/i.test(execName)) return this.opts.execPath;
		return await findOnPath(process.platform === "win32" ? "bun.exe" : "bun", this.env);
	}

	getHostScript(): string {
		// Empacotado ou não, o host fica dentro do app para resolver node_modules (OMP, zod) ao lado.
		return path.join(this.opts.appPath, "out", "host", "index.js");
	}

	/**
	 * Shell do terminal do usuário. No POSIX usa `$SHELL` somente quando é um
	 * caminho absoluto executável; caso contrário cai em um shell POSIX real
	 * presente no sistema. No Windows mantém PowerShell/ComSpec.
	 */
	async resolveShell(): Promise<string> {
		if (process.platform !== "win32") {
			const configured = this.env.SHELL?.trim();
			const unusable = /^(?:false|nologin|sync|shutdown|halt)$/i;
			if (
				configured &&
				path.isAbsolute(configured) &&
				!unusable.test(path.basename(configured)) &&
				(await executableExists(configured))
			) {
				return configured;
			}
			for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/bin/sh"]) {
				if (await executableExists(candidate)) return candidate;
			}
			return "/bin/sh";
		}
		const powershell = await findOnPath("powershell.exe", this.env);
		if (powershell) return powershell;
		const pwsh = await findOnPath("pwsh.exe", this.env);
		if (pwsh) return pwsh;
		return this.env.ComSpec || "cmd.exe";
	}

	async resolveGitVersion(): Promise<string | undefined> {
		const git = await findOnPath(process.platform === "win32" ? "git.exe" : "git", this.env);
		if (!git) return undefined;
		const result = await execFileCaptured(git, ["--version"], { env: this.env, timeoutMs: 5000 });
		if (result.code !== 0) return undefined;
		return parseGitVersion(result.stdout);
	}

	/**
	 * Status de descoberta. A fase `ready` só é atribuída pelo main depois que
	 * o host confirma a inicialização; aqui o melhor estado é `starting-host`.
	 */
	async buildStatus(force = false): Promise<RuntimeStatus> {
		const now = Date.now();
		if (!force && this.statusCache && now - this.statusCache.at < 5000) {
			return this.statusCache.value;
		}
		const [bunPath, omp, dependencies, shell] = await Promise.all([
			this.resolveBun(),
			this.resolveOmp(),
			this.opts.probeDependencies?.() ?? Promise.resolve(undefined),
			this.resolveShell(),
		]);
		// O campo legado `gitVersion` vem do MESMO snapshot das ferramentas
		// opcionais; sem sondagem injetada (testes isolados) cai no PATH.
		const gitVersion = dependencies
			? dependencies.git.state === "installed"
				? dependencies.git.version
				: undefined
			: await this.resolveGitVersion();
		const dependencyFields = dependencies ? { dependencies } : {};
		let status: RuntimeStatus;
		if (!bunPath) {
			status = {
				phase: "host-failed",
				signed: false,
				platform: desktopPlatform(),
				message: this.opts.isPackaged
					? "O executável do Bun incluído no aplicativo não foi encontrado. Reinstale o OMP Desktop."
					: "Bun não encontrado no PATH. Instale o Bun para executar o serviço local.",
				ompPath: omp.ompPath,
				ompVersion: omp.ompVersion,
				gitVersion,
				shell,
				...dependencyFields,
			};
		} else if (!omp.ompPath) {
			status = {
				phase: "omp-missing",
				signed: false,
				platform: desktopPlatform(),
				message: omp.message ?? "OMP não encontrado. Instale o OMP ou selecione o executável em Diagnóstico.",
				bunPath,
				gitVersion,
				shell,
				...dependencyFields,
			};
		} else if (!omp.compatible) {
			status = {
				phase: "omp-incompatible",
				signed: false,
				platform: desktopPlatform(),
				message: omp.message ?? "A versão do OMP instalada não é compatível.",
				ompPath: omp.ompPath,
				ompVersion: omp.ompVersion,
				bunPath,
				gitVersion,
				shell,
				...dependencyFields,
			};
		} else {
			status = {
				phase: "starting-host",
				signed: false,
				platform: desktopPlatform(),
				message: omp.message,
				ompPath: omp.ompPath,
				ompVersion: omp.ompVersion,
				bunPath,
				gitVersion,
				shell,
				...dependencyFields,
			};
		}
		this.statusCache = { at: now, value: status };
		return status;
	}

	invalidate(): void {
		this.statusCache = null;
	}
}
