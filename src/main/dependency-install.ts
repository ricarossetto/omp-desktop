/**
 * Instalação das dependências opcionais Git e Node.js.
 *
 * Fontes oficiais (nada vem do renderer):
 * - Windows/Git: MinGit, a distribuição ZIP oficial do Git for Windows
 *   documentada para embutir em aplicativos
 *   (https://gitforwindows.org/mingit.html). Versão e SHA-256 fixados a
 *   partir das notas oficiais do release.
 * - Linux/Git: o Git é nativo. O aplicativo nunca baixa MinGit nem executa
 *   sudo/apt/pacman; a UI mostra o comando fixo da distribuição e oferece
 *   nova sondagem depois que o usuário instalar.
 * - Node.js LTS: ZIP oficial de nodejs.org no Windows e TAR.GZ oficial
 *   `linux-x64` no Linux. A versão LTS é resolvida no momento da instalação
 *   pelo `index.json` oficial e o SHA-256 é lido do `SHASUMS256.txt` oficial
 *   da mesma versão, antes do download.
 *
 * Garantias:
 * - nada de winget/MSI/instalador executável, nenhum privilégio de admin;
 * - destino por usuário em `%LOCALAPPDATA%\omp-desktop\tools\{git,node}` no
 *   Windows e em `$XDG_DATA_HOME/omp-desktop/tools/node` (ou
 *   `$HOME/.local/share/...`) no Linux;
 * - download em streaming com limite, SHA-256 conferido antes de extrair;
 * - extração ZIP própria com proteção contra zip-slip, symlink, ADS, nomes
 *   reservados do Windows e bombas de descompressão;
 * - extração TAR.GZ própria no Linux: aceita somente symlinks relativos que
 *   permaneçam dentro da extração (os links oficiais `bin/npm` e `bin/npx`
 *   do Node precisam funcionar), rejeita hardlinks/symlinks que escapem,
 *   caminhos absolutos, `..`, tipos desconhecidos e bombas;
 * - promoção atômica por `rename`, nunca sobrescreve instalação existente;
 * - `--version` do executável extraído é conferido antes e depois da ativação;
 * - nenhum registro/PATH persistente do usuário é alterado. O chamador
 *   prepende `optionalDependencyBinDirs()` ao PATH do processo antes de
 *   criar host/terminais.
 */
import { execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, rmSync } from "node:fs";
import {
	access,
	chmod,
	link,
	lstat,
	mkdir,
	open,
	rename,
	rm,
	symlink,
	type FileHandle,
} from "node:fs/promises";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflateRaw } from "node:zlib";
import type {
	DependencyErrorCode,
	DependencyInstallOptions,
	DependencyInstallProgress,
	DependencyInstallResult,
	DependencyKind,
	DependencyProbe,
} from "../shared/dependency-install-types";

// ---------------------------------------------------------------------------
// Fontes oficiais fixadas
// ---------------------------------------------------------------------------

/** Versão do Git for Windows fixada (release oficial de 2026-10-26). */
export const GIT_WINDOWS_VERSION = "2.56.0.4";
export const GIT_WINDOWS_RELEASE_TAG = "v2.56.0.windows.4";
/** SHA-256 publicados nas notas oficiais do release v2.56.0.windows.4. */
export const GIT_WINDOWS_MINIGIT_SHA256: Readonly<Record<"x64" | "arm64" | "ia32", string>> = {
	x64: "e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877",
	arm64: "70f7649f78088c1db1d2f3571ca46a04d5bef06e4e9d56d8ed7f9829e8c6c4db",
	ia32: "6b3d71c7536d3c85baebaeb26d461e74c755895ccc1f4c817d0e289470419ccc",
};
export const GIT_WINDOWS_MINIGIT_BASE_URL =
	`https://github.com/git-for-windows/git/releases/download/${GIT_WINDOWS_RELEASE_TAG}`;

/** Índice oficial do Node.js; a versão LTS é resolvida em tempo de instalação. */
export const NODE_LTS_INDEX_URL = "https://nodejs.org/dist/index.json";
export const NODE_LTS_DIST_BASE_URL = "https://nodejs.org/dist";

/** Pasta gerenciada por usuário (nunca requer admin). */
export const DEPENDENCY_TOOLS_DIR_NAME = "omp-desktop";
export const DEPENDENCY_TOOLS_SUBDIR = "tools";

const GIT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const NODE_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const API_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Erros e contratos internos
// ---------------------------------------------------------------------------

export class DependencyInstallError extends Error {
	constructor(
		readonly code: DependencyErrorCode,
		message: string,
	) {
		super(message);
		this.name = "DependencyInstallError";
	}
}

/** Contrato mínimo de rede; testes injetam uma implementação determinística. */
export type DependencyFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DependencyProbeContext {
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
}

/**
 * Executa `--version` e devolve a versão normalizada (`x.y.z`), ou
 * `undefined` quando o binário não respondeu. Injetável apenas em testes.
 */
export type DependencyProbeRunner = (
	kind: DependencyKind,
	executablePath: string,
	context: DependencyProbeContext,
) => Promise<string | undefined>;

export interface OptionalDependencyInstallerOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	arch?: string;
	/** Injeção interna de testes; produção usa `fetch` global. */
	fetchImpl?: DependencyFetch;
	/** Injeção interna de testes; produção executa o binário de verdade. */
	probeRunner?: DependencyProbeRunner;
	/** Injeção interna de testes; produção usa os metadados oficiais fixados. */
	artifactResolver?: DependencyArtifactResolver;
	log?(level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): void;
}

export interface DependencyArtifact {
	kind: DependencyKind;
	/** Versão oficial esperada; confere com o `--version` antes de ativar. */
	version: string;
	url: string;
	sha256: string;
	fileName: string;
	maxDownloadBytes: number;
	/** ZIP do Node tem uma pasta raiz (`node-vX-win-x64/`) que é removida. */
	stripTopLevelDir: boolean;
	/** Formato do arquivo baixado; padrão `zip` (Windows). */
	archiveFormat?: "zip" | "tar.gz";
	executablePath: string;
	requiredPaths: string[];
}

/** Injeção interna de testes; produção usa os metadados oficiais fixados. */
export type DependencyArtifactResolver = (
	kind: DependencyKind,
	arch: string,
) => DependencyArtifact | Promise<DependencyArtifact>;

interface Deadline {
	signal: AbortSignal;
	didTimeout(): boolean;
	dispose(): void;
}

// ---------------------------------------------------------------------------
// Caminhos gerenciados e PATH do processo
// ---------------------------------------------------------------------------

/**
 * Raiz gerenciada por usuário:
 * - Windows: `%LOCALAPPDATA%\omp-desktop\tools`;
 * - Linux: `$XDG_DATA_HOME/omp-desktop/tools` (somente XDG absoluto) ou
 *   `$HOME/.local/share/omp-desktop/tools`.
 */
export function resolveDependencyToolsRoot(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === "linux") {
		const xdgDataHome = env.XDG_DATA_HOME?.trim();
		if (xdgDataHome && path.isAbsolute(xdgDataHome)) {
			return path.join(
				path.resolve(xdgDataHome),
				DEPENDENCY_TOOLS_DIR_NAME,
				DEPENDENCY_TOOLS_SUBDIR,
			);
		}
		const home = env.HOME?.trim();
		if (home) {
			return path.join(
				path.resolve(home),
				".local",
				"share",
				DEPENDENCY_TOOLS_DIR_NAME,
				DEPENDENCY_TOOLS_SUBDIR,
			);
		}
		throw new DependencyInstallError(
			"UNSUPPORTED_PLATFORM",
			"HOME/XDG_DATA_HOME missing; cannot resolve per-user tools directory",
		);
	}
	if (platform !== "win32") {
		throw new DependencyInstallError("UNSUPPORTED_PLATFORM", `platform=${platform}`);
	}
	const localAppData = env.LOCALAPPDATA?.trim();
	if (localAppData) {
		return path.join(path.resolve(localAppData), DEPENDENCY_TOOLS_DIR_NAME, DEPENDENCY_TOOLS_SUBDIR);
	}
	const profile = env.USERPROFILE?.trim();
	if (profile) {
		return path.join(
			path.resolve(profile),
			"AppData",
			"Local",
			DEPENDENCY_TOOLS_DIR_NAME,
			DEPENDENCY_TOOLS_SUBDIR,
		);
	}
	throw new DependencyInstallError(
		"UNSUPPORTED_PLATFORM",
		"LOCALAPPDATA/USERPROFILE missing; cannot resolve per-user tools directory",
	);
}

/**
 * Diretórios a prepender no PATH do processo antes de criar host/terminais.
 * Devolve os caminhos mesmo quando ainda não existem (preseed).
 * - Windows: `git/cmd` (wrapper oficial do MinGit) e a raiz do Node, onde
 *   ficam `node.exe`, `npm.cmd` e `npx.cmd`.
 * - Linux: somente `<tools>/node/bin`; o Git é nativo e nunca é gerenciado
 *   pelo aplicativo.
 */
