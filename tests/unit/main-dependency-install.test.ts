import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	access,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
	DependencyInstallError,
	GIT_WINDOWS_MINIGIT_SHA256,
	GIT_WINDOWS_VERSION,
	NODE_LTS_INDEX_URL,
	OptionalDependencyInstaller,
	assertOfficialDependencyUrl,
	optionalDependencyBinDirs,
	resolveDependencyToolsRoot,
	type DependencyArtifact,
	type DependencyArtifactResolver,
	type DependencyFetch,
	type DependencyProbeRunner,
	type OptionalDependencyInstallerOptions,
} from "../../src/main/dependency-install";
import type {
	DependencyInstallProgress,
	DependencyKind,
} from "../../src/shared/dependency-install-types";

// ---------------------------------------------------------------------------
// Fixtures ZIP (sem dependências externas)
// ---------------------------------------------------------------------------

interface ZipEntrySpec {
	name: string;
	data?: Uint8Array;
	method?: 0 | 8;
	mode?: number;
	directory?: boolean;
	crcOverride?: number;
	declaredSize?: number;
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let index = 0; index < data.length; index += 1) {
		crc ^= data[index];
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function buildZip(specs: ZipEntrySpec[]): Uint8Array {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	for (const spec of specs) {
		const data = spec.data ?? new Uint8Array(0);
		const method = spec.method ?? (data.length > 0 ? 8 : 0);
		const compressed = method === 8 ? deflateRawSync(data) : Buffer.from(data);
		const name = Buffer.from(spec.name, "utf8");
		const crc = spec.crcOverride ?? crc32(data);
		const uncompressedSize = spec.declaredSize ?? data.length;
		const flags = 0x0800;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(uncompressedSize, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		localParts.push(local, name, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE((3 << 8) | 20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(flags, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(uncompressedSize, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		const mode = spec.directory
			? ((0o40755 << 16) | 0x10) >>> 0
			: ((spec.mode ?? 0o100644) << 16) >>> 0;
		central.writeUInt32LE(mode, 38);
		central.writeUInt32LE(offset, 42);
		centralParts.push(central, name);
		offset += local.length + name.length + compressed.length;
	}
	const centralBuffer = Buffer.concat(centralParts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(specs.length, 8);
	eocd.writeUInt16LE(specs.length, 10);
	eocd.writeUInt32LE(centralBuffer.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);
	return new Uint8Array(Buffer.concat([...localParts, centralBuffer, eocd]));
}

function gitZip(): Uint8Array {
	return buildZip([
		{ name: "cmd/git.exe", data: utf8("fake git") },
		{ name: "mingw64/bin/git.exe", data: utf8("fake git real") },
	]);
}

function nodeZip(version = "26.13.0"): Uint8Array {
	const root = `node-v${version}-win-x64`;
	return buildZip([
		{ name: `${root}/`, directory: true },
		{ name: `${root}/node.exe`, data: utf8("fake node") },
		{ name: `${root}/npm.cmd`, data: utf8("fake npm") },
		{ name: `${root}/npx.cmd`, data: utf8("fake npx") },
		{ name: `${root}/node_modules/npm/bin/npm-cli.js`, data: utf8("fake npm cli") },
	]);
}

interface TarEntrySpec {
	name: string;
	data?: Uint8Array;
	mode?: number;
	type?: string;
	linkName?: string;
	declaredSize?: number;
	badChecksum?: boolean;
}

function tarHeader(spec: TarEntrySpec): Buffer {
	const name = Buffer.from(spec.name, "utf8");
	if (name.length > 100) throw new Error(`tar fixture name too long: ${spec.name}`);
	const link = Buffer.from(spec.linkName ?? "", "utf8");
	if (link.length > 100) throw new Error(`tar fixture link too long: ${spec.linkName}`);
	const data = spec.data ?? new Uint8Array(0);
	const size = spec.declaredSize ?? (spec.type === "5" || spec.type === "2" || spec.type === "1" ? 0 : data.length);
	const header = Buffer.alloc(512);
	name.copy(header, 0);
	// Diretórios precisam de x para criar os filhos; o TAR oficial do Node usa
	// 0755. Sem isso o fixture 0644 falharia com EACCES no filho.
	const mode = spec.mode ?? (spec.type === "5" ? 0o755 : 0o644);
	header.write(mode.toString(8).padStart(7, "0") + "\0", 100, "ascii");
	header.write("0000000\0", 108, "ascii");
	header.write("0000000\0", 116, "ascii");
	header.write(size.toString(8).padStart(11, "0") + "\0", 124, "ascii");
	header.write("00000000000\0", 136, "ascii");
	header.fill(0x20, 148, 156);
	header.write(spec.type ?? "0", 156, "ascii");
	link.copy(header, 157);
	header.write("ustar\0", 257, "ascii");
	header.write("00", 263, "ascii");
	header.write("root", 265, "ascii");
	header.write("root", 297, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(
		spec.badChecksum ? "000000\0 " : checksum.toString(8).padStart(6, "0") + "\0 ",
		148,
		"ascii",
	);
	return header;
}

function buildTarGz(specs: TarEntrySpec[]): Uint8Array {
	const parts: Buffer[] = [];
	for (const spec of specs) {
		parts.push(tarHeader(spec));
		const data = spec.data ?? new Uint8Array(0);
		if (data.length > 0) {
			parts.push(Buffer.from(data));
			const padding = (512 - (data.length % 512)) % 512;
			if (padding > 0) parts.push(Buffer.alloc(padding));
		}
	}
	parts.push(Buffer.alloc(1024));
	return new Uint8Array(gzipSync(Buffer.concat(parts)));
}

function linuxNodeTarGz(version = "26.13.0"): Uint8Array {
	const root = `node-v${version}-linux-x64`;
	return buildTarGz([
		{ name: `${root}/`, type: "5", mode: 0o755 },
		{ name: `${root}/bin/`, type: "5", mode: 0o755 },
		{ name: `${root}/bin/node`, data: utf8("fake node"), mode: 0o755 },
		{
			name: `${root}/bin/npm`,
			type: "2",
			linkName: "../lib/node_modules/npm/bin/npm-cli.js",
		},
		{
			name: `${root}/bin/npx`,
			type: "2",
			linkName: "../lib/node_modules/npm/bin/npx-cli.js",
		},
		{ name: `${root}/lib/`, type: "5" },
		{ name: `${root}/lib/node_modules/`, type: "5" },
		{ name: `${root}/lib/node_modules/npm/`, type: "5" },
		{ name: `${root}/lib/node_modules/npm/bin/`, type: "5" },
		{
			name: `${root}/lib/node_modules/npm/bin/npm-cli.js`,
			data: utf8("fake npm cli"),
			mode: 0o755,
		},
		{
			name: `${root}/lib/node_modules/npm/bin/npx-cli.js`,
			data: utf8("fake npx cli"),
			mode: 0o755,
		},
	]);
}

// ---------------------------------------------------------------------------
// Helpers de rede e ambiente
// ---------------------------------------------------------------------------

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function bytesResponse(bytes: Uint8Array): Response {
	const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	return new Response(body, {
		status: 200,
		headers: { "content-length": String(bytes.byteLength) },
	});
}

interface FetchPlan {
	bodies?: Map<string, Uint8Array>;
	json?: Map<string, unknown>;
	text?: Map<string, string>;
	override?(url: string, init: RequestInit): Response | undefined | Promise<Response | undefined>;
	/** Barreira determinística: o teste libera quando quiser. */
	gate?: Promise<void>;
}

function fakeFetch(plan: FetchPlan): { fetchImpl: DependencyFetch; calls: string[] } {
	const calls: string[] = [];
	const fetchImpl: DependencyFetch = async (url, init) => {
		calls.push(url);
		const custom = await plan.override?.(url, init);
		if (custom) return custom;
		if (plan.gate) await plan.gate;
		const json = plan.json?.get(url);
		if (json !== undefined) {
			return new Response(JSON.stringify(json), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		const text = plan.text?.get(url);
		if (text !== undefined) return new Response(text, { status: 200 });
		const body = plan.bodies?.get(url);
		if (body) return bytesResponse(body);
		return new Response("not found", { status: 404 });
	};
	return { fetchImpl, calls };
}

async function tempRoot(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "omp-deps-"));
}

function envFor(root: string, pathValue = ""): NodeJS.ProcessEnv {
	return {
		LOCALAPPDATA: path.join(root, "AppData", "Local"),
		USERPROFILE: path.join(root, "home"),
		HOME: path.join(root, "home"),
		PATH: pathValue,
	};
}

function toolsRoot(root: string): string {
	return path.join(root, "AppData", "Local", "omp-desktop", "tools");
}

function linuxEnv(root: string, pathValue = ""): NodeJS.ProcessEnv {
	return {
		HOME: path.join(root, "home"),
		XDG_DATA_HOME: path.join(root, "xdg"),
		PATH: pathValue,
	};
}

function linuxToolsRoot(root: string): string {
	return path.join(root, "xdg", "omp-desktop", "tools");
}

function makeLinuxInstaller(
	root: string,
	options: OptionalDependencyInstallerOptions = {},
): OptionalDependencyInstaller {
	return new OptionalDependencyInstaller({
		env: linuxEnv(root),
		platform: "linux",
		arch: "x64",
		...options,
	});
}

function linuxNodeArtifact(
	tar: Uint8Array,
	overrides: Partial<DependencyArtifact> = {},
): DependencyArtifact {
	return {
		kind: "node",
		version: "26.13.0",
		url: "https://nodejs.org/dist/v26.13.0/node-v26.13.0-linux-x64.tar.gz",
		sha256: sha256(tar),
		fileName: "node-v26.13.0-linux-x64.tar.gz",
		maxDownloadBytes: 16 * 1024 * 1024,
		stripTopLevelDir: true,
		archiveFormat: "tar.gz",
		executablePath: "bin/node",
		requiredPaths: [
			"bin/npm",
			"bin/npx",
			"lib/node_modules/npm/bin/npm-cli.js",
			"lib/node_modules/npm/bin/npx-cli.js",
		],
		...overrides,
	};
}

function makeInstaller(
	root: string,
	options: OptionalDependencyInstallerOptions = {},
): OptionalDependencyInstaller {
	return new OptionalDependencyInstaller({
		env: envFor(root),
		platform: "win32",
		arch: "x64",
		...options,
	});
}

function testArtifact(
	kind: DependencyKind,
	zip: Uint8Array,
	overrides: Partial<DependencyArtifact> = {},
): DependencyArtifact {
	const fileName = kind === "git" ? "MinGit-test.zip" : "node-test.zip";
	return {
		kind,
		version: kind === "git" ? GIT_WINDOWS_VERSION : "26.13.0",
		url:
			kind === "git"
				? `https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/${fileName}`
				: `https://nodejs.org/dist/v26.13.0/${fileName}`,
		sha256: sha256(zip),
		fileName,
		maxDownloadBytes: 16 * 1024 * 1024,
		stripTopLevelDir: kind === "node",
		executablePath: kind === "git" ? "cmd/git.exe" : "node.exe",
		requiredPaths:
			kind === "node" ? ["npm.cmd", "node_modules/npm/bin/npm-cli.js"] : [],
		...overrides,
	};
}

function resolverFor(
	kind: DependencyKind,
	zip: Uint8Array,
	overrides: Partial<DependencyArtifact> = {},
): DependencyArtifactResolver {
	return () => testArtifact(kind, zip, overrides);
}

function probeVersions(
	versions: Partial<Record<DependencyKind, string | undefined>>,
): DependencyProbeRunner {
	return async (kind) => versions[kind];
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

function nodeIndex(version = "26.13.0", tag = "win-x64-zip"): unknown {
	return [
		{ version: "v27.0.0", files: [tag], lts: false },
		{ version: `v${version}`, files: [tag], lts: "Lithium" },
	];
}

function shasums(fileName: string, bytes: Uint8Array): string {
	return `${sha256(bytes)}  ${fileName}\n`;
}

// ---------------------------------------------------------------------------
// Caminhos e URLs
// ---------------------------------------------------------------------------

describe("caminhos gerenciados", () => {
	test("resolve raiz por usuário e diretórios de PATH no Windows", () => {
		const localAppData = "C:\\Users\\teste\\AppData\\Local";
		expect(resolveDependencyToolsRoot({ LOCALAPPDATA: localAppData }, "win32")).toBe(
			path.join(path.resolve(localAppData), "omp-desktop", "tools"),
		);
		expect(resolveDependencyToolsRoot({ USERPROFILE: "C:\\Users\\teste" }, "win32")).toBe(
			path.join(
				path.resolve("C:\\Users\\teste"),
				"AppData",
				"Local",
				"omp-desktop",
				"tools",
			),
		);
		expect(() => resolveDependencyToolsRoot({}, "win32")).toThrow(DependencyInstallError);
		expect(optionalDependencyBinDirs({ LOCALAPPDATA: localAppData }, "win32")).toEqual([
			path.join(path.resolve(localAppData), "omp-desktop", "tools", "git", "cmd"),
			path.join(path.resolve(localAppData), "omp-desktop", "tools", "node"),
		]);
		expect(optionalDependencyBinDirs({}, "win32")).toEqual([]);
	});

	test("Linux usa XDG_DATA_HOME absoluto ou $HOME/.local/share e só node/bin no PATH", () => {
		const root = path.join(tmpdir(), "omp-linux-home");
		const xdg = path.join(root, "xdg");
		expect(resolveDependencyToolsRoot({ XDG_DATA_HOME: xdg, HOME: root }, "linux")).toBe(
			path.join(xdg, "omp-desktop", "tools"),
		);
		expect(resolveDependencyToolsRoot({ HOME: root }, "linux")).toBe(
			path.join(root, ".local", "share", "omp-desktop", "tools"),
		);
		// XDG relativo é ignorado; cai no HOME.
		expect(
			resolveDependencyToolsRoot({ XDG_DATA_HOME: "relative", HOME: root }, "linux"),
		).toBe(path.join(root, ".local", "share", "omp-desktop", "tools"));
		expect(() => resolveDependencyToolsRoot({}, "linux")).toThrow(DependencyInstallError);
		expect(optionalDependencyBinDirs({ XDG_DATA_HOME: xdg }, "linux")).toEqual([
			path.join(xdg, "omp-desktop", "tools", "node", "bin"),
		]);
		expect(optionalDependencyBinDirs({}, "linux")).toEqual([]);
	});
});

describe("URLs oficiais", () => {
	test("aceita Git for Windows, nodejs.org e redirects oficiais do GitHub", () => {
		expect(
			assertOfficialDependencyUrl(
				"https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/MinGit-2.56.0.4-64-bit.zip",
			).hostname,
		).toBe("github.com");
		expect(
			assertOfficialDependencyUrl("https://nodejs.org/dist/v26.13.0/node-v26.13.0-win-x64.zip")
				.hostname,
		).toBe("nodejs.org");
		expect(
			assertOfficialDependencyUrl(
				"https://release-assets.githubusercontent.com/github-production-release-asset/1/2?token=x",
			).hostname,
		).toBe("release-assets.githubusercontent.com");
	});

	test("rejeita http, credenciais, porta alternativa, host e caminho desconhecidos", () => {
		for (const url of [
			"http://nodejs.org/dist/v26.13.0/node-v26.13.0-win-x64.zip",
			"https://user:pass@nodejs.org/dist/v26.13.0/node-v26.13.0-win-x64.zip",
			"https://evil.example/node-v26.13.0-win-x64.zip",
			"https://github.com/other/repo/releases/download/v1/x.zip",
			"https://nodejs.org/other/x.zip",
			"https://nodejs.org:8443/dist/x.zip",
		]) {
			expect(() => assertOfficialDependencyUrl(url)).toThrow(DependencyInstallError);
		}
	});
});

// ---------------------------------------------------------------------------
// Sondagem
// ---------------------------------------------------------------------------

describe("sondagem local", () => {
	test("missing sem rede e sem escrever", async () => {
		const root = await tempRoot();
		try {
			const { fetchImpl, calls } = fakeFetch({});
			const installer = makeInstaller(root, { fetchImpl, probeRunner: async () => undefined });
			await expect(installer.probe("git")).resolves.toEqual({ state: "missing", kind: "git" });
			expect(calls).toEqual([]);
			expect(await exists(toolsRoot(root))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("adota instalação gerenciada e detecta instalação incompleta", async () => {
		const root = await tempRoot();
		try {
			const managed = path.join(toolsRoot(root), "git", "cmd");
			await mkdir(managed, { recursive: true });
			await writeFile(path.join(managed, "git.exe"), "existing");
			const installer = makeInstaller(root, { probeRunner: probeVersions({ git: "2.56.0" }) });
			await expect(installer.probe("git")).resolves.toEqual({
				state: "installed",
				kind: "git",
				executablePath: path.join(managed, "git.exe"),
				version: "2.56.0",
			});

			const incompleteRoot = await tempRoot();
			try {
				await mkdir(path.join(toolsRoot(incompleteRoot), "git"), { recursive: true });
				const incomplete = makeInstaller(incompleteRoot, {
					probeRunner: probeVersions({ git: "2.56.0" }),
				});
				await expect(incomplete.probe("git")).resolves.toMatchObject({
					state: "error",
					code: "INCOMPLETE_INSTALL",
				});
			} finally {
				await rm(incompleteRoot, { recursive: true, force: true });
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("adota executável do PATH e reporta falha de versão", async () => {
		const root = await tempRoot();
		try {
			const bin = path.join(root, "bin");
			await mkdir(bin, { recursive: true });
			await writeFile(path.join(bin, "git.exe"), "global");
			const installer = makeInstaller(root, {
				env: envFor(root, bin),
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			await expect(installer.probe("git")).resolves.toMatchObject({
				state: "installed",
				executablePath: path.join(bin, "git.exe"),
			});

			const broken = makeInstaller(root, {
				env: envFor(root, bin),
				probeRunner: async () => undefined,
			});
			await expect(broken.probe("git")).resolves.toMatchObject({
				state: "error",
				code: "PROBE_FAILED",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("lookup ignora o CWD e usa somente PATH", async () => {
		const root = await tempRoot();
		const originalCwd = process.cwd();
		try {
			const cwdDir = path.join(root, "cwd");
			const binDir = path.join(root, "bin");
			await mkdir(cwdDir, { recursive: true });
			await mkdir(binDir, { recursive: true });
			await writeFile(path.join(cwdDir, "git.exe"), "cwd-decoy");
			await writeFile(path.join(binDir, "git.exe"), "path-legit");
			process.chdir(cwdDir);

			const seen: string[] = [];
			const installer = makeInstaller(root, {
				env: envFor(root, binDir),
				probeRunner: async (_kind, executable) => {
					seen.push(executable);
					return "2.56.0";
				},
			});
			await expect(installer.probe("git")).resolves.toEqual({
				state: "installed",
				kind: "git",
				executablePath: path.join(binDir, "git.exe"),
				version: "2.56.0",
			});
			expect(seen).toEqual([path.join(binDir, "git.exe")]);

			// PATH vazio + git.exe no CWD: o CWD nunca é consultado.
			const emptyPath = makeInstaller(root, {
				env: envFor(root, ""),
				probeRunner: async () => {
					throw new Error("probeRunner não deveria rodar sem PATH");
				},
			});
			await expect(emptyPath.probe("git")).resolves.toEqual({ state: "missing", kind: "git" });

			// PATH com entrada relativa (.) também não resolve contra o CWD.
			const relativePath = makeInstaller(root, {
				env: envFor(root, "."),
				probeRunner: async () => {
					throw new Error("probeRunner não deveria rodar com PATH relativo");
				},
			});
			await expect(relativePath.probe("git")).resolves.toEqual({ state: "missing", kind: "git" });
		} finally {
			process.chdir(originalCwd);
			await rm(root, { recursive: true, force: true });
		}
	});

	test("plataforma fora de Windows/Linux é recusada", async () => {
		const root = await tempRoot();
		try {
			const installer = makeInstaller(root, { platform: "darwin" });
			await expect(installer.probe("git")).resolves.toMatchObject({
				state: "error",
				code: "UNSUPPORTED_PLATFORM",
			});
			await expect(installer.install("git")).rejects.toMatchObject({
				code: "UNSUPPORTED_PLATFORM",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Instalação Git
// ---------------------------------------------------------------------------

describe("instalação do Git", () => {
	test("baixa, confere SHA-256, extrai cmd/git.exe e ativa", async () => {
		const root = await tempRoot();
		try {
			const zip = gitZip();
			const artifact = testArtifact("git", zip);
			const { fetchImpl, calls } = fakeFetch({ bodies: new Map([[artifact.url, zip]]) });
			const progress: DependencyInstallProgress[] = [];
			const installer = makeInstaller(root, {
				fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			const result = await installer.install("git", {
				onProgress: (entry) => progress.push(entry),
			});
			const executable = path.join(toolsRoot(root), "git", "cmd", "git.exe");
			expect(result).toEqual({ kind: "git", executablePath: executable, version: "2.56.0" });
			expect(await readFile(executable, "utf8")).toBe("fake git");
			expect(progress.map((entry) => entry.phase)).toContain("downloading");
			expect(progress.map((entry) => entry.phase)).toContain("extracting");
			expect(progress.map((entry) => entry.phase)).toContain("activating");
			expect(calls).toEqual([artifact.url]);
			const names = await readdir(toolsRoot(root));
			expect(names).toContain("git");
			expect(names.some((name) => name.startsWith(".tmp-"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("não sobrescreve instalação existente criada durante o download", async () => {
		const root = await tempRoot();
		try {
			const zip = gitZip();
			const artifact = testArtifact("git", zip);
			const managed = path.join(toolsRoot(root), "git");
			const { fetchImpl } = fakeFetch({
				override: async (url) => {
					if (url !== artifact.url) return undefined;
					await mkdir(managed, { recursive: true });
					await writeFile(path.join(managed, "sentinel.txt"), "keep");
					return bytesResponse(zip);
				},
			});
			const installer = makeInstaller(root, {
				fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			await expect(installer.install("git")).rejects.toMatchObject({
				code: "EXISTING_INCOMPATIBLE",
			});
			expect(await readFile(path.join(managed, "sentinel.txt"), "utf8")).toBe("keep");
			expect(await exists(path.join(managed, "cmd", "git.exe"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("adota instalação gerenciada compatível sem baixar", async () => {
		const root = await tempRoot();
		try {
			const executable = path.join(toolsRoot(root), "git", "cmd", "git.exe");
			await mkdir(path.dirname(executable), { recursive: true });
			await writeFile(executable, "existing");
			const { fetchImpl, calls } = fakeFetch({});
			const installer = makeInstaller(root, {
				fetchImpl,
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			await expect(installer.install("git")).resolves.toEqual({
				kind: "git",
				executablePath: executable,
				version: "2.56.0",
			});
			expect(calls).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("adota Git global do PATH sem alterar o arquivo", async () => {
		const root = await tempRoot();
		try {
			const bin = path.join(root, "bin");
			await mkdir(bin, { recursive: true });
			const executable = path.join(bin, "git.exe");
			await writeFile(executable, "global");
			const { fetchImpl, calls } = fakeFetch({});
			const installer = makeInstaller(root, {
				env: envFor(root, bin),
				fetchImpl,
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			await expect(installer.install("git")).resolves.toEqual({
				kind: "git",
				executablePath: executable,
				version: "2.56.0",
			});
			expect(calls).toEqual([]);
			expect(await readFile(executable, "utf8")).toBe("global");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("instalação gerenciada incompatível não é sobrescrita", async () => {
		const root = await tempRoot();
		try {
			await mkdir(path.join(toolsRoot(root), "git"), { recursive: true });
			const { fetchImpl, calls } = fakeFetch({});
			const installer = makeInstaller(root, { fetchImpl });
			await expect(installer.install("git")).rejects.toMatchObject({
				code: "INCOMPLETE_INSTALL",
			});
			expect(calls).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Instalação Node
// ---------------------------------------------------------------------------

describe("instalação do Node.js LTS", () => {
	test("resolve LTS no index oficial, confere SHASUMS e remove a pasta raiz", async () => {
		const root = await tempRoot();
		try {
			const zip = nodeZip("26.13.0");
			const artifactUrl = "https://nodejs.org/dist/v26.13.0/node-v26.13.0-win-x64.zip";
			const shasumsUrl = "https://nodejs.org/dist/v26.13.0/SHASUMS256.txt";
			const { fetchImpl, calls } = fakeFetch({
				json: new Map([[NODE_LTS_INDEX_URL, nodeIndex("26.13.0")]]),
				text: new Map([[shasumsUrl, shasums("node-v26.13.0-win-x64.zip", zip)]]),
				bodies: new Map([[artifactUrl, zip]]),
			});
			const installer = makeInstaller(root, {
				fetchImpl,
				probeRunner: probeVersions({ node: "26.13.0" }),
			});
			const result = await installer.install("node");
			const nodeRoot = path.join(toolsRoot(root), "node");
			expect(result).toEqual({
				kind: "node",
				executablePath: path.join(nodeRoot, "node.exe"),
				version: "26.13.0",
			});
			expect(await readFile(path.join(nodeRoot, "node.exe"), "utf8")).toBe("fake node");
			expect(await readFile(path.join(nodeRoot, "npm.cmd"), "utf8")).toBe("fake npm");
			expect(
				await readFile(path.join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js"), "utf8"),
			).toBe("fake npm cli");
			expect(await exists(path.join(nodeRoot, "node-v26.13.0-win-x64"))).toBe(false);
			expect(calls).toEqual([NODE_LTS_INDEX_URL, shasumsUrl, artifactUrl]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("escolhe a LTS mais recente que publica ZIP para a arquitetura", async () => {
		const root = await tempRoot();
		try {
			const zip = nodeZip("25.0.0");
			const index = [
				{ version: "v27.0.0", files: ["win-x64-zip"], lts: false },
				{ version: "v26.0.0", files: ["osx-x64-tar"], lts: "Lithium" },
				{ version: "v25.0.0", files: ["win-x64-zip"], lts: "Jod" },
			];
			const artifactUrl = "https://nodejs.org/dist/v25.0.0/node-v25.0.0-win-x64.zip";
			const shasumsUrl = "https://nodejs.org/dist/v25.0.0/SHASUMS256.txt";
			const { fetchImpl } = fakeFetch({
				json: new Map([[NODE_LTS_INDEX_URL, index]]),
				text: new Map([[shasumsUrl, shasums("node-v25.0.0-win-x64.zip", zip)]]),
				bodies: new Map([[artifactUrl, zip]]),
			});
			const installer = makeInstaller(root, {
				fetchImpl,
				probeRunner: probeVersions({ node: "25.0.0" }),
			});
			await expect(installer.install("node")).resolves.toMatchObject({ version: "25.0.0" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("recusa arquitetura sem ZIP oficial e LTS ausente", async () => {
		const root = await tempRoot();
		try {
			const ia32 = makeInstaller(root, { arch: "ia32" });
			await expect(ia32.install("node")).rejects.toMatchObject({ code: "UNSUPPORTED_ARCH" });

			const noZip = makeInstaller(root, {
				fetchImpl: fakeFetch({
					json: new Map([
						[
							NODE_LTS_INDEX_URL,
							[{ version: "v26.13.0", files: ["osx-x64-tar"], lts: "Lithium" }],
						],
					]),
				}).fetchImpl,
			});
			await expect(noZip.install("node")).rejects.toMatchObject({ code: "UNSUPPORTED_ARCH" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("SHASUMS ausente ou divergente não ativa nada", async () => {
		const root = await tempRoot();
		try {
			const zip = nodeZip("26.13.0");
			const shasumsUrl = "https://nodejs.org/dist/v26.13.0/SHASUMS256.txt";
			const artifactUrl = "https://nodejs.org/dist/v26.13.0/node-v26.13.0-win-x64.zip";
			const missing = makeInstaller(root, {
				fetchImpl: fakeFetch({
					json: new Map([[NODE_LTS_INDEX_URL, nodeIndex("26.13.0")]]),
					text: new Map([[shasumsUrl, ""]]),
					bodies: new Map([[artifactUrl, zip]]),
				}).fetchImpl,
			});
			await expect(missing.install("node")).rejects.toMatchObject({ code: "CHECKSUM" });
			expect(await exists(path.join(toolsRoot(root), "node"))).toBe(false);

			const wrong = makeInstaller(root, {
				fetchImpl: fakeFetch({
					json: new Map([[NODE_LTS_INDEX_URL, nodeIndex("26.13.0")]]),
					text: new Map([
						[shasumsUrl, `${"0".repeat(64)}  node-v26.13.0-win-x64.zip\n`],
					]),
					bodies: new Map([[artifactUrl, zip]]),
				}).fetchImpl,
			});
			await expect(wrong.install("node")).rejects.toMatchObject({ code: "CHECKSUM" });
			expect(await exists(path.join(toolsRoot(root), "node"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("ZIP sem npm oficial é recusado", async () => {
		const root = await tempRoot();
		try {
			const zip = buildZip([
				{ name: "node-v26.13.0-win-x64/node.exe", data: utf8("fake node") },
			]);
			const artifact = testArtifact("node", zip);
			const { fetchImpl } = fakeFetch({ bodies: new Map([[artifact.url, zip]]) });
			const installer = makeInstaller(root, {
				fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ node: "26.13.0" }),
			});
			await expect(installer.install("node")).rejects.toMatchObject({
				code: "ARCHIVE_INVALID",
			});
			expect(await exists(path.join(toolsRoot(root), "node"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Linux: Git nativo e Node TAR.GZ
// ---------------------------------------------------------------------------

describe("Linux: Git nativo", () => {
	test("probe usa somente PATH absoluto e não baixa nada", async () => {
		const root = await tempRoot();
		try {
			const bin = path.join(root, "bin");
			await mkdir(bin, { recursive: true });
			await writeFile(path.join(bin, "git"), "global");
			const { fetchImpl, calls } = fakeFetch({});
			const installer = makeLinuxInstaller(root, {
				env: linuxEnv(root, bin),
				fetchImpl,
				probeRunner: probeVersions({ git: "2.43.0" }),
			});
			await expect(installer.probe("git")).resolves.toEqual({
				state: "installed",
				kind: "git",
				executablePath: path.join(bin, "git"),
				version: "2.43.0",
			});
			expect(calls).toEqual([]);

			const missing = makeLinuxInstaller(root, {
				env: linuxEnv(root, ""),
				fetchImpl,
				probeRunner: async () => undefined,
			});
			await expect(missing.probe("git")).resolves.toEqual({ state: "missing", kind: "git" });
			expect(calls).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("install sem Git nativo retorna MANUAL_INSTALL_REQUIRED sem rede", async () => {
		const root = await tempRoot();
		try {
			const { fetchImpl, calls } = fakeFetch({});
			const installer = makeLinuxInstaller(root, { fetchImpl });
			await expect(installer.install("git")).rejects.toMatchObject({
				code: "MANUAL_INSTALL_REQUIRED",
			});
			expect(calls).toEqual([]);
			expect(await exists(linuxToolsRoot(root))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("install adota Git nativo do PATH intacto", async () => {
		const root = await tempRoot();
		try {
			const bin = path.join(root, "bin");
			await mkdir(bin, { recursive: true });
			const executable = path.join(bin, "git");
			await writeFile(executable, "global");
			const { fetchImpl, calls } = fakeFetch({});
			const installer = makeLinuxInstaller(root, {
				env: linuxEnv(root, bin),
				fetchImpl,
				probeRunner: probeVersions({ git: "2.43.0" }),
			});
			await expect(installer.install("git")).resolves.toEqual({
				kind: "git",
				executablePath: executable,
				version: "2.43.0",
			});
			expect(calls).toEqual([]);
			expect(await readFile(executable, "utf8")).toBe("global");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("Linux: Node.js LTS TAR.GZ", () => {
	test.skipIf(process.platform === "win32")(
		"resolve LTS linux-x64, confere SHASUMS, extrai symlinks oficiais e ativa",
		async () => {
		const root = await tempRoot();
		try {
			const tar = linuxNodeTarGz("26.13.0");
			const artifact = linuxNodeArtifact(tar);
			const shasumsUrl = "https://nodejs.org/dist/v26.13.0/SHASUMS256.txt";
			const { fetchImpl, calls } = fakeFetch({
				json: new Map([[NODE_LTS_INDEX_URL, nodeIndex("26.13.0", "linux-x64")]]),
				text: new Map([[shasumsUrl, shasums(artifact.fileName, tar)]]),
				bodies: new Map([[artifact.url, tar]]),
			});
			const installer = makeLinuxInstaller(root, {
				fetchImpl,
				probeRunner: probeVersions({ node: "26.13.0" }),
			});
			const result = await installer.install("node");
			const nodeRoot = path.join(linuxToolsRoot(root), "node");
			expect(result).toEqual({
				kind: "node",
				executablePath: path.join(nodeRoot, "bin", "node"),
				version: "26.13.0",
			});
			expect(await readFile(path.join(nodeRoot, "bin", "node"), "utf8")).toBe("fake node");
			expect(await readlink(path.join(nodeRoot, "bin", "npm"))).toBe(
				"../lib/node_modules/npm/bin/npm-cli.js",
			);
			expect((await lstat(path.join(nodeRoot, "bin", "npm"))).isSymbolicLink()).toBe(true);
			expect(
				await readFile(path.join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "utf8"),
			).toBe("fake npm cli");
			expect(await exists(path.join(nodeRoot, "node-v26.13.0-linux-x64"))).toBe(false);
			if (process.platform !== "win32") {
				expect((await stat(path.join(nodeRoot, "bin", "node"))).mode & 0o111).not.toBe(0);
			}
			expect(calls).toEqual([NODE_LTS_INDEX_URL, shasumsUrl, artifact.url]);
			const names = await readdir(linuxToolsRoot(root));
			expect(names.some((name) => name.startsWith(".tmp-"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("adota Node global do PATH sem baixar", async () => {
		const root = await tempRoot();
		try {
			const bin = path.join(root, "bin");
			await mkdir(bin, { recursive: true });
			const executable = path.join(bin, "node");
			await writeFile(executable, "global node");
			const { fetchImpl, calls } = fakeFetch({});
			const installer = makeLinuxInstaller(root, {
				env: linuxEnv(root, bin),
				fetchImpl,
				probeRunner: probeVersions({ node: "22.0.0" }),
			});
			await expect(installer.install("node")).resolves.toEqual({
				kind: "node",
				executablePath: executable,
				version: "22.0.0",
			});
			expect(calls).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("instalação gerenciada incompleta não é sobrescrita", async () => {
		const root = await tempRoot();
		try {
			await mkdir(path.join(linuxToolsRoot(root), "node", "bin"), { recursive: true });
			await writeFile(path.join(linuxToolsRoot(root), "node", "bin", "node"), "existing");
			const { fetchImpl, calls } = fakeFetch({});
			const installer = makeLinuxInstaller(root, { fetchImpl });
			await expect(installer.install("node")).rejects.toMatchObject({
				code: "INCOMPLETE_INSTALL",
			});
			expect(calls).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("checksum divergente e versão divergente não ativam", async () => {
		const root = await tempRoot();
		try {
			const tar = linuxNodeTarGz("26.13.0");
			const artifact = linuxNodeArtifact(tar);
			const shasumsUrl = "https://nodejs.org/dist/v26.13.0/SHASUMS256.txt";
			const wrong = makeLinuxInstaller(root, {
				fetchImpl: fakeFetch({
					json: new Map([[NODE_LTS_INDEX_URL, nodeIndex("26.13.0", "linux-x64")]]),
					text: new Map([
						[shasumsUrl, `${"0".repeat(64)}  ${artifact.fileName}\n`],
					]),
					bodies: new Map([[artifact.url, tar]]),
				}).fetchImpl,
				probeRunner: probeVersions({ node: "26.13.0" }),
			});
			await expect(wrong.install("node")).rejects.toMatchObject({ code: "CHECKSUM" });
			expect(await exists(path.join(linuxToolsRoot(root), "node"))).toBe(false);

			const mismatch = makeLinuxInstaller(root, {
				fetchImpl: fakeFetch({
					bodies: new Map([[artifact.url, tar]]),
				}).fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ node: "9.9.9" }),
			});
			await expect(mismatch.install("node")).rejects.toMatchObject({
				code: "VERSION_MISMATCH",
			});
			expect(await exists(path.join(linuxToolsRoot(root), "node"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("arquitetura Linux ARM é recusada no escopo x86_64", async () => {
		const root = await tempRoot();
		try {
			const installer = makeLinuxInstaller(root, { arch: "arm64" });
			await expect(installer.install("node")).rejects.toMatchObject({
				code: "UNSUPPORTED_ARCH",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("probe e install reportam MISSING_SYSTEM_LIBRARY acionável", async () => {
		const root = await tempRoot();
		try {
			const tar = linuxNodeTarGz("26.13.0");
			const artifact = linuxNodeArtifact(tar);
			const installer = makeLinuxInstaller(root, {
				fetchImpl: fakeFetch({ bodies: new Map([[artifact.url, tar]]) }).fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: async () => {
					throw new DependencyInstallError(
						"MISSING_SYSTEM_LIBRARY",
						"missing-system-library=libatomic.so.1",
					);
				},
			});
			await expect(installer.install("node")).rejects.toMatchObject({
				code: "MISSING_SYSTEM_LIBRARY",
			});
			expect(await exists(path.join(linuxToolsRoot(root), "node"))).toBe(false);

			const nodeDir = path.join(linuxToolsRoot(root), "node");
			await mkdir(path.join(nodeDir, "bin"), { recursive: true });
			await writeFile(path.join(nodeDir, "bin", "node"), "existing");
			await writeFile(path.join(nodeDir, "bin", "npm"), "existing");
			await writeFile(path.join(nodeDir, "bin", "npx"), "existing");
			await mkdir(path.join(nodeDir, "lib", "node_modules", "npm", "bin"), {
				recursive: true,
			});
			await writeFile(
				path.join(nodeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
				"existing",
			);
			await writeFile(
				path.join(nodeDir, "lib", "node_modules", "npm", "bin", "npx-cli.js"),
				"existing",
			);
			await expect(installer.probe("node")).resolves.toMatchObject({
				state: "error",
				code: "MISSING_SYSTEM_LIBRARY",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("Linux: segurança do TAR.GZ", () => {
	async function installTar(tar: Uint8Array): Promise<{ code?: string; root: string }> {
		const root = await tempRoot();
		const artifact = linuxNodeArtifact(tar);
		const installer = makeLinuxInstaller(root, {
			fetchImpl: fakeFetch({ bodies: new Map([[artifact.url, tar]]) }).fetchImpl,
			artifactResolver: () => artifact,
			probeRunner: probeVersions({ node: "26.13.0" }),
		});
		try {
			await installer.install("node");
			return { root };
		} catch (error) {
			return {
				root,
				code: error instanceof DependencyInstallError ? error.code : "UNKNOWN",
			};
		}
	}

	test("rejeita travessia, caminho absoluto, symlink e hardlink que escapam", async () => {
		const cases: Array<{ name: string; tar: Uint8Array; code: string }> = [
			{
				name: "traversal",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{ name: "node-v26.13.0-linux-x64/../evil", data: utf8("evil") },
				]),
				code: "PATH_ESCAPE",
			},
			{
				name: "absolute",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{ name: "/etc/evil", data: utf8("evil") },
				]),
				code: "PATH_ESCAPE",
			},
			{
				name: "symlink-escape",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{
						name: "node-v26.13.0-linux-x64/link",
						type: "2",
						linkName: "../../outside",
					},
				]),
				code: "PATH_ESCAPE",
			},
			{
				name: "symlink-absolute",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{ name: "node-v26.13.0-linux-x64/link", type: "2", linkName: "/etc/passwd" },
				]),
				code: "PATH_ESCAPE",
			},
			{
				name: "symlink-ancestor",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{ name: "node-v26.13.0-linux-x64/sub/", type: "5" },
					{
						name: "node-v26.13.0-linux-x64/link",
						type: "2",
						linkName: "sub",
					},
					{
						name: "node-v26.13.0-linux-x64/link/evil",
						data: utf8("evil"),
					},
				]),
				code: "PATH_ESCAPE",
			},
			{
				name: "hardlink-escape",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{
						name: "node-v26.13.0-linux-x64/hard",
						type: "1",
						linkName: "../../outside",
					},
				]),
				code: "ARCHIVE_INVALID",
			},
			{
				name: "chained-symlink-escape",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{ name: "node-v26.13.0-linux-x64/a/", type: "5" },
					{ name: "node-v26.13.0-linux-x64/a/b/", type: "5" },
					{ name: "node-v26.13.0-linux-x64/a/b/c/", type: "5" },
					{
						name: "node-v26.13.0-linux-x64/a/b/c/x",
						type: "2",
						linkName: "../../../d",
					},
					{
						name: "node-v26.13.0-linux-x64/a/b/c/y",
						type: "2",
						linkName: "x/../../..",
					},
				]),
				code: "PATH_ESCAPE",
			},
			{
				name: "directory-over-symlink",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{ name: "node-v26.13.0-linux-x64/sub/", type: "5" },
					{
						name: "node-v26.13.0-linux-x64/link",
						type: "2",
						linkName: "sub",
					},
					{ name: "node-v26.13.0-linux-x64/link/", type: "5" },
				]),
				code: "PATH_ESCAPE",
			},
			{
				name: "hardlink-through-symlink",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{ name: "node-v26.13.0-linux-x64/sub/", type: "5" },
					{
						name: "node-v26.13.0-linux-x64/sub/file",
						data: utf8("target"),
					},
					{
						name: "node-v26.13.0-linux-x64/link",
						type: "2",
						linkName: "sub",
					},
					{
						name: "node-v26.13.0-linux-x64/hard",
						type: "1",
						linkName: "node-v26.13.0-linux-x64/link/file",
					},
				]),
				code: "PATH_ESCAPE",
			},
		];
		for (const testCase of cases) {
			const result = await installTar(testCase.tar);
			try {
				expect({ name: testCase.name, code: result.code }).toEqual({
					name: testCase.name,
					code: testCase.code,
				});
				expect(await exists(path.join(linuxToolsRoot(result.root), "node"))).toBe(false);
			} finally {
				await rm(result.root, { recursive: true, force: true });
			}
		}
	});

	test("rejeita tamanho excessivo, bomba total, tipo desconhecido e checksum TAR", async () => {
		const cases: Array<{ name: string; tar: Uint8Array; code: string }> = [
			{
				name: "entry-too-large",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{
						name: "node-v26.13.0-linux-x64/bin/node",
						declaredSize: 300 * 1024 * 1024,
					},
				]),
				code: "SIZE_LIMIT",
			},
			{
				name: "archive-too-large",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{
						name: "node-v26.13.0-linux-x64/a",
						declaredSize: 600 * 1024 * 1024,
					},
					{
						name: "node-v26.13.0-linux-x64/b",
						declaredSize: 600 * 1024 * 1024,
					},
				]),
				code: "SIZE_LIMIT",
			},
			{
				name: "unsupported-type",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{ name: "node-v26.13.0-linux-x64/x", type: "9" },
				]),
				code: "ARCHIVE_INVALID",
			},
			{
				name: "bad-checksum",
				tar: buildTarGz([
					{ name: "node-v26.13.0-linux-x64/", type: "5" },
					{
						name: "node-v26.13.0-linux-x64/bin/node",
						data: utf8("fake node"),
						badChecksum: true,
					},
				]),
				code: "ARCHIVE_INVALID",
			},
		];
		for (const testCase of cases) {
			const result = await installTar(testCase.tar);
			try {
				expect({ name: testCase.name, code: result.code }).toEqual({
					name: testCase.name,
					code: testCase.code,
				});
			} finally {
				await rm(result.root, { recursive: true, force: true });
			}
		}
	});

	test("cancel durante o download TAR limpa temporários e libera o single-flight", async () => {
		const root = await tempRoot();
		try {
			const tar = linuxNodeTarGz("26.13.0");
			const artifact = linuxNodeArtifact(tar);
			const { fetchImpl } = fakeFetch({
				override: (url, init) => {
					if (url !== artifact.url) return undefined;
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(tar.subarray(0, 1024));
							init.signal?.addEventListener(
								"abort",
								() => {
									try {
										controller.error(new DOMException("aborted", "AbortError"));
									} catch {
										// stream já encerrado
									}
								},
								{ once: true },
							);
						},
					});
					return new Response(stream, {
						headers: { "content-length": String(tar.length) },
					});
				},
			});
			const installer = makeLinuxInstaller(root, {
				fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ node: "26.13.0" }),
			});
			const started = Promise.withResolvers<void>();
			const promise = installer.install("node", {
				onProgress: (progress) => {
					if (progress.phase === "downloading") started.resolve();
				},
			});
			await started.promise;
			installer.cancel();
			await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
			const names = await readdir(linuxToolsRoot(root));
			expect(names.some((name) => name.startsWith(".tmp-"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Fronteiras de integridade e extração
// ---------------------------------------------------------------------------

describe("integridade do artefato", () => {
	test("checksum divergente não extrai nem ativa", async () => {
		const root = await tempRoot();
		try {
			const zip = gitZip();
			const artifact = testArtifact("git", zip, { sha256: "0".repeat(64) });
			const { fetchImpl } = fakeFetch({ bodies: new Map([[artifact.url, zip]]) });
			const installer = makeInstaller(root, {
				fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			await expect(installer.install("git")).rejects.toMatchObject({ code: "CHECKSUM" });
			expect(await exists(path.join(toolsRoot(root), "git"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("arquivo corrompido é recusado", async () => {
		const root = await tempRoot();
		try {
			const zip = new Uint8Array([1, 2, 3, 4]);
			const artifact = testArtifact("git", zip);
			const { fetchImpl } = fakeFetch({ bodies: new Map([[artifact.url, zip]]) });
			const installer = makeInstaller(root, {
				fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			await expect(installer.install("git")).rejects.toMatchObject({
				code: "ARCHIVE_INVALID",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("zip-slip, caminho absoluto, ADS, nome reservado e symlink são recusados", async () => {
		const cases: Array<{ name: string; zip: Uint8Array }> = [
			{
				name: "zip-slip",
				zip: buildZip([
					{ name: "cmd/git.exe", data: utf8("fake git") },
					{ name: "../evil.txt", data: utf8("evil") },
				]),
			},
			{
				name: "absoluto",
				zip: buildZip([
					{ name: "cmd/git.exe", data: utf8("fake git") },
					{ name: "C:/evil.txt", data: utf8("evil") },
				]),
			},
			{
				name: "ads",
				zip: buildZip([
					{ name: "cmd/git.exe", data: utf8("fake git") },
					{ name: "cmd/git.exe:stream", data: utf8("evil") },
				]),
			},
			{
				name: "reservado",
				zip: buildZip([
					{ name: "cmd/git.exe", data: utf8("fake git") },
					{ name: "CON", data: utf8("evil") },
				]),
			},
			{
				name: "symlink",
				zip: buildZip([
					{ name: "cmd/git.exe", data: utf8("fake git") },
					{ name: "link", data: utf8("target"), mode: 0o120777 },
				]),
			},
		];
		for (const testCase of cases) {
			const root = await tempRoot();
			try {
				const artifact = testArtifact("git", testCase.zip);
				const { fetchImpl } = fakeFetch({ bodies: new Map([[artifact.url, testCase.zip]]) });
				const installer = makeInstaller(root, {
					fetchImpl,
					artifactResolver: () => artifact,
					probeRunner: probeVersions({ git: "2.56.0" }),
				});
				await expect(installer.install("git")).rejects.toMatchObject({
					code: "PATH_ESCAPE",
				});
				expect(await exists(path.join(toolsRoot(root), "git"))).toBe(false);
				expect(await exists(path.join(root, "evil.txt"))).toBe(false);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	test("entradas duplicadas ou conflitantes são recusadas", async () => {
		const cases: Uint8Array[] = [
			buildZip([
				{ name: "cmd/git.exe", data: utf8("fake git") },
				{ name: "CMD/GIT.EXE", data: utf8("evil") },
			]),
			buildZip([
				{ name: "cmd/git.exe", data: utf8("fake git") },
				{ name: "cmd/git.exe/child", data: utf8("evil") },
			]),
		];
		for (const zip of cases) {
			const root = await tempRoot();
			try {
				const artifact = testArtifact("git", zip);
				const { fetchImpl } = fakeFetch({ bodies: new Map([[artifact.url, zip]]) });
				const installer = makeInstaller(root, {
					fetchImpl,
					artifactResolver: () => artifact,
					probeRunner: probeVersions({ git: "2.56.0" }),
				});
				await expect(installer.install("git")).rejects.toMatchObject({
					code: "ARCHIVE_INVALID",
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	test("CRC divergente e tamanho declarado excessivo são recusados", async () => {
		const cases: Array<{ zip: Uint8Array; code: string }> = [
			{
				zip: buildZip([
					{ name: "cmd/git.exe", data: utf8("fake git"), crcOverride: 0x12345678 },
				]),
				code: "ARCHIVE_INVALID",
			},
			{
				zip: buildZip([
					{
						name: "cmd/git.exe",
						data: utf8("fake git"),
						declaredSize: 300 * 1024 * 1024,
					},
				]),
				code: "SIZE_LIMIT",
			},
		];
		for (const testCase of cases) {
			const root = await tempRoot();
			try {
				const artifact = testArtifact("git", testCase.zip);
				const { fetchImpl } = fakeFetch({ bodies: new Map([[artifact.url, testCase.zip]]) });
				const installer = makeInstaller(root, {
					fetchImpl,
					artifactResolver: () => artifact,
					probeRunner: probeVersions({ git: "2.56.0" }),
				});
				await expect(installer.install("git")).rejects.toMatchObject({
					code: testCase.code,
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Versão, concorrência, cancelamento e rede
// ---------------------------------------------------------------------------

describe("versão e ativação", () => {
	test("--version divergente não ativa o binário", async () => {
		const root = await tempRoot();
		try {
			const zip = gitZip();
			const artifact = testArtifact("git", zip);
			const { fetchImpl } = fakeFetch({ bodies: new Map([[artifact.url, zip]]) });
			const installer = makeInstaller(root, {
				fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ git: "9.9.9" }),
			});
			await expect(installer.install("git")).rejects.toMatchObject({
				code: "VERSION_MISMATCH",
			});
			expect(await exists(path.join(toolsRoot(root), "git"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("falha na sondagem pós-ativação remove somente o diretório promovido", async () => {
		const root = await tempRoot();
		try {
			const zip = gitZip();
			const artifact = testArtifact("git", zip);
			const { fetchImpl } = fakeFetch({ bodies: new Map([[artifact.url, zip]]) });
			const installer = makeInstaller(root, {
				fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: async (_kind, executable) =>
					executable.includes(".tmp-") ? "2.56.0" : undefined,
			});
			await expect(installer.install("git")).rejects.toMatchObject({
				code: "VERSION_MISMATCH",
			});
			expect(await exists(path.join(toolsRoot(root), "git"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("concorrência e cancelamento", () => {
	test("single-flight por ferramenta compartilha a mesma promise e um download", async () => {
		const root = await tempRoot();
		try {
			const zip = gitZip();
			const artifact = testArtifact("git", zip);
			const gate = Promise.withResolvers<void>();
			const { fetchImpl, calls } = fakeFetch({
				bodies: new Map([[artifact.url, zip]]),
				gate: gate.promise,
			});
			const installer = makeInstaller(root, {
				fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			const first = installer.install("git");
			const second = installer.install("git");
			expect(first).toBe(second);
			gate.resolve();
			await first;
			expect(calls.filter((url) => url === artifact.url)).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("Git e Node instalam em paralelo", async () => {
		const root = await tempRoot();
		try {
			const gitBytes = gitZip();
			const nodeBytes = nodeZip("26.13.0");
			const gitArtifact = testArtifact("git", gitBytes);
			const nodeArtifact = testArtifact("node", nodeBytes);
			const { fetchImpl } = fakeFetch({
				bodies: new Map([
					[gitArtifact.url, gitBytes],
					[nodeArtifact.url, nodeBytes],
				]),
			});
			const installer = makeInstaller(root, {
				fetchImpl,
				artifactResolver: (kind) => (kind === "git" ? gitArtifact : nodeArtifact),
				probeRunner: probeVersions({ git: "2.56.0", node: "26.13.0" }),
			});
			const [git, node] = await Promise.all([
				installer.install("git"),
				installer.install("node"),
			]);
			expect(git.kind).toBe("git");
			expect(node.kind).toBe("node");
			expect(await exists(git.executablePath)).toBe(true);
			expect(await exists(node.executablePath)).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("cancel aborta, limpa temporários e libera o single-flight", async () => {
		const root = await tempRoot();
		try {
			const artifact = testArtifact("git", new Uint8Array(1024));
			const { fetchImpl } = fakeFetch({
				override: (url, init) => {
					if (url !== artifact.url) return undefined;
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(1024));
							init.signal?.addEventListener(
								"abort",
								() => {
									try {
										controller.error(new DOMException("aborted", "AbortError"));
									} catch {
										// stream já encerrado
									}
								},
								{ once: true },
							);
						},
					});
					return new Response(stream, {
						headers: { "content-length": "1000000" },
					});
				},
			});
			const installer = makeInstaller(root, {
				fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			const started = Promise.withResolvers<void>();
			const promise = installer.install("git", {
				onProgress: (progress) => {
					if (progress.phase === "downloading") started.resolve();
				},
			});
			await started.promise;
			expect(installer.installing).toBe(true);
			installer.cancel();
			await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
			expect(installer.installing).toBe(false);
			const names = await readdir(toolsRoot(root));
			expect(names.some((name) => name.startsWith(".tmp-"))).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("HTTP de erro e limite de download são reportados", async () => {
		const root = await tempRoot();
		try {
			const zip = gitZip();
			const artifact = testArtifact("git", zip);
			const notFound = makeInstaller(root, {
				fetchImpl: fakeFetch({
					override: (url) =>
						url === artifact.url ? new Response("no", { status: 404 }) : undefined,
				}).fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			await expect(notFound.install("git")).rejects.toMatchObject({ code: "HTTP_STATUS" });

			const tooLarge = makeInstaller(root, {
				fetchImpl: fakeFetch({
					bodies: new Map([[artifact.url, new Uint8Array(64)]]),
				}).fetchImpl,
				artifactResolver: () => testArtifact("git", new Uint8Array(64), {
					maxDownloadBytes: 8,
				}),
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			await expect(tooLarge.install("git")).rejects.toMatchObject({ code: "SIZE_LIMIT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("segue redirect oficial e recusa redirect para host desconhecido", async () => {
		const root = await tempRoot();
		try {
			const zip = gitZip();
			const artifact = testArtifact("git", zip);
			const target =
				"https://release-assets.githubusercontent.com/github-production-release-asset/1/2?token=x";
			const followed = makeInstaller(root, {
				fetchImpl: fakeFetch({
					override: (url) => {
						if (url === artifact.url) {
							return new Response(null, { status: 302, headers: { location: target } });
						}
						if (url === target) return bytesResponse(zip);
						return undefined;
					},
				}).fetchImpl,
				artifactResolver: () => artifact,
				probeRunner: probeVersions({ git: "2.56.0" }),
			});
			await expect(followed.install("git")).resolves.toMatchObject({ kind: "git" });

			const evilRoot = await tempRoot();
			try {
				const evil = makeInstaller(evilRoot, {
					fetchImpl: fakeFetch({
						override: (url) =>
							url === artifact.url
								? new Response(null, {
										status: 302,
										headers: { location: "https://evil.example/x.zip" },
									})
								: undefined,
					}).fetchImpl,
					artifactResolver: () => artifact,
					probeRunner: probeVersions({ git: "2.56.0" }),
				});
				await expect(evil.install("git")).rejects.toMatchObject({ code: "NETWORK" });
			} finally {
				await rm(evilRoot, { recursive: true, force: true });
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Metadados oficiais
// ---------------------------------------------------------------------------

describe("metadados oficiais", () => {
	test("Git fixa versão e SHA-256 oficiais por arquitetura", () => {
		expect(GIT_WINDOWS_VERSION).toBe("2.56.0.4");
		expect(GIT_WINDOWS_MINIGIT_SHA256.x64).toMatch(/^[0-9a-f]{64}$/);
		expect(GIT_WINDOWS_MINIGIT_SHA256.arm64).toMatch(/^[0-9a-f]{64}$/);
		expect(GIT_WINDOWS_MINIGIT_SHA256.ia32).toMatch(/^[0-9a-f]{64}$/);
	});
});
