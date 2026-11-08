/**
 * Instalação do OMP pelo método oficial de binário (Windows e Linux x86_64).
 *
 * O instalador oficial (`https://omp.sh/install.ps1 -Binary` no Windows e
 * `https://omp.sh/install.sh --binary` no Linux) resolve o build em
 * `https://build.stencil.so`, baixa o binário pré-compilado, confere o SHA-256
 * informado pelo serviço e grava em `%LOCALAPPDATA%\omp` (Windows) ou em
 * `$HOME/.local/bin/omp` (Linux), respeitando `PI_INSTALL_DIR`. Este módulo
 * repete somente essa parte, sem `iex`, sem shell e sem depender de um Bun
 * global: o aplicativo já inclui o Bun para o host, mas o binário standalone é
 * o que garante um OMP funcional numa máquina limpa.
 *
 * Regras de segurança:
 * - URL base fixa do serviço oficial; nenhuma URL/comando vem do renderer.
 * - A resposta do serviço é validada (versão, nome do arquivo, SHA-256).
 * - A URL de download precisa ser HTTPS, sem credenciais e de um host oficial
 *   (`build.stencil.so`, `*.stencil.so` ou o bucket R2 usado pelo serviço).
 * - O arquivo só é promovido depois do checksum; nunca sobrescreve uma
 *   instalação existente. A versão é confirmada com `--version` antes de o
 *   caminho ser persistido pelo chamador.
 * - No Linux o binário recebe `chmod 0755` apenas no caminho de destino; no
 *   Windows nenhuma permissão POSIX é aplicada.
 * - Nada em `~/.omp` é criado ou alterado (o instalador oficial configura o
 *   `shellPath` ali; este aplicativo não faz isso).
 */
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, copyFile, link, mkdir, open, rm, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { OMP_BASELINE_VERSION } from "./runtime";

/** Serviço de builds usado pelo instalador oficial do Windows. */
export const OMP_BUILD_BASE_URL = "https://build.stencil.so";
/** Versão fixada: a mesma baseline validada pelo host e pelo aplicativo. */
export const OMP_INSTALL_VERSION = OMP_BASELINE_VERSION;
export const OMP_INSTALL_DIR_NAME = "omp";

export type OmpInstallErrorCode =
	| "UNSUPPORTED_PLATFORM"
	| "EXISTING_INCOMPATIBLE"
	| "NETWORK"
	| "CHECKSUM"
	| "VERSION_MISMATCH"
	| "WRITE"
	| "ABORTED"
	| "INTERNAL";

export class OmpInstallError extends Error {
	constructor(
		readonly code: OmpInstallErrorCode,
		message: string,
	) {
		super(message);
		this.name = "OmpInstallError";
	}
}

export type OmpInstallPhase = "resolving" | "downloading" | "verifying" | "activating";

export interface OmpInstallProgress {
	phase: OmpInstallPhase;
	receivedBytes?: number;
	totalBytes?: number;
}

export interface OmpInstallProbeResult {
	compatible: boolean;
	ompVersion?: string;
	message?: string;
}

export type OmpInstallProbe = (
	ompPath: string,
	options: { signal: AbortSignal },
) => Promise<OmpInstallProbeResult>;

/** Contrato mínimo de rede; testes injetam uma implementação determinística. */
export type OmpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OmpInstallResult {
	ompPath: string;
	ompVersion: string;
	installDir: string;
	/** `false` quando um `omp.exe` compatível já existia e foi adotado. */
	downloaded: boolean;
}

export interface OmpInstallerOptions {
	installDir: string;
	/** Versão exata a instalar; padrão: baseline do aplicativo. */
	version?: string;
	/** Alvo do serviço oficial; padrão: derivado de `process.arch`. */
	target?: string;
	/** Plataforma do binário; padrão: `process.platform`. */
	platform?: NodeJS.Platform;
	baseUrl?: string;
	fetchImpl?: OmpFetch;
	probe: OmpInstallProbe;
	onProgress?(progress: OmpInstallProgress): void;
	signal?: AbortSignal;
	log?(level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): void;
}