export function optionalDependencyBinDirs(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	let root: string;
	try {
		root = resolveDependencyToolsRoot(env, platform);
	} catch {
		return [];
	}
	if (platform === "linux") return [path.join(root, "node", "bin")];
	return [path.join(root, "git", "cmd"), path.join(root, "node")];
}

function executableName(kind: DependencyKind, platform: NodeJS.Platform): string {
	if (platform === "win32") return kind === "git" ? "git.exe" : "node.exe";
	return kind === "git" ? "git" : "node";
}

function managedExecutablePath(
	root: string,
	kind: DependencyKind,
	platform: NodeJS.Platform,
): string {
	if (platform === "linux") {
		return kind === "git"
			? path.join(root, "git", "bin", "git")
			: path.join(root, "node", "bin", "node");
	}
	return kind === "git"
		? path.join(root, "git", "cmd", "git.exe")
		: path.join(root, "node", "node.exe");
}

function managedNpmPaths(root: string, platform: NodeJS.Platform): string[] {
	const nodeRoot = path.join(root, "node");
	if (platform === "linux") {
		return [
			path.join(nodeRoot, "bin", "npm"),
			path.join(nodeRoot, "bin", "npx"),
			path.join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
			path.join(nodeRoot, "lib", "node_modules", "npm", "bin", "npx-cli.js"),
		];
	}
	return [path.join(nodeRoot, "npm.cmd"), path.join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js")];
}

// ---------------------------------------------------------------------------
// Utilidades gerais
// ---------------------------------------------------------------------------

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

function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new DependencyInstallError("ABORTED", "aborted");
}

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

function abortReason(deadline: Deadline): DependencyInstallError {
	if (deadline.didTimeout()) return new DependencyInstallError("NETWORK", "timeout");
	return new DependencyInstallError("ABORTED", "aborted");
}

function parseContentLength(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeError(error: unknown, signal: AbortSignal): DependencyInstallError {
	if (error instanceof DependencyInstallError) return error;
	if (signal.aborted) return new DependencyInstallError("ABORTED", "aborted");
	const code = errorCodeOf(error);
	if (code === "ENOSPC") return new DependencyInstallError("WRITE", `write-failed code=${code}`);
	return new DependencyInstallError("INTERNAL", messageOf(error));
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, file: string): Promise<void> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
		if (bytesWritten <= 0) {
			throw new DependencyInstallError("WRITE", `write-failed path=${file}`);
		}
		offset += bytesWritten;
	}
}

async function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex").toLowerCase();
}

function pathList(env: NodeJS.ProcessEnv): string[] {
	const raw = env.PATH ?? env.Path ?? "";
	return raw
		.split(path.delimiter)
		.map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
		// Entradas relativas (ex.: ".") resolveriam contra o CWD do projeto
		// aberto; o lookup de ferramentas só aceita caminhos absolutos.
		.filter((entry) => entry.length > 0 && path.isAbsolute(entry));
}

async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	for (const dir of pathList(env)) {
		const candidate = path.join(dir, name);
		if (await exists(candidate)) return candidate;
	}
	return undefined;
}

function parseToolVersion(kind: DependencyKind, output: string): string | undefined {
	if (kind === "git") {
		return output.match(/git version\s+(\d+\.\d+\.\d+)/i)?.[1];
	}
	return output.match(/v?(\d+\.\d+\.\d+)/)?.[1];
}

/** O Git reporta `2.56.0.windows.4`; a versão pública é `2.56.0.4`. */
function versionMatches(expected: string, actual: string): boolean {
	return actual === expected || expected.startsWith(`${actual}.`);
}

function defaultProbeRunner(
	kind: DependencyKind,
	executablePath: string,
	context: DependencyProbeContext,
): Promise<string | undefined> {
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	if (context.signal.aborted) {
		reject(new DependencyInstallError("ABORTED", "aborted"));
		return promise;
	}
	let child: ChildProcess | undefined;
	const onAbort = () => {
		child?.kill();
	};
	context.signal.addEventListener("abort", onAbort, { once: true });
	child = execFile(
		executablePath,
		["--version"],
		{
			env: context.env,
			timeout: PROBE_TIMEOUT_MS,
			windowsHide: true,
			encoding: "utf8",
		},
		(error, stdout, stderr) => {
			context.signal.removeEventListener("abort", onAbort);
			if (context.signal.aborted) {
				reject(new DependencyInstallError("ABORTED", "aborted"));
				return;
			}
			if (error) {
				// O Node Linux oficial exige libatomic.so.1; em Debian 12 mínimo
				// o binário não inicia e o erro precisa ser acionável na UI.
				const detail = `${stderr ?? ""}\n${error.message}`;
				const library = detail.match(
					/(?:error while loading shared libraries|Library not loaded):\s*([^\s:]+)/i,
				)?.[1];
				if (library) {
					reject(
						new DependencyInstallError(
							"MISSING_SYSTEM_LIBRARY",
							`missing-system-library=${library}`,
						),
					);
					return;
				}
				resolve(undefined);
				return;
			}
			resolve(parseToolVersion(kind, stdout));
		},
	);
	return promise;
}

// ---------------------------------------------------------------------------
// URLs oficiais e download
// ---------------------------------------------------------------------------

const OFFICIAL_HOSTS: Readonly<Record<string, true>> = {
	"github.com": true,
	"objects.githubusercontent.com": true,
	"release-assets.githubusercontent.com": true,
	"github-releases.githubusercontent.com": true,
	"nodejs.org": true,
};

/**
 * Aceita somente HTTPS, sem credenciais/porta alternativa, em hosts oficiais
 * e nos caminhos oficiais de release do Git for Windows / nodejs.org.
 */
export function assertOfficialDependencyUrl(raw: string | URL): URL {
	let url: URL;
	try {
		url = typeof raw === "string" ? new URL(raw) : new URL(raw.toString());
	} catch {
		throw new DependencyInstallError("NETWORK", "invalid-url");
	}
	if (url.protocol !== "https:") {
		throw new DependencyInstallError("NETWORK", `url-not-https host=${url.hostname}`);
	}
	if (url.username || url.password) {
		throw new DependencyInstallError("NETWORK", `url-has-credentials host=${url.hostname}`);
	}
	if (url.port && url.port !== "443") {
		throw new DependencyInstallError("NETWORK", `url-unexpected-port host=${url.hostname} port=${url.port}`);
	}
	const host = url.hostname.toLowerCase();
	if (!OFFICIAL_HOSTS[host]) {
		throw new DependencyInstallError("NETWORK", `untrusted-host=${host}`);
	}
	if (host === "github.com" && !url.pathname.startsWith("/git-for-windows/git/releases/download/")) {
		throw new DependencyInstallError("NETWORK", `unexpected-github-path=${url.pathname}`);
	}
	if (host === "nodejs.org" && !url.pathname.startsWith("/dist/")) {
		throw new DependencyInstallError("NETWORK", `unexpected-nodejs-path=${url.pathname}`);
	}
	return url;
}

function parseShasums(text: string, fileName: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/);
		if (match && match[2] === fileName) return match[1].toLowerCase();
	}
	return undefined;
}

interface NodeIndexEntry {
	version: string;
	lts: string | false;
	files: string[];
}

function parseNodeIndex(value: unknown): NodeIndexEntry[] {
	if (!Array.isArray(value)) {
		throw new DependencyInstallError("NETWORK", "node-index-not-array");
	}
	const entries: NodeIndexEntry[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const version = record.version;
		const lts = record.lts;
		const files = record.files;
		if (typeof version !== "string" || !/^v\d+\.\d+\.\d+$/.test(version)) continue;
		if (typeof lts !== "string" && lts !== false) continue;
		if (!Array.isArray(files) || !files.every((file) => typeof file === "string")) continue;
		entries.push({ version, lts, files: files as string[] });
	}
	return entries;
}

// ---------------------------------------------------------------------------
// Leitura e extração segura de ZIP
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32Update(state: number, chunk: Uint8Array): number {
	let value = state;
	for (let index = 0; index < chunk.length; index += 1) {
		value = CRC_TABLE[(value ^ chunk[index]) & 0xff] ^ (value >>> 8);
	}
	return value >>> 0;
}



interface ZipEntry {
	name: string;
	nameBytes: Buffer;
	method: number;
	crc32: number;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	dataOffset: number;
	externalAttributes: number;
	isDirectory: boolean;
}

async function readExactly(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
		if (bytesRead <= 0) {
			throw new DependencyInstallError("ARCHIVE_INVALID", "unexpected-eof");
		}
		offset += bytesRead;
	}
}

async function readZipEntries(handle: FileHandle, fileSize: number): Promise<ZipEntry[]> {
	if (fileSize < 22) throw new DependencyInstallError("ARCHIVE_INVALID", "archive-too-small");
	const tailLength = Math.min(fileSize, 65_557);
	const tail = Buffer.alloc(tailLength);
	await readExactly(handle, tail, fileSize - tailLength);

	let eocd = -1;
	for (let index = tail.length - 22; index >= 0; index -= 1) {
		if (tail.readUInt32LE(index) !== 0x06054b50) continue;
		const commentLength = tail.readUInt16LE(index + 20);
		if (index + 22 + commentLength === tail.length) {
			eocd = index;
			break;
		}
	}
	if (eocd < 0) throw new DependencyInstallError("ARCHIVE_INVALID", "end-of-central-directory-missing");

	const diskNumber = tail.readUInt16LE(eocd + 4);
	const centralDisk = tail.readUInt16LE(eocd + 6);
	const entriesOnDisk = tail.readUInt16LE(eocd + 8);
	const totalEntries = tail.readUInt16LE(eocd + 10);
	const centralSize = tail.readUInt32LE(eocd + 12);
	const centralOffset = tail.readUInt32LE(eocd + 16);

	if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
		throw new DependencyInstallError("ARCHIVE_INVALID", "multi-disk-archive");
	}
	if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
		throw new DependencyInstallError("ARCHIVE_INVALID", "zip64-unsupported");
	}
	if (totalEntries > MAX_ENTRIES) {
		throw new DependencyInstallError("SIZE_LIMIT", `too-many-entries=${totalEntries}`);
	}
	if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
		throw new DependencyInstallError("SIZE_LIMIT", `central-directory-too-large=${centralSize}`);
	}
	if (centralOffset + centralSize > fileSize) {
		throw new DependencyInstallError("ARCHIVE_INVALID", "central-directory-out-of-bounds");
	}

	const central = Buffer.alloc(centralSize);
	await readExactly(handle, central, centralOffset);

	const entries: ZipEntry[] = [];
	const seenNames = new Set<string>();
	let offset = 0;
	let totalUncompressed = 0;
	for (let index = 0; index < totalEntries; index += 1) {
		if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `central-entry-invalid index=${index}`);
		}
		const flags = central.readUInt16LE(offset + 8);
		const method = central.readUInt16LE(offset + 10);
		const crc = central.readUInt32LE(offset + 16);
		const compressedSize = central.readUInt32LE(offset + 20);
		const uncompressedSize = central.readUInt32LE(offset + 24);
		const nameLength = central.readUInt16LE(offset + 28);
		const extraLength = central.readUInt16LE(offset + 30);
		const commentLength = central.readUInt16LE(offset + 32);
		const diskStart = central.readUInt16LE(offset + 34);
		const externalAttributes = central.readUInt32LE(offset + 38);
		const localHeaderOffset = central.readUInt32LE(offset + 42);
		const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
		if (recordEnd > central.length || nameLength === 0) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `central-entry-truncated index=${index}`);
		}
		if (flags & 0x0001) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `encrypted-entry index=${index}`);
		}
		if (diskStart !== 0) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `multi-disk-entry index=${index}`);
		}
		if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
			throw new DependencyInstallError("ARCHIVE_INVALID", "zip64-unsupported");
		}
		if (method !== 0 && method !== 8) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `unsupported-compression=${method}`);
		}
		const nameBytes = Buffer.from(central.subarray(offset + 46, offset + 46 + nameLength));
		const name = nameBytes.toString("utf8");
		const normalizedName = name.replace(/\\/g, "/").toLowerCase();
		if (seenNames.has(normalizedName)) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `duplicate-entry name=${name}`);
		}
		seenNames.add(normalizedName);
		const unixMode = (externalAttributes >>> 16) & 0xffff;
		if ((unixMode & 0xf000) === 0xa000) {
			throw new DependencyInstallError("PATH_ESCAPE", `symlink-entry name=${name}`);
		}
		const isDirectory =
			name.endsWith("/") || (externalAttributes & 0x10) !== 0 || (unixMode & 0xf000) === 0x4000;
		if (isDirectory && (compressedSize !== 0 || uncompressedSize !== 0)) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `directory-with-data name=${name}`);
		}
		if (!isDirectory) {
			if (uncompressedSize > MAX_ENTRY_BYTES) {
				throw new DependencyInstallError("SIZE_LIMIT", `entry-too-large name=${name} size=${uncompressedSize}`);
			}
			totalUncompressed += uncompressedSize;
			if (totalUncompressed > MAX_TOTAL_BYTES) {
				throw new DependencyInstallError("SIZE_LIMIT", `archive-too-large total=${totalUncompressed}`);
			}
		}

		const localHeader = Buffer.alloc(30);
		if (localHeaderOffset + 30 > fileSize) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `local-header-out-of-bounds name=${name}`);
		}
		await readExactly(handle, localHeader, localHeaderOffset);
		if (localHeader.readUInt32LE(0) !== 0x04034b50) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `local-header-invalid name=${name}`);
		}
		const localNameLength = localHeader.readUInt16LE(26);
		const localExtraLength = localHeader.readUInt16LE(28);
		const localName = Buffer.alloc(localNameLength);
		if (localNameLength > 0) {
			await readExactly(handle, localName, localHeaderOffset + 30);
		}
		if (!localName.equals(nameBytes)) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `local-name-mismatch name=${name}`);
		}
		const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
		if (dataOffset + compressedSize > fileSize) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `data-out-of-bounds name=${name}`);
		}

		entries.push({
			name,
			nameBytes,
			method,
			crc32: crc,
			compressedSize,
			uncompressedSize,
			localHeaderOffset,
			dataOffset,
			externalAttributes,
			isDirectory,
		});
		offset = recordEnd;
	}
	return entries;
}

function isReservedWindowsName(segment: string): boolean {
	const base = segment.split(".")[0]?.toUpperCase() ?? "";
	if (/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$)$/.test(base)) return true;
	return /^(COM|LPT)[1-9]$/.test(base);
}

/** Valida o nome da entrada e devolve o destino absoluto dentro da extração. */
function safeExtractPath(root: string, rawName: string): { absolute: string; isDirectory: boolean } {
	const name = rawName.replace(/\\/g, "/");
	if (name.length === 0 || name.includes("\0")) {
		throw new DependencyInstallError("PATH_ESCAPE", "empty-or-nul-entry");
	}
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
		throw new DependencyInstallError("PATH_ESCAPE", `absolute-entry name=${name}`);
	}
	const isDirectory = name.endsWith("/");
	const trimmed = isDirectory ? name.slice(0, -1) : name;
	const segments = trimmed.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || segment === "." || segment === "..") {
			throw new DependencyInstallError("PATH_ESCAPE", `invalid-segment name=${name}`);
		}
		if (/[<>:"|?*\u0000-\u001f]/.test(segment)) {
			throw new DependencyInstallError("PATH_ESCAPE", `invalid-character name=${name}`);
		}
		if (/[. ]$/.test(segment)) {
			throw new DependencyInstallError("PATH_ESCAPE", `trailing-dot-or-space name=${name}`);
		}
		if (isReservedWindowsName(segment)) {
			throw new DependencyInstallError("PATH_ESCAPE", `reserved-name name=${name}`);
		}
	}
	const rootResolved = path.resolve(root);
	const absolute = path.resolve(rootResolved, ...segments);
	if (absolute !== rootResolved && !absolute.startsWith(rootResolved + path.sep)) {
		throw new DependencyInstallError("PATH_ESCAPE", `outside-root name=${name}`);
	}
	return { absolute, isDirectory };
}

function detectStripPrefix(entries: ZipEntry[]): string | undefined {
	if (entries.length === 0) return undefined;
	let top: string | undefined;
	for (const entry of entries) {
		const normalized = entry.name.replace(/\\/g, "/");
		const slash = normalized.indexOf("/");
		if (slash <= 0) return undefined;
		const candidate = normalized.slice(0, slash);
		if (top === undefined) top = candidate;
		else if (top !== candidate) return undefined;
	}
	if (!top) return undefined;
	const prefix = `${top}/`;
	for (const entry of entries) {
		if (!entry.name.replace(/\\/g, "/").startsWith(prefix)) return undefined;
	}
	return prefix;
}

function createZipRangeStream(handle: FileHandle, start: number, length: number): Readable {
	let position = start;
	let remaining = length;
	return new Readable({
		read(size) {
			if (remaining <= 0) {
				this.push(null);
				return;
			}
			const toRead = Math.min(size > 0 ? size : 64 * 1024, remaining);
			const buffer = Buffer.allocUnsafe(toRead);
			void handle
				.read(buffer, 0, toRead, position)
				.then(({ bytesRead }) => {
					if (bytesRead <= 0) {
						this.destroy(new DependencyInstallError("ARCHIVE_INVALID", "unexpected-eof"));
						return;
					}
					position += bytesRead;
					remaining -= bytesRead;
					this.push(buffer.subarray(0, bytesRead));
				})
				.catch((error: unknown) => {
					this.destroy(error instanceof Error ? error : new Error(String(error)));
				});
		},
	});
}