const buildAnswerSchema = z.object({
	build: z.object({ version: z.string().min(1) }),
	file: z.object({
		// Windows usa `omp-windows-x64.exe`; Linux usa `omp-linux-x64`, sem
		// extensão. A plataforma é conferida depois do parse.
		name: z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/),
		sha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
		size: z.number().int().positive().optional(),
	}),
	download: z.string().url(),
});

type BuildAnswer = z.infer<typeof buildAnswerSchema>;

const API_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 900_000;

/**
 * Pasta oficial: `PI_INSTALL_DIR` (mesma variável dos instaladores) ou
 * `%LOCALAPPDATA%\omp` no Windows e `$HOME/.local/bin` no Linux. No Linux o
 * binário final é `<pasta>/omp`, exatamente como o `install.sh` oficial.
 */
export function resolveOmpInstallDir(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	const override = env.PI_INSTALL_DIR?.trim();
	if (override) return path.resolve(override);
	if (platform === "linux") {
		const home = env.HOME?.trim();
		if (home) return path.join(path.resolve(home), ".local", "bin");
		throw new OmpInstallError(
			"UNSUPPORTED_PLATFORM",
			"HOME missing; set PI_INSTALL_DIR.",
		);
	}
	if (platform !== "win32") {
		throw new OmpInstallError("UNSUPPORTED_PLATFORM", `unsupported-platform=${platform}`);
	}
	const localAppData = env.LOCALAPPDATA?.trim();
	if (localAppData) return path.join(localAppData, OMP_INSTALL_DIR_NAME);
	const profile = env.USERPROFILE?.trim();
	if (profile) return path.join(profile, "AppData", "Local", OMP_INSTALL_DIR_NAME);
	throw new OmpInstallError(
		"UNSUPPORTED_PLATFORM",
		"LOCALAPPDATA/USERPROFILE missing; set PI_INSTALL_DIR.",
	);
}

/** Nome do binário por plataforma; nunca `.exe` no Linux. */
export function ompBinaryName(platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return "omp.exe";
	if (platform === "linux") return "omp";
	throw new OmpInstallError("UNSUPPORTED_PLATFORM", `unsupported-platform=${platform}`);
}

/** Mesmo mapeamento de arquitetura dos instaladores oficiais. */
export function ompInstallTarget(
	arch: string = process.arch,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === "win32") {
		if (arch === "x64") return "windows-x86_64";
		if (arch === "arm64") return "windows-arm64";
		throw new OmpInstallError("UNSUPPORTED_PLATFORM", `unsupported-arch=${arch}`);
	}
	if (platform === "linux") {
		// Escopo desta entrega: Linux x86_64. ARM fica de fora por decisão do
		// projeto, mesmo que o serviço oficial publique linux-arm64.
		if (arch === "x64") return "linux-x86_64";
		throw new OmpInstallError("UNSUPPORTED_PLATFORM", `unsupported-arch=${arch}`);
	}
	throw new OmpInstallError("UNSUPPORTED_PLATFORM", `unsupported-platform=${platform}`);
}

function errorCodeOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function messageOf(error: unknown): string {
	return error instanceof Error && error.message.trim().length > 0
		? error.message.trim()
		: String(error);
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

interface Deadline {
	signal: AbortSignal;
	didTimeout(): boolean;
	dispose(): void;
}

/** Combina o abort do chamador com um limite de tempo explícito. */
function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): Deadline {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	timer.unref?.();
	const forwardAbort = () => controller.abort();
	if (parent) {
		if (parent.aborted) controller.abort();
		else parent.addEventListener("abort", forwardAbort, { once: true });
	}
	return {
		signal: controller.signal,
		didTimeout: () => timedOut,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", forwardAbort);
		},
	};
}

function abortReason(deadline: Deadline): OmpInstallError {
	if (deadline.didTimeout()) {
		return new OmpInstallError("NETWORK", "timeout");
	}
	return new OmpInstallError("ABORTED", "aborted");
}

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new OmpInstallError("ABORTED", "aborted");
}