async function extractEntry(
	handle: FileHandle,
	entry: ZipEntry,
	destination: string,
	signal: AbortSignal | undefined,
): Promise<void> {
	const output = await open(destination, "wx", 0o600);
	try {
		if (entry.compressedSize === 0) {
			if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
				throw new DependencyInstallError("ARCHIVE_INVALID", `empty-entry-mismatch name=${entry.name}`);
			}
			return;
		}
		const source = createZipRangeStream(handle, entry.dataOffset, entry.compressedSize);
		const transform = entry.method === 8 ? createInflateRaw() : new PassThrough();
		let written = 0;
		let crc = 0xffffffff;
		const sink = new Writable({
			write(chunk: Buffer, _encoding, callback) {
				void (async () => {
					try {
						if (signal?.aborted) throw new DependencyInstallError("ABORTED", "aborted");
						written += chunk.length;
						if (written > entry.uncompressedSize) {
							throw new DependencyInstallError(
								"SIZE_LIMIT",
								`entry-exceeds-declared-size name=${entry.name}`,
							);
						}
						crc = crc32Update(crc, chunk);
						await writeAll(output, chunk, destination);
						callback();
					} catch (error) {
						callback(error as Error);
					}
				})();
			},
		});
		await pipeline(source, transform, sink);
		if (written !== entry.uncompressedSize) {
			throw new DependencyInstallError(
				"ARCHIVE_INVALID",
				`size-mismatch name=${entry.name} expected=${entry.uncompressedSize} got=${written}`,
			);
		}
		if (((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
			throw new DependencyInstallError("ARCHIVE_INVALID", `crc-mismatch name=${entry.name}`);
		}
	} finally {
		await output.close().catch(() => undefined);
	}
}

function archiveExtractError(error: unknown, name: string): DependencyInstallError {
	if (error instanceof DependencyInstallError) return error;
	const code = errorCodeOf(error);
	if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") {
		return new DependencyInstallError("ARCHIVE_INVALID", `conflicting-entry name=${name} code=${code}`);
	}
	return new DependencyInstallError("WRITE", `extract-failed name=${name} code=${code ?? "unknown"}`);
}

async function extractZipArchive(
	archivePath: string,
	destination: string,
	options: { stripTopLevelDir: boolean; signal?: AbortSignal },
): Promise<void> {
	const handle = await open(archivePath, "r");
	try {
		const { size } = await handle.stat();
		const entries = await readZipEntries(handle, size);
		const stripPrefix = options.stripTopLevelDir ? detectStripPrefix(entries) : undefined;
		for (const entry of entries) {
			if (options.signal?.aborted) throw new DependencyInstallError("ABORTED", "aborted");
			let name = entry.name.replace(/\\/g, "/");
			if (stripPrefix) {
				if (name === stripPrefix.slice(0, -1)) continue;
				if (!name.startsWith(stripPrefix)) {
					throw new DependencyInstallError("ARCHIVE_INVALID", `unexpected-entry name=${entry.name}`);
				}
				name = name.slice(stripPrefix.length);
				if (name.length === 0) continue;
			}
			const target = safeExtractPath(destination, name);
			if (entry.isDirectory || target.isDirectory) {
				try {
					await mkdir(target.absolute, { recursive: true });
				} catch (error) {
					throw archiveExtractError(error, name);
				}
				continue;
			}
			try {
				await mkdir(path.dirname(target.absolute), { recursive: true });
				await extractEntry(handle, entry, target.absolute, options.signal);
			} catch (error) {
				throw archiveExtractError(error, name);
			}
		}
	} finally {
		await handle.close().catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------
// Leitura e extração segura de TAR.GZ (Node.js Linux)
// ---------------------------------------------------------------------------

const TAR_BLOCK_SIZE = 512;
const MAX_TAR_METADATA_BYTES = 1024 * 1024;

interface TarHeader {
	name: string;
	mode: number;
	size: number;
	type: string;
	linkName: string;
}

interface TarPaxOverrides {
	path?: string;
	linkpath?: string;
	size?: number;
}

function parseTarString(block: Buffer, offset: number, length: number): string {
	const end = block.indexOf(0, offset);
	const sliceEnd = end >= 0 && end < offset + length ? end : offset + length;
	return block.toString("utf8", offset, sliceEnd);
}

function parseTarNumber(block: Buffer, offset: number, length: number): number {
	const first = block[offset];
	if (first !== undefined && (first & 0x80) !== 0) {
		// GNU base-256 para tamanhos grandes.
		let value = BigInt(first & 0x7f);
		for (let index = 1; index < length; index += 1) {
			value = value * 256n + BigInt(block[offset + index] ?? 0);
		}
		return Number(value);
	}
	const text = block.toString("ascii", offset, offset + length).replace(/\0.*$/, "").trim();
	if (text.length === 0) return 0;
	if (!/^[0-7]+$/.test(text)) {
		throw new DependencyInstallError("ARCHIVE_INVALID", "invalid-tar-number");
	}
	return Number.parseInt(text, 8);
}

function tarChecksum(block: Buffer, signed: boolean): number {
	let sum = 0;
	for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
		const byte = index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
		sum += signed && byte > 127 ? byte - 256 : byte;
	}
	return sum;
}

function parseTarHeader(block: Buffer): TarHeader {
	const stored = parseTarNumber(block, 148, 8);
	if (stored !== tarChecksum(block, false) && stored !== tarChecksum(block, true)) {
		throw new DependencyInstallError("ARCHIVE_INVALID", "tar-checksum-mismatch");
	}
	const magic = block.toString("ascii", 257, 263);
	const prefix = magic.startsWith("ustar") ? parseTarString(block, 345, 155) : "";
	const rawName = parseTarString(block, 0, 100);
	const name = prefix ? `${prefix}/${rawName}` : rawName;
	const type = String.fromCharCode(block[156] ?? 0x30) || "0";
	return {
		name,
		mode: parseTarNumber(block, 100, 8),
		size: parseTarNumber(block, 124, 12),
		type,
		linkName: parseTarString(block, 157, 100),
	};
}

function parseTarPax(data: Buffer): TarPaxOverrides {
	const overrides: TarPaxOverrides = {};
	let offset = 0;
	while (offset < data.length) {
		if (data[offset] === 0) break;
		const space = data.indexOf(0x20, offset);
		if (space < 0) {
			throw new DependencyInstallError("ARCHIVE_INVALID", "invalid-pax-record");
		}
		const length = Number.parseInt(data.toString("ascii", offset, space), 10);
		if (!Number.isFinite(length) || length <= 0 || offset + length > data.length) {
			throw new DependencyInstallError("ARCHIVE_INVALID", "invalid-pax-length");
		}
		const record = data.toString("utf8", space + 1, offset + length - 1);
		const equals = record.indexOf("=");
		if (equals > 0) {
			const key = record.slice(0, equals);
			const value = record.slice(equals + 1);
			if (key === "path") overrides.path = value;
			else if (key === "linkpath") overrides.linkpath = value;
			else if (key === "size") {
				const parsed = Number.parseInt(value, 10);
				if (!Number.isFinite(parsed) || parsed < 0) {
					throw new DependencyInstallError("ARCHIVE_INVALID", "invalid-pax-size");
				}
				overrides.size = parsed;
			}
		}
		offset += length;
	}
	return overrides;
}

function isZeroTarBlock(block: Buffer): boolean {
	for (const byte of block) if (byte !== 0) return false;
	return true;
}

function tarPadding(size: number): number {
	return (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
}

/** Caminho POSIX seguro: relativo, sem `..`, sem absoluto e dentro da raiz. */
function safePosixExtractPath(
	root: string,
	rawName: string,
): { absolute: string; isDirectory: boolean } {
	if (rawName.length === 0 || rawName.length > 4096 || rawName.includes("\0")) {
		throw new DependencyInstallError("PATH_ESCAPE", "empty-or-nul-entry");
	}
	const name = rawName.replace(/\\/g, "/");
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
		throw new DependencyInstallError("PATH_ESCAPE", `absolute-entry name=${rawName}`);
	}
	const isDirectory = name.endsWith("/");
	const trimmed = isDirectory ? name.slice(0, -1) : name;
	const segments = trimmed.split("/");
	for (const segment of segments) {
		if (segment.length === 0 || segment === "." || segment === "..") {
			throw new DependencyInstallError("PATH_ESCAPE", `invalid-segment name=${rawName}`);
		}
	}
	const rootResolved = path.resolve(root);
	const absolute = path.resolve(rootResolved, ...segments);
	if (absolute === rootResolved || !absolute.startsWith(rootResolved + path.sep)) {
		throw new DependencyInstallError("PATH_ESCAPE", `outside-root name=${rawName}`);
	}
	return { absolute, isDirectory };
}

/** Nenhuma entrada pode ser gravada atravessando um symlink criado antes. */
function assertNoSymlinkAncestor(
	root: string,
	absolute: string,
	symlinks: ReadonlyMap<string, string>,
): void {
	let current = path.dirname(absolute);
	while (current !== root && current.startsWith(root + path.sep)) {
		if (symlinks.has(current)) {
			throw new DependencyInstallError("PATH_ESCAPE", `symlink-ancestor path=${current}`);
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
}

/**
 * Resolve um alvo de symlink como o kernel faria, componente por componente,
 * seguindo os symlinks já extraídos. Não normaliza `x/..` antes de resolver
 * `x`: a validação textual sozinha deixaria `y -> x/../../..` parecer dentro
 * da raiz quando `x` aponta para outro lugar. Qualquer `..` que ultrapasse a
 * raiz, alvo absoluto ou ciclo é recusado.
 */
function resolveLinkTarget(
	root: string,
	baseDir: string,
	linkName: string,
	symlinks: ReadonlyMap<string, string>,
	hops = 0,
): string {
	const rootResolved = path.resolve(root);
	if (hops > 40) {
		throw new DependencyInstallError("PATH_ESCAPE", "symlink-loop");
	}
	let current = path.resolve(baseDir);
	if (current !== rootResolved && !current.startsWith(rootResolved + path.sep)) {
		throw new DependencyInstallError("PATH_ESCAPE", `outside-root base=${baseDir}`);
	}
	for (const segment of linkName.replace(/\\/g, "/").split("/")) {
		if (segment.length === 0 || segment === ".") continue;
		if (segment === "..") {
			if (current === rootResolved) {
				throw new DependencyInstallError("PATH_ESCAPE", `outside-root target=${linkName}`);
			}
			current = path.dirname(current);
			continue;
		}
		const candidate = path.join(current, segment);
		const nested = symlinks.get(candidate);
		if (nested !== undefined) {
			current = resolveLinkTarget(
				rootResolved,
				path.dirname(candidate),
				nested,
				symlinks,
				hops + 1,
			);
		} else {
			current = candidate;
		}
	}
	if (current !== rootResolved && !current.startsWith(rootResolved + path.sep)) {
		throw new DependencyInstallError("PATH_ESCAPE", `outside-root target=${linkName}`);
	}
	return current;
}

/** Symlink do TAR: alvo relativo que, resolvido de verdade, fica na extração. */
function safeSymlinkTarget(
	root: string,
	linkPath: string,
	linkName: string,
	symlinks: ReadonlyMap<string, string>,
): string {
	if (linkName.length === 0 || linkName.includes("\0")) {
		throw new DependencyInstallError("PATH_ESCAPE", "empty-symlink-target");
	}
	if (path.isAbsolute(linkName) || /^[A-Za-z]:/.test(linkName)) {
		throw new DependencyInstallError("PATH_ESCAPE", `absolute-symlink-target=${linkName}`);
	}
	const resolved = resolveLinkTarget(root, path.dirname(linkPath), linkName, symlinks);
	if (resolved === linkPath) {
		throw new DependencyInstallError("PATH_ESCAPE", `self-symlink target=${linkName}`);
	}
	if (resolved === path.resolve(root)) {
		throw new DependencyInstallError("PATH_ESCAPE", `symlink-to-root target=${linkName}`);
	}
	return resolved;
}

/**
 * Revalida todos os symlinks depois da extração. Um link criado cedo pode
 * passar a atravessar outro symlink criado depois; o kernel resolveria os dois
 * na hora do uso, então a checagem precisa acontecer com o mapa completo.
 */
function validateExtractedSymlinks(
	root: string,
	symlinks: ReadonlyMap<string, string>,
): void {
	for (const [linkPath, linkName] of symlinks) {
		const resolved = resolveLinkTarget(root, path.dirname(linkPath), linkName, symlinks);
		if (resolved === linkPath) {
			throw new DependencyInstallError("PATH_ESCAPE", `self-symlink path=${linkPath}`);
		}
		if (resolved === path.resolve(root)) {
			throw new DependencyInstallError("PATH_ESCAPE", `symlink-to-root path=${linkPath}`);
		}
	}
}

function tarExtractError(error: unknown, name: string): DependencyInstallError {
	if (error instanceof DependencyInstallError) return error;
	const code = errorCodeOf(error);
	if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") {
		return new DependencyInstallError("ARCHIVE_INVALID", `conflicting-entry name=${name} code=${code}`);
	}
	return new DependencyInstallError("WRITE", `extract-failed name=${name} code=${code ?? "unknown"}`);
}

/** Leitor sequencial sobre o stream descomprimido, sem carregar o TAR inteiro. */
class TarByteReader {
	private readonly iterator: AsyncIterator<Buffer | Uint8Array>;
	private chunk: Buffer = Buffer.alloc(0);
	private offset = 0;

	constructor(stream: Readable) {
		this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | Uint8Array>;
	}

	private async ensure(): Promise<boolean> {
		while (this.offset >= this.chunk.length) {
			const next = await this.iterator.next();
			if (next.done) return false;
			const value = next.value;
			this.chunk = Buffer.isBuffer(value)
				? value
				: Buffer.from(value.buffer, value.byteOffset, value.byteLength);
			this.offset = 0;
		}
		return true;
	}

	async readExactly(length: number): Promise<Buffer> {
		const output = Buffer.alloc(length);
		let written = 0;
		while (written < length) {
			if (!(await this.ensure())) {
				throw new DependencyInstallError("ARCHIVE_INVALID", "unexpected-eof");
			}
			const take = Math.min(length - written, this.chunk.length - this.offset);
			this.chunk.copy(output, written, this.offset, this.offset + take);
			this.offset += take;
			written += take;
		}
		return output;
	}

	async copyExactly(
		length: number,
		onChunk: (chunk: Buffer) => Promise<void> | void,
	): Promise<void> {
		let remaining = length;
		while (remaining > 0) {
			if (!(await this.ensure())) {
				throw new DependencyInstallError("ARCHIVE_INVALID", "unexpected-eof");
			}
			const take = Math.min(remaining, this.chunk.length - this.offset);
			await onChunk(this.chunk.subarray(this.offset, this.offset + take));
			this.offset += take;
			remaining -= take;
		}
	}

	async skip(length: number): Promise<void> {
		let remaining = length;
		while (remaining > 0) {
			if (!(await this.ensure())) {
				throw new DependencyInstallError("ARCHIVE_INVALID", "unexpected-eof");
			}
			const take = Math.min(remaining, this.chunk.length - this.offset);
			this.offset += take;
			remaining -= take;
		}
	}

	async close(): Promise<void> {
		await this.iterator.return?.();
	}
}

async function extractTarGzArchive(
	archivePath: string,
	destination: string,
	options: { stripTopLevelDir: boolean; signal?: AbortSignal },
): Promise<void> {
	const source = createReadStream(archivePath);
	const gunzip = createGunzip();
	source.on("error", (error) => gunzip.destroy(error));
	source.pipe(gunzip);
	const reader = new TarByteReader(gunzip);
	const root = path.resolve(destination);
	const symlinks = new Map<string, string>();
	let stripPrefix: string | undefined;
	let entries = 0;
	let totalBytes = 0;
	let pendingName: string | undefined;
	let pendingLink: string | undefined;
	let pendingPax: TarPaxOverrides | undefined;

	try {
		for (;;) {
			if (options.signal?.aborted) {
				throw new DependencyInstallError("ABORTED", "aborted");
			}
			const headerBlock = await reader.readExactly(TAR_BLOCK_SIZE);
			if (isZeroTarBlock(headerBlock)) break;
			const header = parseTarHeader(headerBlock);
			entries += 1;
			if (entries > MAX_ENTRIES) {
				throw new DependencyInstallError("SIZE_LIMIT", `too-many-entries=${entries}`);
			}
			const type = header.type;
			if (type === "L" || type === "K" || type === "x" || type === "g") {
				if (header.size > MAX_TAR_METADATA_BYTES) {
					throw new DependencyInstallError("SIZE_LIMIT", `metadata-too-large=${header.size}`);
				}
				const data = await reader.readExactly(header.size);
				await reader.skip(tarPadding(header.size));
				if (type === "L") pendingName = data.toString("utf8").replace(/\0.*$/, "");
				else if (type === "K") pendingLink = data.toString("utf8").replace(/\0.*$/, "");
				else if (type === "x") pendingPax = parseTarPax(data);
				else parseTarPax(data);
				continue;
			}

			let name = pendingName ?? header.name;
			let linkName = pendingLink ?? header.linkName;
			let size = header.size;
			if (pendingPax) {
				if (pendingPax.path !== undefined) name = pendingPax.path;
				if (pendingPax.linkpath !== undefined) linkName = pendingPax.linkpath;
				if (pendingPax.size !== undefined) size = pendingPax.size;
			}
			pendingName = undefined;
			pendingLink = undefined;
			pendingPax = undefined;

			if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\0")) {
				throw new DependencyInstallError("PATH_ESCAPE", `absolute-entry name=${name}`);
			}

			if (options.stripTopLevelDir) {
				if (stripPrefix === undefined) {
					const normalized = name.replace(/\\/g, "/");
					const slash = normalized.indexOf("/");
					if (slash <= 0) {
						throw new DependencyInstallError(
							"ARCHIVE_INVALID",
							`missing-top-level-dir name=${name}`,
						);
					}
					stripPrefix = `${normalized.slice(0, slash)}/`;
				}
				if (name === stripPrefix.slice(0, -1)) {
					await reader.skip(size + tarPadding(size));
					continue;
				}
				if (!name.startsWith(stripPrefix)) {
					throw new DependencyInstallError("ARCHIVE_INVALID", `unexpected-entry name=${name}`);
				}
				name = name.slice(stripPrefix.length);
				if (name.length === 0) {
					await reader.skip(size + tarPadding(size));
					continue;
				}
			}

			if (type === "5") {
				if (size !== 0) {
					throw new DependencyInstallError("ARCHIVE_INVALID", `directory-with-data name=${name}`);
				}
				const target = safePosixExtractPath(root, name);
				assertNoSymlinkAncestor(root, target.absolute, symlinks);
				const existing = await lstat(target.absolute).catch(() => undefined);
				if (existing?.isSymbolicLink()) {
					// mkdir/chmod seguiriam o link e alterariam o alvo fora da raiz.
					throw new DependencyInstallError(
						"PATH_ESCAPE",
						`directory-over-symlink name=${name}`,
					);
				}
				if (existing && !existing.isDirectory()) {
					throw new DependencyInstallError(
						"ARCHIVE_INVALID",
						`directory-conflict name=${name}`,
					);
				}
				try {
					await mkdir(target.absolute, { recursive: true });
					await chmod(target.absolute, (header.mode & 0o777) || 0o755);
				} catch (error) {
					throw tarExtractError(error, name);
				}
				await reader.skip(tarPadding(size));
				continue;
			}

			if (type === "2") {
				if (size !== 0) {
					throw new DependencyInstallError("ARCHIVE_INVALID", `symlink-with-data name=${name}`);
				}
				const target = safePosixExtractPath(root, name);
				assertNoSymlinkAncestor(root, target.absolute, symlinks);
				safeSymlinkTarget(root, target.absolute, linkName, symlinks);
				try {
					await mkdir(path.dirname(target.absolute), { recursive: true });
					await symlink(linkName, target.absolute);
				} catch (error) {
					throw tarExtractError(error, name);
				}
				symlinks.set(target.absolute, linkName);
				await reader.skip(tarPadding(size));
				continue;
			}

			if (type === "1") {
				if (size !== 0) {
					throw new DependencyInstallError("ARCHIVE_INVALID", `hardlink-with-data name=${name}`);
				}
				const target = safePosixExtractPath(root, name);
				assertNoSymlinkAncestor(root, target.absolute, symlinks);
				let hardlinkName = linkName;
				if (stripPrefix) {
					if (!hardlinkName.startsWith(stripPrefix)) {
						throw new DependencyInstallError(
							"ARCHIVE_INVALID",
							`unexpected-hardlink name=${hardlinkName}`,
						);
					}
					hardlinkName = hardlinkName.slice(stripPrefix.length);
				}
				const hardlinkTarget = safePosixExtractPath(root, hardlinkName);
				if (hardlinkTarget.absolute === target.absolute) {
					throw new DependencyInstallError("PATH_ESCAPE", `self-hardlink name=${name}`);
				}
				// lstat/link seguem symlinks intermediários; nenhum ancestral do
				// alvo pode ser um link criado pela extração.
				assertNoSymlinkAncestor(root, hardlinkTarget.absolute, symlinks);
				const info = await lstat(hardlinkTarget.absolute).catch(() => undefined);
				if (!info || !info.isFile() || info.isSymbolicLink()) {
					throw new DependencyInstallError(
						"ARCHIVE_INVALID",
						`hardlink-target-missing name=${name}`,
					);
				}
				try {
					await mkdir(path.dirname(target.absolute), { recursive: true });
					await link(hardlinkTarget.absolute, target.absolute);
				} catch (error) {
					throw tarExtractError(error, name);
				}
				await reader.skip(tarPadding(size));
				continue;
			}

			if (type !== "0" && type !== "\0" && type !== "7") {
				throw new DependencyInstallError(
					"ARCHIVE_INVALID",
					`unsupported-entry-type=${type} name=${name}`,
				);
			}

			if (size > MAX_ENTRY_BYTES) {
				throw new DependencyInstallError(
					"SIZE_LIMIT",
					`entry-too-large name=${name} size=${size}`,
				);
			}
			totalBytes += size;
			if (totalBytes > MAX_TOTAL_BYTES) {
				throw new DependencyInstallError("SIZE_LIMIT", `archive-too-large total=${totalBytes}`);
			}
			const target = safePosixExtractPath(root, name);
			assertNoSymlinkAncestor(root, target.absolute, symlinks);
			const mode = (header.mode & 0o777) || 0o644;
			let handle: FileHandle | undefined;
			try {
				await mkdir(path.dirname(target.absolute), { recursive: true });
				handle = await open(target.absolute, "wx", mode);
				const output = handle;
				await reader.copyExactly(size, async (chunk) => {
					if (options.signal?.aborted) {
						throw new DependencyInstallError("ABORTED", "aborted");
					}
					await writeAll(output, chunk, target.absolute);
				});
				await handle.close();
				handle = undefined;
				await chmod(target.absolute, mode);
			} catch (error) {
				await handle?.close().catch(() => undefined);
				throw tarExtractError(error, name);
			}
			await reader.skip(tarPadding(size));
		}
		validateExtractedSymlinks(root, symlinks);
	} catch (error) {
		if (error instanceof DependencyInstallError) throw error;
		if (options.signal?.aborted) {
			throw new DependencyInstallError("ABORTED", "aborted");
		}
		const code = errorCodeOf(error);
		throw new DependencyInstallError(
			"ARCHIVE_INVALID",
			`tar-failed code=${code ?? "unknown"} ${messageOf(error)}`,
		);
	} finally {
		source.destroy();
		gunzip.destroy();
		await reader.close().catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------
// Instalador
// ---------------------------------------------------------------------------

interface ActiveInstall {
	promise: Promise<DependencyInstallResult>;
	controller: AbortController;
}

export class OptionalDependencyInstaller {
	private readonly env: NodeJS.ProcessEnv;
	private readonly platform: NodeJS.Platform;
	private readonly arch: string;
	private readonly fetchImpl: DependencyFetch;
	private readonly probeRunner: DependencyProbeRunner;
	private readonly artifactResolver: DependencyArtifactResolver | undefined;
	private readonly log: OptionalDependencyInstallerOptions["log"];
	private readonly active = new Map<DependencyKind, ActiveInstall>();

	constructor(options: OptionalDependencyInstallerOptions = {}) {
		this.env = options.env ?? process.env;
		this.platform = options.platform ?? process.platform;
		this.arch = options.arch ?? process.arch;
		this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
		this.probeRunner = options.probeRunner ?? defaultProbeRunner;
		this.artifactResolver = options.artifactResolver;
		this.log = options.log;
	}

	/** Há alguma instalação em andamento (qualquer ferramenta)? */
	get installing(): boolean {
		return this.active.size > 0;
	}

	hasActiveWork(): boolean {
		return this.installing;
	}

	/** Aborta todas as instalações ativas; cada uma limpa seus próprios temporários. */
	cancel(): void {
		for (const entry of this.active.values()) entry.controller.abort();
	}

	/**
	 * Sonda sem rede e sem escrita: pasta gerenciada primeiro, depois PATH.
	 * Nunca lança; devolve `error` com código estável.
	 */
	async probe(kind: DependencyKind, signal?: AbortSignal): Promise<DependencyProbe> {
		const effective = signal ?? new AbortController().signal;
		if (effective.aborted) {
			return { state: "error", kind, code: "ABORTED", message: "aborted" };
		}
		try {
			const root = this.toolsRoot();
			const managedDir = path.join(root, kind);
			// No Linux o Git é nativo: uma pasta `tools/git` residual nunca é
			// tratada como instalação gerenciada.
			if ((this.platform === "win32" || kind === "node") && (await exists(managedDir))) {
				return await this.probeManaged(kind, managedDir, effective);
			}
			return await this.probePath(kind, effective);
		} catch (error) {
			return this.probeFailure(kind, error);
		}
	}

	/**
	 * Instala (ou adota) uma ferramenta. Single-flight por ferramenta: chamadas
	 * concorrentes do mesmo tipo compartilham a mesma promise. Nunca sobrescreve
	 * uma instalação existente.
	 */
	install(kind: DependencyKind, options: DependencyInstallOptions = {}): Promise<DependencyInstallResult> {
		const current = this.active.get(kind);
		if (current) return current.promise;

		const controller = new AbortController();
		const forwardAbort = () => controller.abort();
		if (options.signal) {
			if (options.signal.aborted) controller.abort();
			else options.signal.addEventListener("abort", forwardAbort, { once: true });
		}
		const promise = this.runInstall(kind, {
			signal: controller.signal,
			onProgress: options.onProgress,
		}).finally(() => {
			options.signal?.removeEventListener("abort", forwardAbort);
			if (this.active.get(kind)?.promise === promise) this.active.delete(kind);
		});
		const entry: ActiveInstall = { promise, controller };
		this.active.set(kind, entry);
		void promise.catch(() => undefined);
		return promise;
	}

	private toolsRoot(): string {
		if (this.platform !== "win32" && this.platform !== "linux") {
			throw new DependencyInstallError("UNSUPPORTED_PLATFORM", `platform=${this.platform}`);
		}
		return resolveDependencyToolsRoot(this.env, this.platform);
	}

	private probeFailure(kind: DependencyKind, error: unknown): DependencyProbe {
		if (error instanceof DependencyInstallError) {
			return { state: "error", kind, code: error.code, message: error.message };
		}
		return { state: "error", kind, code: "INTERNAL", message: messageOf(error) };
	}

	private async probeManaged(
		kind: DependencyKind,
		managedDir: string,
		signal: AbortSignal,
	): Promise<DependencyProbe> {
		const executable = managedExecutablePath(path.dirname(managedDir), kind, this.platform);
		if (!(await exists(executable))) {
			return {
				state: "error",
				kind,
				code: "INCOMPLETE_INSTALL",
				message: `missing-executable path=${executable}`,
			};
		}
		if (kind === "node") {
			for (const required of managedNpmPaths(path.dirname(managedDir), this.platform)) {
				if (!(await exists(required))) {
					return {
						state: "error",
						kind,
						code: "INCOMPLETE_INSTALL",
						message: `missing-npm path=${required}`,
					};
				}
			}
		}
		const version = await this.runProbe(kind, executable, signal);
		if (!version) {
			return {
				state: "error",
				kind,
				code: "PROBE_FAILED",
				message: `version-check-failed path=${executable}`,
			};
		}
		return { state: "installed", kind, executablePath: executable, version };
	}

	private async probePath(kind: DependencyKind, signal: AbortSignal): Promise<DependencyProbe> {
		const found = await findOnPath(executableName(kind, this.platform), this.env);
		if (!found) return { state: "missing", kind };
		const version = await this.runProbe(kind, found, signal);
		if (!version) {
			return {
				state: "error",
				kind,
				code: "PROBE_FAILED",
				message: `version-check-failed path=${found}`,
			};
		}
		return { state: "installed", kind, executablePath: found, version };
	}

	private probeEnv(kind: DependencyKind, executablePath: string): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...this.env };
		const dirs = [path.dirname(executablePath)];
		if (this.platform === "win32" && kind === "git") {
			// MinGit depende das DLLs em ucrt64/mingw64/usr; o wrapper cmd/git.exe
			// não as encontra sozinho em todos os layouts.
			const gitRoot = path.dirname(path.dirname(executablePath));
			dirs.push(
				path.join(gitRoot, "ucrt64", "bin"),
				path.join(gitRoot, "mingw64", "bin"),
				path.join(gitRoot, "bin"),
				path.join(gitRoot, "usr", "bin"),
			);
		}
		delete env.Path;
		env.PATH = [...dirs, ...pathList(this.env)].join(path.delimiter);
		return env;
	}

	private async runProbe(
		kind: DependencyKind,
		executablePath: string,
		signal: AbortSignal,
	): Promise<string | undefined> {
		if (signal.aborted) throw new DependencyInstallError("ABORTED", "aborted");
		try {
			const version = await this.probeRunner(kind, executablePath, {
				env: this.probeEnv(kind, executablePath),
				signal,
			});
			if (signal.aborted) throw new DependencyInstallError("ABORTED", "aborted");
			return version;
		} catch (error) {
			if (error instanceof DependencyInstallError) throw error;
			if (signal.aborted) throw new DependencyInstallError("ABORTED", "aborted");
			return undefined;
		}
	}

	private async runInstall(
		kind: DependencyKind,
		options: DependencyInstallOptions,
	): Promise<DependencyInstallResult> {
		const signal = options.signal ?? new AbortController().signal;
		assertNotAborted(signal);
		const toolsRoot = this.toolsRoot();
		const managedDir = path.join(toolsRoot, kind);

		// 1. Instalação gerenciada existente: adota se compatível, nunca sobrescreve.
		// No Linux o Git é nativo; uma pasta `tools/git` residual é ignorada.
		if ((this.platform === "win32" || kind === "node") && (await exists(managedDir))) {
			const probe = await this.probeManaged(kind, managedDir, signal);
			if (probe.state === "installed") {
				this.log?.("info", "dependency.instalacao_existente_adotada", {
					kind,
					executablePath: probe.executablePath,
					version: probe.version,
				});
				return { kind, executablePath: probe.executablePath, version: probe.version };
			}
			throw new DependencyInstallError(
				probe.state === "error" && probe.code === "INCOMPLETE_INSTALL"
					? "INCOMPLETE_INSTALL"
					: "EXISTING_INCOMPATIBLE",
				`existing-install path=${managedDir} detail=${probe.state === "error" ? probe.message : "unusable"}`,
			);
		}

		// 2. Instalação global funcional: adota intacta, sem baixar nada.
		const onPath = await this.probePath(kind, signal);
		if (onPath.state === "installed") {
			this.log?.("info", "dependency.adotada_do_path", {
				kind,
				executablePath: onPath.executablePath,
				version: onPath.version,
			});
			return { kind, executablePath: onPath.executablePath, version: onPath.version };
		}

		if (this.platform === "linux" && kind === "git") {
			// Git no Linux é sempre nativo: nunca baixamos MinGit, nunca rodamos
			// sudo/apt/pacman e nunca pedimos senha. A UI mostra o comando fixo
			// da distribuição e o usuário decide quando instalar.
			throw new DependencyInstallError(
				"MANUAL_INSTALL_REQUIRED",
				"git-native-required platform=linux",
			);
		}

		// 3. Metadados oficiais fixados ANTES do download.
		options.onProgress?.({ phase: "resolving" });
		const artifact = this.artifactResolver
			? await this.artifactResolver(kind, this.arch)
			: kind === "git"
				? gitArtifact(this.arch)
				: await this.resolveNodeArtifact(signal);
		assertNotAborted(signal);

		await mkdir(toolsRoot, { recursive: true });
		const tempDir = path.join(
			toolsRoot,
			`.tmp-${kind}-${process.pid}-${randomBytes(6).toString("hex")}`,
		);
		await mkdir(tempDir, { recursive: false });
		const archivePath = path.join(tempDir, artifact.fileName);
		const extractDir = path.join(tempDir, "extract");
		let promoted = false;
		const exitCleanup = () => {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// processo encerrando: melhor esforço
			}
		};
		process.once("exit", exitCleanup);
		try {
			await this.download(artifact, archivePath, options.onProgress, signal);

			options.onProgress?.({ phase: "verifying" });
			const actual = await sha256File(archivePath);
			if (actual !== artifact.sha256) {
				throw new DependencyInstallError(
					"CHECKSUM",
					`checksum-mismatch expected=${artifact.sha256} actual=${actual}`,
				);
			}

			options.onProgress?.({ phase: "extracting" });
			await mkdir(extractDir, { recursive: true });
			if (artifact.archiveFormat === "tar.gz") {
				await extractTarGzArchive(archivePath, extractDir, {
					stripTopLevelDir: artifact.stripTopLevelDir,
					signal,
				});
			} else {
				await extractZipArchive(archivePath, extractDir, {
					stripTopLevelDir: artifact.stripTopLevelDir,
					signal,
				});
			}

			const extractedExecutable = path.join(extractDir, artifact.executablePath);
			if (!(await exists(extractedExecutable))) {
				throw new DependencyInstallError(
					"ARCHIVE_INVALID",
					`missing-executable entry=${artifact.executablePath}`,
				);
			}
			for (const required of artifact.requiredPaths) {
				if (!(await exists(path.join(extractDir, required)))) {
					throw new DependencyInstallError("ARCHIVE_INVALID", `missing-entry entry=${required}`);
				}
			}

			const extractedVersion = await this.runProbe(kind, extractedExecutable, signal);
			if (!extractedVersion) {
				throw new DependencyInstallError(
					"VERSION_MISMATCH",
					`version-probe-failed path=${extractedExecutable}`,
				);
			}
			if (!versionMatches(artifact.version, extractedVersion)) {
				throw new DependencyInstallError(
					"VERSION_MISMATCH",
					`version-mismatch expected=${artifact.version} got=${extractedVersion}`,
				);
			}

			options.onProgress?.({ phase: "activating" });
			await this.activate(extractDir, managedDir);
			promoted = true;

			const finalExecutable = path.join(managedDir, artifact.executablePath);
			const finalVersion = await this.runProbe(kind, finalExecutable, signal);
			if (!finalVersion || !versionMatches(artifact.version, finalVersion)) {
				throw new DependencyInstallError(
					"VERSION_MISMATCH",
					`activation-probe-failed path=${finalExecutable}`,
				);
			}
			this.log?.("info", "dependency.instalada", {
				kind,
				executablePath: finalExecutable,
				version: finalVersion,
			});
			return { kind, executablePath: finalExecutable, version: finalVersion };
		} catch (error) {
			// Só remove o que esta execução promoveu; instalação anterior nunca
			// chega até aqui (o destino existente é tratado no passo 1).
			if (promoted) await rm(managedDir, { recursive: true, force: true }).catch(() => undefined);
			throw normalizeError(error, signal);
		} finally {
			process.removeListener("exit", exitCleanup);
			await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async activate(extractDir: string, managedDir: string): Promise<void> {
		try {
			await rename(extractDir, managedDir);
		} catch (error) {
			const code = errorCodeOf(error);
			if (await exists(managedDir)) {
				throw new DependencyInstallError(
					"EXISTING_INCOMPATIBLE",
					`destination-exists path=${managedDir}`,
				);
			}
			throw new DependencyInstallError(
				"WRITE",
				`activate-failed path=${managedDir} code=${code ?? "unknown"}`,
			);
		}
	}

	private async resolveNodeArtifact(signal: AbortSignal): Promise<DependencyArtifact> {
		const arch = nodeArch(this.arch, this.platform);
		const index = parseNodeIndex(await this.fetchJson(NODE_LTS_INDEX_URL, signal));
		const linux = this.platform === "linux";
		const fileTag = linux ? `linux-${arch}` : `win-${arch}-zip`;
		const entry = index.find(
			(candidate) =>
				typeof candidate.lts === "string" &&
				candidate.lts.length > 0 &&
				candidate.files.includes(fileTag),
		);
		if (!entry) {
			throw new DependencyInstallError(
				"UNSUPPORTED_ARCH",
				`no-lts-${linux ? "tar" : "zip"} arch=${arch}`,
			);
		}
		const version = entry.version.replace(/^v/, "");
		const fileName = linux
			? `node-v${version}-linux-${arch}.tar.gz`
			: `node-v${version}-win-${arch}.zip`;
		const shasumsUrl = `${NODE_LTS_DIST_BASE_URL}/${entry.version}/SHASUMS256.txt`;
		const shasums = await this.fetchText(shasumsUrl, signal);
		const sha256 = parseShasums(shasums, fileName);
		if (!sha256) {
			throw new DependencyInstallError("CHECKSUM", `missing-shasum file=${fileName}`);
		}
		return {
			kind: "node",
			version,
			url: `${NODE_LTS_DIST_BASE_URL}/${entry.version}/${fileName}`,
			sha256,
			fileName,
			maxDownloadBytes: NODE_MAX_DOWNLOAD_BYTES,
			stripTopLevelDir: true,
			archiveFormat: linux ? "tar.gz" : "zip",
			executablePath: linux ? "bin/node" : "node.exe",
			requiredPaths: linux
				? [
						"bin/npm",
						"bin/npx",
						"lib/node_modules/npm/bin/npm-cli.js",
						"lib/node_modules/npm/bin/npx-cli.js",
					]
				: ["npm.cmd", "node_modules/npm/bin/npm-cli.js"],
		};
	}

	private async fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
		const text = await this.fetchText(url, signal);
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new DependencyInstallError("NETWORK", `invalid-json url=${url}`);
		}
	}

	private async fetchText(url: string, signal: AbortSignal): Promise<string> {
		const deadline = withTimeout(signal, API_TIMEOUT_MS);
		try {
			const response = await this.fetchWithRedirects(
				url,
				{ signal: deadline.signal, headers: { accept: "application/json, text/plain" } },
				deadline.signal,
			);
			if (!response.ok) {
				throw new DependencyInstallError("HTTP_STATUS", `http-status=${response.status} url=${url}`);
			}
			return await response.text();
		} catch (error) {
			if (error instanceof DependencyInstallError) throw error;
			if (deadline.didTimeout()) throw new DependencyInstallError("NETWORK", `timeout url=${url}`);
			if (signal.aborted) throw new DependencyInstallError("ABORTED", "aborted");
			throw new DependencyInstallError("NETWORK", `request-failed url=${url} ${messageOf(error)}`);
		} finally {
			deadline.dispose();
		}
	}

	private async fetchWithRedirects(
		rawUrl: string,
		init: RequestInit,
		signal: AbortSignal,
	): Promise<Response> {
		let current = assertOfficialDependencyUrl(rawUrl);
		for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
			assertNotAborted(signal);
			const response = await this.fetchImpl(current.toString(), {
				...init,
				redirect: "manual",
				signal,
			});
			if (response.status >= 300 && response.status <= 399) {
				const location = response.headers.get("location");
				if (!location) {
					throw new DependencyInstallError(
						"NETWORK",
						`redirect-without-location host=${current.hostname}`,
					);
				}
				current = assertOfficialDependencyUrl(new URL(location, current));
				continue;
			}
			return response;
		}
		throw new DependencyInstallError("NETWORK", "too-many-redirects");
	}

	private async download(
		artifact: DependencyArtifact,
		destination: string,
		onProgress: ((progress: DependencyInstallProgress) => void) | undefined,
		signal: AbortSignal,
	): Promise<void> {
		const deadline = withTimeout(signal, DOWNLOAD_TIMEOUT_MS);
		let handle: FileHandle | undefined;
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await this.fetchWithRedirects(
				artifact.url,
				{
					signal: deadline.signal,
					headers: {
						accept:
							artifact.archiveFormat === "tar.gz"
								? "application/gzip, application/octet-stream"
								: "application/zip, application/octet-stream",
					},
				},
				deadline.signal,
			);
			if (!response.ok || !response.body) {
				throw new DependencyInstallError(
					"HTTP_STATUS",
					`http-status=${response.status} url=${artifact.url}`,
				);
			}
			const total = parseContentLength(response.headers.get("content-length"));
			if (total !== undefined && total > artifact.maxDownloadBytes) {
				throw new DependencyInstallError(
					"SIZE_LIMIT",
					`content-length-too-large expected=${total} limit=${artifact.maxDownloadBytes}`,
				);
			}
			handle = await open(destination, "wx", 0o600);
			const hash = createHash("sha256");
			let received = 0;
			reader = response.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				if (deadline.signal.aborted) throw abortReason(deadline);
				received += value.byteLength;
				if (received > artifact.maxDownloadBytes) {
					throw new DependencyInstallError(
						"SIZE_LIMIT",
						`download-too-large received=${received} limit=${artifact.maxDownloadBytes}`,
					);
				}
				const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
				hash.update(bytes);
				await writeAll(handle, bytes, destination);
				onProgress?.({
					phase: "downloading",
					receivedBytes: received,
					totalBytes: total,
				});
			}
			await handle.close();
			handle = undefined;
			if (total !== undefined && received !== total) {
				throw new DependencyInstallError(
					"CHECKSUM",
					`size-mismatch expected=${total} received=${received}`,
				);
			}
			const actual = hash.digest("hex").toLowerCase();
			if (actual !== artifact.sha256) {
				throw new DependencyInstallError(
					"CHECKSUM",
					`checksum-mismatch expected=${artifact.sha256} actual=${actual}`,
				);
			}
		} catch (error) {
			if (error instanceof DependencyInstallError) throw error;
			if (deadline.didTimeout()) throw new DependencyInstallError("NETWORK", "download-timeout");
			if (signal.aborted) throw new DependencyInstallError("ABORTED", "aborted");
			throw new DependencyInstallError("NETWORK", `download-failed ${messageOf(error)}`);
		} finally {
			await reader?.cancel().catch(() => undefined);
			if (handle) await handle.close().catch(() => undefined);
			deadline.dispose();
		}
	}
}