function parseContentLength(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Aceita apenas o serviço oficial e o bucket R2 assinado que ele devolve.
 * A URL assinada muda a cada consulta; por isso o host é validado por sufixo,
 * e o caminho precisa terminar no nome de arquivo informado pelo serviço.
 */
export function assertTrustedDownloadUrl(raw: string, fileName: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new OmpInstallError("NETWORK", "invalid-download-url");
	}
	if (url.protocol !== "https:") {
		throw new OmpInstallError("NETWORK", "download-url-not-https");
	}
	if (url.username || url.password) {
		throw new OmpInstallError("NETWORK", "download-url-has-credentials");
	}
	const host = url.hostname.toLowerCase();
	const trustedHost =
		host === "build.stencil.so" ||
		host.endsWith(".stencil.so") ||
		host.endsWith(".r2.cloudflarestorage.com");
	if (!trustedHost) {
		throw new OmpInstallError("NETWORK", `untrusted-download-host=${host}`);
	}
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(url.pathname);
	} catch {
		throw new OmpInstallError("NETWORK", "download-url-decode-failed");
	}
	if (!decodedPath.endsWith(`/${fileName}`)) {
		throw new OmpInstallError(
			"NETWORK",
			"A URL de download do OMP não corresponde ao arquivo informado pelo serviço oficial.",
		);
	}
	return url;
}

/**
 * O serviço devolve o nome do binário da plataforma. No Windows ele precisa
 * terminar em `.exe`; no Linux não pode ter extensão `.exe` (o binário oficial
 * é `omp-linux-x64`). Isso impede que um alvo errado seja gravado como `omp`.
 */
function assertPlatformFileName(name: string, platform: NodeJS.Platform): void {
	const lower = name.toLowerCase();
	if (platform === "win32") {
		if (!lower.endsWith(".exe")) {
			throw new OmpInstallError("NETWORK", `unexpected-file-name=${name}`);
		}
		return;
	}
	if (lower.endsWith(".exe")) {
		throw new OmpInstallError("NETWORK", `unexpected-file-name=${name}`);
	}
}

/**
 * Instalação de uma execução. O chamador deve usar `OmpInstallService` para
 * garantir single-flight entre cliques/pedidos concorrentes.
 */
export class OmpInstaller {
	private readonly options: OmpInstallerOptions;
	private readonly fetchImpl: OmpFetch;

	constructor(options: OmpInstallerOptions) {
		this.options = options;
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
	}