// ---------------------------------------------------------------------------
// Metadados oficiais fixados
// ---------------------------------------------------------------------------

function gitArch(arch: string): "x64" | "arm64" | "ia32" {
	if (arch === "x64") return "x64";
	if (arch === "arm64") return "arm64";
	if (arch === "ia32") return "ia32";
	throw new DependencyInstallError("UNSUPPORTED_ARCH", `unsupported-arch=${arch}`);
}

function nodeArch(arch: string, platform: NodeJS.Platform): "x64" | "arm64" {
	if (platform === "linux") {
		// Escopo desta entrega: Linux x86_64. ARM fica de fora por decisão do
		// projeto, mesmo que o nodejs.org publique linux-arm64.
		if (arch === "x64") return "x64";
		throw new DependencyInstallError("UNSUPPORTED_ARCH", `unsupported-arch=${arch}`);
	}
	if (arch === "x64") return "x64";
	if (arch === "arm64") return "arm64";
	throw new DependencyInstallError("UNSUPPORTED_ARCH", `unsupported-arch=${arch}`);
}

function gitArtifact(arch: string): DependencyArtifact {
	const target = gitArch(arch);
	const suffix = target === "x64" ? "64-bit" : target === "arm64" ? "arm64" : "32-bit";
	const fileName = `MinGit-${GIT_WINDOWS_VERSION}-${suffix}.zip`;
	return {
		kind: "git",
		version: GIT_WINDOWS_VERSION,
		url: `${GIT_WINDOWS_MINIGIT_BASE_URL}/${fileName}`,
		sha256: GIT_WINDOWS_MINIGIT_SHA256[target],
		fileName,
		maxDownloadBytes: GIT_MAX_DOWNLOAD_BYTES,
		stripTopLevelDir: false,
		executablePath: "cmd/git.exe",
		requiredPaths: [],
	};
}