	async install(): Promise<OmpInstallResult> {
		// Um alvo explícito também identifica a plataforma; isso mantém testes
		// e chamadas antigas previsíveis em qualquer host.
		const platform =
			this.options.platform ??
			(this.options.target?.startsWith("linux-")
				? "linux"
				: this.options.target?.startsWith("windows-")
					? "win32"
					: process.platform);
		const version = this.options.version ?? OMP_INSTALL_VERSION;
		const target = this.options.target ?? ompInstallTarget(process.arch, platform);
		const installDir = path.resolve(this.options.installDir);
		const finalPath = path.join(installDir, ompBinaryName(platform));
		const signal = this.options.signal ?? new AbortController().signal;

		if (signal.aborted) throw new OmpInstallError("ABORTED", "aborted");

		try {
			await mkdir(installDir, { recursive: true });
		} catch (error) {
			throw new OmpInstallError(
				"WRITE",
				`mkdir-failed path=${installDir} code=${errorCodeOf(error) ?? "unknown"}`,
			);
		}

		// Nunca substitui uma instalação existente: adota se for compatível,
		// caso contrário informa o conflito para o usuário resolver.
		if (await exists(finalPath)) {
			this.options.onProgress?.({ phase: "activating" });
			const probe = await this.probe(finalPath, signal);
			if (probe.compatible && probe.ompVersion) {
				this.options.log?.("info", "omp.instalacao_existente_adotada", { ompPath: finalPath });
				return { ompPath: finalPath, ompVersion: probe.ompVersion, installDir, downloaded: false };
			}
			throw new OmpInstallError(
				"EXISTING_INCOMPATIBLE",
				`existing-file path=${finalPath} probe=${probe.ompVersion ? `version=${probe.ompVersion}` : "incompatible"}`,
			);
		}

		this.options.onProgress?.({ phase: "resolving" });
		const answer = await this.resolveBuild(version, target, signal);
		if (answer.build.version !== version) {
			throw new OmpInstallError(
				"VERSION_MISMATCH",
				`service-version=${answer.build.version} expected=${version}`,
			);
		}
		assertPlatformFileName(answer.file.name, platform);
		const downloadUrl = assertTrustedDownloadUrl(answer.download, answer.file.name);
		const expectedSha256 = answer.file.sha256.toLowerCase();
		const tempPath = path.join(
			installDir,
			`.omp.download-${process.pid}-${randomBytes(6).toString("hex")}${platform === "win32" ? ".exe" : ""}`,
		);

		let promoted = false;
		try {
			await this.download(downloadUrl, tempPath, expectedSha256, answer.file.size, signal);

			this.options.onProgress?.({ phase: "verifying" });
			try {
				// `link` promove sem copiar os ~240 MB e falha se outro processo
				// criou o destino no meio do download. Em sistemas de arquivos
				// sem hardlink (rede/FAT), cai para `COPYFILE_EXCL`, que também
				// nunca sobrescreve.
				await link(tempPath, finalPath);
				promoted = true;
			} catch (error) {
				const code = errorCodeOf(error);
				if (code === "EEXIST") {
					throw new OmpInstallError(
						"EXISTING_INCOMPATIBLE",
						`destination-created path=${finalPath}`,
					);
				}
				if (
					code === "EPERM" ||
					code === "EACCES" ||
					code === "ENOSYS" ||
					code === "ENOTSUP" ||
					code === "EXDEV" ||
					code === "EINVAL"
				) {
					try {
						await copyFile(tempPath, finalPath, fsConstants.COPYFILE_EXCL);
						promoted = true;
					} catch (copyError) {
						if (errorCodeOf(copyError) === "EEXIST") {
							throw new OmpInstallError(
								"EXISTING_INCOMPATIBLE",
								`destination-created path=${finalPath}`,
							);
						}
						throw new OmpInstallError(
							"WRITE",
							`write-failed path=${finalPath} code=${errorCodeOf(copyError) ?? "unknown"}`,
						);
					}
				} else {
					throw new OmpInstallError(
						"WRITE",
						`write-failed path=${finalPath} code=${code ?? "unknown"}`,
					);
				}
			}

			if (platform !== "win32") {
				// O arquivo temporário nasce 0600; o binário oficial precisa ser
				// executável. Aplicamos a permissão somente no destino promovido.
				try {
					await chmod(finalPath, 0o755);
				} catch (error) {
					throw new OmpInstallError(
						"WRITE",
						`chmod-failed path=${finalPath} code=${errorCodeOf(error) ?? "unknown"}`,
					);
				}
			}

			this.options.onProgress?.({ phase: "activating" });
			const probe = await this.probe(finalPath, signal);
			if (!probe.compatible || !probe.ompVersion) {
				throw new OmpInstallError(
					"VERSION_MISMATCH",
					`probe-failed path=${finalPath}`,
				);
			}
			if (probe.ompVersion !== answer.build.version) {
				throw new OmpInstallError(
					"VERSION_MISMATCH",
					`version-mismatch expected=${answer.build.version} got=${probe.ompVersion}`,
				);
			}
			this.options.log?.("info", "omp.instalacao_concluida", {
				ompPath: finalPath,
				ompVersion: probe.ompVersion,
			});
			return {
				ompPath: finalPath,
				ompVersion: probe.ompVersion,
				installDir,
				downloaded: true,
			};
		} catch (error) {
			// Só remove o que esta execução criou; uma instalação anterior nunca
			// é tocada (o destino já existente nem chega até aqui).
			if (promoted) await rm(finalPath, { force: true }).catch(() => undefined);
			throw error;
		} finally {
			await rm(tempPath, { force: true }).catch(() => undefined);
		}
	}

	private async resolveBuild(version: string, target: string, signal: AbortSignal): Promise<BuildAnswer> {
		assertNotAborted(signal);
		const base = (this.options.baseUrl ?? OMP_BUILD_BASE_URL).replace(/\/+$/, "");
		const url = `${base}/api/products/omp/versions/${encodeURIComponent(version)}/${encodeURIComponent(target)}`;
		const deadline = withTimeout(signal, API_TIMEOUT_MS);
		try {
			const response = await this.fetchImpl(url, {
				signal: deadline.signal,
				redirect: "error",
				headers: { accept: "application/json" },
			});
			if (!response.ok) {
				throw new OmpInstallError("NETWORK", `http-status=${response.status}`);
			}
			const parsed = buildAnswerSchema.safeParse(await response.json());
			if (!parsed.success) {
				throw new OmpInstallError("NETWORK", "unexpected-response");
			}
			return parsed.data;
		} catch (error) {
			if (error instanceof OmpInstallError) throw error;
			if (deadline.signal.aborted) throw abortReason(deadline);
			throw new OmpInstallError("NETWORK", `request-failed ${messageOf(error)}`);
		} finally {
			deadline.dispose();
		}
	}

	private async download(
		url: URL,
		tempPath: string,
		expectedSha256: string,
		expectedSize: number | undefined,
		signal: AbortSignal,
	): Promise<void> {
		assertNotAborted(signal);
		const deadline = withTimeout(signal, DOWNLOAD_TIMEOUT_MS);
		let handle: FileHandle | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await this.fetchImpl(url.toString(), {
				signal: deadline.signal,
				redirect: "error",
			});
			if (!response.ok || !response.body) {
				throw new OmpInstallError("NETWORK", `http-status=${response.status}`);
			}
			const total = expectedSize ?? parseContentLength(response.headers.get("content-length"));
			handle = await open(tempPath, "wx", 0o600);
			const hash = createHash("sha256");
			let received = 0;
			reader = response.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				if (deadline.signal.aborted) throw abortReason(deadline);
				const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
				hash.update(bytes);
				let offset = 0;
				while (offset < bytes.byteLength) {
					const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
					if (bytesWritten <= 0) {
						throw new OmpInstallError("WRITE", `write-failed path=${tempPath}`);
					}
					offset += bytesWritten;
				}
				received += bytes.byteLength;
				this.options.onProgress?.({ phase: "downloading", receivedBytes: received, totalBytes: total });
			}
			await handle.close();
			handle = undefined;
			if (expectedSize !== undefined && received !== expectedSize) {
				throw new OmpInstallError(
					"CHECKSUM",
					`size-mismatch expected=${expectedSize} received=${received}`,
				);
			}
			const actual = hash.digest("hex").toLowerCase();
			if (actual !== expectedSha256) {
				throw new OmpInstallError(
					"CHECKSUM",
					`checksum-mismatch expected=${expectedSha256} actual=${actual}`,
				);
			}
		} catch (error) {
			if (error instanceof OmpInstallError) throw error;
			if (deadline.signal.aborted) throw abortReason(deadline);
			throw new OmpInstallError("NETWORK", `download-failed ${messageOf(error)}`);
		} finally {
			await reader?.cancel().catch(() => undefined);
			if (handle) await handle.close().catch(() => undefined);
			deadline.dispose();
		}
	}

	private async probe(ompPath: string, signal: AbortSignal): Promise<OmpInstallProbeResult> {
		assertNotAborted(signal);
		try {
			const result = await this.options.probe(ompPath, { signal });
			assertNotAborted(signal);
			return result;
		} catch (error) {
			if (error instanceof OmpInstallError) throw error;
			assertNotAborted(signal);
			throw new OmpInstallError(
				"VERSION_MISMATCH",
				`probe-error ${messageOf(error)}`,
			);
		}
	}
}

/**
 * Single-flight: cliques/pedidos concorrentes compartilham a mesma instalação.
 * `cancel()` aborta o download e a verificação; o chamador decide como
 * apresentar o cancelamento.
 */
export class OmpInstallService {
	private active: { promise: Promise<OmpInstallResult>; controller: AbortController } | null = null;

	constructor(private readonly createInstaller: (signal: AbortSignal) => OmpInstaller) {}

	get installing(): boolean {
		return this.active !== null;
	}

	install(): Promise<OmpInstallResult> {
		if (this.active) return this.active.promise;
		const controller = new AbortController();
		const promise = this.createInstaller(controller.signal).install();
		const entry = { promise, controller };
		this.active = entry;
		void promise
			.finally(() => {
				if (this.active === entry) this.active = null;
			})
			.catch(() => undefined);
		return promise;
	}

	cancel(): void {
		this.active?.controller.abort();
	}
}
