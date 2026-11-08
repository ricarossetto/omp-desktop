/**
 * Gera os pacotes Linux x86_64 do OMP Desktop.
 *
 * Pré-requisitos: `bun run build` concluído, `bun install` feito no Linux
 * (nunca reutilize node_modules do Windows) e `bun run build:icons` executado.
 *
 * Saídas em release/:
 *   OMP-Desktop-<versão>-linux-amd64.deb      (Debian 12/13, Ubuntu 24.04/26.04)
 *   OMP-Desktop-<versão>-linux-x64.tar.gz     (fonte local do PKGBUILD Arch)
 *   omp-desktop-<versão>-1-x86_64.pkg.tar.zst (quando makepkg existe)
 *   SHA256SUMS
 *
 * O Bun 1.4.4 baseline (sem AVX2) é baixado do release oficial, verificado por
 * SHA-256 e extraído para resources/bun/bun com modo 0755. O .deb usa o
 * after-install do electron-builder (AppArmor no Ubuntu 24+ e chrome-sandbox
 * 4755 apenas quando user namespaces não funcionam); nunca usamos --no-sandbox.
 *
 * Uso:
 *   bun scripts/dist-linux.ts              # .deb + tar.gz (+ pkg Arch se makepkg)
 *   bun scripts/dist-linux.ts --no-arch    # somente .deb + tar.gz
 *   bun scripts/dist-linux.ts --clean      # remove caches/intermediários (mantém resources/bun)
 *   bun scripts/dist-linux.ts --clean-bun  # também remove resources/bun/bun
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import { createBuilderConfig } from "../electron-builder.config";

const root = path.resolve(import.meta.dir, "..");
const releaseDir = path.join(root, "release");
const BUN_VERSION = "1.4.4";
const BUN_URL =
	"https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64-baseline.zip";
const BUN_SHA256 = "e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76";
const BUN_ZIP_SIZE = 51_794_559;
const BUN_ENTRY = "bun-linux-x64-baseline/bun";
const BUN_BINARY_SHA256 = "10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235";
const BUN_BINARY_SIZE = 107_308_936;
const BUN_DOWNLOAD_HOSTS: Record<string, true> = {
	"github.com": true,
	"objects.githubusercontent.com": true,
	"release-assets.githubusercontent.com": true,
};

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

function formatBytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256");
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const stream = createReadStream(file);
	stream.on("data", (chunk) => hash.update(chunk));
	stream.on("error", reject);
	stream.on("end", resolve);
	await promise;
	return hash.digest("hex");
}

async function capture(command: string[]): Promise<string> {
	const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		child.stdout ? new Response(child.stdout).text() : Promise.resolve(""),
		child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
		child.exited,
	]);
	if (code !== 0) {
		throw new Error(`${command[0]} falhou (código ${code}): ${stderr.trim()}`);
	}
	return stdout;
}

async function assertFile(relative: string, minSize = 1): Promise<void> {
	const info = await stat(path.join(root, relative)).catch(() => null);
	if (!info?.isFile() || info.size < minSize) {
		fail(`Artefato ausente ou vazio: ${relative}. Execute "bun run build" e "bun run build:icons" antes.`);
	}
}

async function assertDirectory(relative: string): Promise<void> {
	const info = await stat(path.join(root, relative)).catch(() => null);
	if (!info?.isDirectory()) {
		fail(`Diretório ausente: ${relative}. Execute "bun install" no Linux antes.`);
	}
}

async function verifyElfX64(file: string): Promise<void> {
	const handle = await open(file, "r");
	try {
		const header = Buffer.alloc(20);
		const { bytesRead } = await handle.read(header, 0, header.length, 0);
		if (bytesRead < header.length) fail(`Binário truncado: ${file}`);
		if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
			fail(`O Bun empacotado não é um ELF: ${file}`);
		}
		if (header[4] !== 2 || header[5] !== 1) fail(`O Bun empacotado não é ELF64 little-endian: ${file}`);
		if (header.readUInt16LE(18) !== 0x3e) fail(`O Bun empacotado não é x86_64: ${file}`);
	} finally {
		await handle.close();
	}
}

async function verifyBunVersion(bunPath: string): Promise<void> {
	const output = await capture([bunPath, "--version"]);
	const version = output.trim().split(/\s+/)[0];
	if (version !== BUN_VERSION) {
		fail(`Bun empacotado reportou "${version}", esperado ${BUN_VERSION}.`);
	}
}

let crcTable: Uint32Array | null = null;

function crc32(buffer: Buffer): number {
	let table = crcTable;
	if (!table) {
		table = new Uint32Array(256);
		for (let index = 0; index < 256; index += 1) {
			let value = index;
			for (let bit = 0; bit < 8; bit += 1) {
				value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
			}
			table[index] = value >>> 0;
		}
		crcTable = table;
	}
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
	const minimum = Math.max(0, buffer.length - 65_557);
	for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
		if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
	}
	throw new Error("ZIP sem End of Central Directory.");
}

/**
 * Extrai uma única entrada do ZIP oficial do Bun. Não usa unzip externo e não
 * segue caminhos do arquivo: só a entrada exata é lida, com limites de tamanho
 * e verificação de CRC-32. Isso elimina zip-slip e bombas de descompressão.
 */
function readZipEntry(buffer: Buffer, entryName: string): Buffer {
	const eocd = findEndOfCentralDirectory(buffer);
	const entries = buffer.readUInt16LE(eocd + 10);
	const centralOffset = buffer.readUInt32LE(eocd + 16);
	if (entries === 0xffff || centralOffset === 0xffffffff) {
		throw new Error("ZIP64 não suportado para o Bun empacotado.");
	}
	let offset = centralOffset;
	for (let index = 0; index < entries; index += 1) {
		if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP: cabeçalho central inválido.");
		const method = buffer.readUInt16LE(offset + 10);
		const expectedCrc = buffer.readUInt32LE(offset + 16);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const uncompressedSize = buffer.readUInt32LE(offset + 24);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		if (name === entryName) {
			if (name.includes("..") || name.startsWith("/") || name.includes("\\")) {
				throw new Error(`ZIP: caminho inseguro ${name}`);
			}
			if (uncompressedSize > 200 * 1024 * 1024 || compressedSize > 200 * 1024 * 1024) {
				throw new Error("ZIP: entrada do Bun excede o limite de tamanho.");
			}
			if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
				throw new Error("ZIP: cabeçalho local inválido.");
			}
			const localNameLength = buffer.readUInt16LE(localOffset + 26);
			const localExtraLength = buffer.readUInt16LE(localOffset + 28);
			const dataStart = localOffset + 30 + localNameLength + localExtraLength;
			const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
			if (compressed.length !== compressedSize) throw new Error("ZIP: dados truncados.");
			let data: Buffer;
			if (method === 0) data = Buffer.from(compressed);
			else if (method === 8) data = inflateRawSync(compressed);
			else throw new Error(`ZIP: método de compressão não suportado (${method}).`);
			if (data.length !== uncompressedSize) throw new Error("ZIP: tamanho descompactado divergente.");
			if (crc32(data) !== expectedCrc) throw new Error("ZIP: CRC-32 divergente.");
			return data;
		}
		offset += 46 + nameLength + extraLength + commentLength;
	}
	throw new Error(`ZIP: entrada ${entryName} não encontrada.`);
}

async function downloadBunZip(zipPath: string): Promise<void> {
	const temporary = `${zipPath}.part`;
	await rm(temporary, { force: true });
	console.log(`Baixando Bun ${BUN_VERSION} (${formatBytes(BUN_ZIP_SIZE)})...`);
	const response = await fetch(BUN_URL, {
		redirect: "follow",
		signal: AbortSignal.timeout(300_000),
		headers: { "User-Agent": "omp-desktop-packaging/0.3.1" },
	});
	if (!response.ok) throw new Error(`Download do Bun falhou: HTTP ${response.status}.`);
	const finalUrl = new URL(response.url);
	if (finalUrl.protocol !== "https:" || BUN_DOWNLOAD_HOSTS[finalUrl.hostname] !== true) {
		throw new Error(`Download do Bun redirecionou para host não permitido: ${finalUrl.href}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length !== BUN_ZIP_SIZE) {
		throw new Error(`Tamanho do Bun divergente: ${bytes.length}, esperado ${BUN_ZIP_SIZE}.`);
	}
	const hash = createHash("sha256").update(bytes).digest("hex");
	if (hash !== BUN_SHA256) {
		throw new Error(`SHA-256 do Bun divergente: ${hash}, esperado ${BUN_SHA256}.`);
	}
	await writeFile(temporary, bytes);
	await rename(temporary, zipPath);
}

async function ensureBun(): Promise<{ path: string; sha256: string }> {
	const cacheDir = path.join(root, ".cache", "bun");
	const zipPath = path.join(cacheDir, "bun-linux-x64-baseline-1.4.4.zip");
	await mkdir(cacheDir, { recursive: true });
	let zipValid = false;
	try {
		const info = await stat(zipPath);
		if (info.size === BUN_ZIP_SIZE) {
			zipValid = (await sha256File(zipPath)) === BUN_SHA256;
		}
	} catch {
		zipValid = false;
	}
	if (!zipValid) {
		await rm(zipPath, { force: true });
		await downloadBunZip(zipPath);
	}
	const zip = await readFile(zipPath);
	const data = readZipEntry(zip, BUN_ENTRY);
	if (data.length !== BUN_BINARY_SIZE) {
		throw new Error(`Bun extraído com tamanho divergente: ${data.length}, esperado ${BUN_BINARY_SIZE}.`);
	}
	const binaryHash = createHash("sha256").update(data).digest("hex");
	if (binaryHash !== BUN_BINARY_SHA256) {
		throw new Error(`SHA-256 do Bun extraído divergente: ${binaryHash}, esperado ${BUN_BINARY_SHA256}.`);
	}
	const bunDir = path.join(root, "resources", "bun");
	await mkdir(bunDir, { recursive: true });
	const bunPath = path.join(bunDir, "bun");
	const temporary = `${bunPath}.part`;
	await writeFile(temporary, data, { mode: 0o755 });
	await chmod(temporary, 0o755);
	await verifyElfX64(temporary);
	await rename(temporary, bunPath);
	await chmod(bunPath, 0o755);
	await verifyBunVersion(bunPath);
	const sha256 = createHash("sha256").update(data).digest("hex");
	console.log(`Bun ${BUN_VERSION} empacotado: ${bunPath} (${formatBytes(data.length)}, sha256 ${sha256})`);
	return { path: bunPath, sha256 };
}

async function verifyPkgbuild(version: string): Promise<void> {
	const pkgbuildPath = path.join(root, "packaging", "arch", "PKGBUILD");
	const pkgbuild = await readFile(pkgbuildPath, "utf8").catch(() => {
		fail(`PKGBUILD não encontrado em ${pkgbuildPath}.`);
	});
	if (!/^pkgname=omp-desktop$/m.test(pkgbuild)) fail("PKGBUILD: pkgname deve ser omp-desktop.");
	if (!/^arch=\('x86_64'\)$/m.test(pkgbuild)) fail("PKGBUILD: arch deve ser x86_64.");
	const match = pkgbuild.match(/^pkgver=(['"]?)([^'"\s]+)\1$/m);
	if (!match) fail("PKGBUILD: pkgver não encontrado.");
	if (match[2] !== version) {
		fail(`PKGBUILD: pkgver ${match[2]} não corresponde a package.json ${version}.`);
	}
	if (!/^pkgrel=\d+$/m.test(pkgbuild)) fail("PKGBUILD: pkgrel inválido.");
}

async function verifyUnpacked(version: string): Promise<void> {
	const unpacked = path.join(releaseDir, "linux-unpacked");
	const info = await stat(unpacked).catch(() => null);
	if (!info?.isDirectory()) fail("electron-builder não gerou release/linux-unpacked.");
	for (const relative of [
		"omp-desktop",
		"chrome-sandbox",
		"resources/bun/bun",
		"resources/icons/512x512.png",
		"resources/licenses/LICENSE",
		"resources/licenses/NOTICE.txt",
	]) {
		const file = path.join(unpacked, relative);
		const fileInfo = await stat(file).catch(() => null);
		if (!fileInfo?.isFile()) fail(`Pacote Linux sem ${relative}.`);
	}
	for (const relative of ["omp-desktop", "resources/bun/bun"]) {
		const fileInfo = await stat(path.join(unpacked, relative));
		if ((fileInfo.mode & 0o111) === 0) fail(`Pacote Linux sem permissão de execução: ${relative}.`);
	}
	const packagedBun = await stat(path.join(unpacked, "resources", "bun", "bun"));
	if (packagedBun.size !== BUN_BINARY_SIZE) {
		fail(`Pacote Linux com Bun truncado: ${packagedBun.size}, esperado ${BUN_BINARY_SIZE}.`);
	}
	const wrongBun = path.join(unpacked, "resources", "bun", "bun.exe");
	if (await stat(wrongBun).catch(() => null)) fail("Pacote Linux contém bun.exe do Windows.");
	const ptyDir = path.join(unpacked, "resources", "app", "node_modules", "@lydell");
	const ptyEntries = await readdir(ptyDir).catch(() => [] as string[]);
	const wrongPty = ptyEntries.filter((name) => /win32|darwin|linux-arm64/.test(name));
	if (wrongPty.length > 0) {
		fail(`Pacote Linux contém módulos nativos de outra plataforma: ${wrongPty.join(", ")}.`);
	}
	if (!ptyEntries.includes("node-pty-linux-x64")) {
		fail("Pacote Linux sem @lydell/node-pty-linux-x64. Execute bun install no Linux.");
	}
	const sandbox = await stat(path.join(unpacked, "chrome-sandbox"));
	console.log(`chrome-sandbox mode: ${(sandbox.mode & 0o7777).toString(8)}`);
	console.log(`Pacote desempacotado verificado (versão ${version}).`);
}

async function verifyDeb(debPath: string, version: string): Promise<void> {
	const dpkgDeb = Bun.which("dpkg-deb");
	if (!dpkgDeb) {
		console.log("dpkg-deb não encontrado; pulando verificação de metadados do .deb.");
		return;
	}
	const control = await capture([dpkgDeb, "-f", debPath]);
	const fields = new Map<string, string>();
	for (const line of control.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator > 0) fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
	}
	if (fields.get("Package") !== "omp-desktop") fail(".deb: Package diferente de omp-desktop.");
	if (fields.get("Version") !== version) fail(`.deb: Version ${fields.get("Version")} diferente de ${version}.`);
	if (fields.get("Architecture") !== "amd64") fail(".deb: Architecture diferente de amd64.");
	const depends = fields.get("Depends") ?? "";
	if (!depends.includes("libatomic1")) fail(".deb: dependência ausente: libatomic1.");
	// t64 primeiro evita o shim liboss4-salsa-asound2 no Ubuntu 24.04/26.04.
	for (const pattern of [
		/libgtk-3-0t64\s*\|\s*libgtk-3-0/,
		/libatspi2\.0-0t64\s*\|\s*libatspi2\.0-0/,
		/libasound2t64\s*\|\s*libasound2/,
	]) {
		if (!pattern.test(depends)) fail(`.deb: alternativa t64 ausente ou fora de ordem: ${pattern}.`);
	}
	const contents = await capture([dpkgDeb, "-c", debPath]);
	// O symlink /usr/bin/omp-desktop é criado pelo postinst, não faz parte do
	// arquivo .deb. O binário real e o .desktop precisam estar no pacote.
	for (const required of [
		"./opt/omp-desktop/omp-desktop",
		"./usr/share/applications/omp-desktop.desktop",
		"chrome-sandbox",
	]) {
		if (!contents.includes(required)) fail(`.deb: conteúdo ausente: ${required}.`);
	}
	const bunLine = contents
		.split(/\r?\n/)
		.find((line) => line.includes("resources/bun/bun"));
	if (!bunLine) fail(".deb: conteúdo ausente: resources/bun/bun.");
	const bunSize = Number(bunLine.trim().split(/\s+/)[2]);
	if (!Number.isFinite(bunSize) || bunSize !== BUN_BINARY_SIZE) {
		fail(`.deb: Bun truncado (${bunLine.trim()}), esperado ${BUN_BINARY_SIZE} bytes.`);
	}
	console.log(`.deb verificado: Package=omp-desktop Version=${version} Architecture=amd64 Bun=${bunSize}`);
}

async function verifyTar(tarPath: string, version: string): Promise<void> {
	const tar = Bun.which("tar");
	if (!tar) {
		console.log("tar não encontrado; pulando verificação do tar.gz.");
		return;
	}
	const listing = await capture([tar, "-tzf", tarPath]);
	const entries = listing.split(/\r?\n/).filter(Boolean);
	const prefix = `OMP-Desktop-${version}-linux-x64/`;
	const has = (suffix: string) => entries.some((entry) => entry === suffix || entry === `${prefix}${suffix}`);
	for (const required of [
		"omp-desktop",
		"chrome-sandbox",
		"resources/bun/bun",
		"resources/icons/512x512.png",
		"resources/licenses/LICENSE",
	]) {
		if (!has(required)) fail(`tar.gz: entrada ausente: ${required}.`);
	}
	const verbose = await capture([tar, "-tzvf", tarPath]);
	const bunLine = verbose
		.split(/\r?\n/)
		.find((line) => line.endsWith("resources/bun/bun"));
	if (!bunLine) fail("tar.gz: entrada ausente: resources/bun/bun.");
	const bunSize = Number(bunLine.trim().split(/\s+/)[2]);
	if (!Number.isFinite(bunSize) || bunSize !== BUN_BINARY_SIZE) {
		fail(`tar.gz: Bun truncado (${bunLine.trim()}), esperado ${BUN_BINARY_SIZE} bytes.`);
	}
	console.log(`tar.gz verificado (${entries.length} entradas, Bun=${bunSize}).`);
}

async function writeChecksums(artifacts: string[]): Promise<string> {
	const lines: string[] = [];
	for (const artifact of artifacts.slice().sort()) {
		const hash = await sha256File(artifact);
		lines.push(`${hash}  ${path.basename(artifact)}`);
	}
	const sumsPath = path.join(releaseDir, "SHA256SUMS");
	await writeFile(sumsPath, `${lines.join("\n")}\n`, "utf8");
	return sumsPath;
}

async function buildArchPackage(
	version: string,
	tarballPath: string,
	tarballHash: string,
): Promise<string | undefined> {
	if (process.argv.includes("--no-arch")) {
		console.log("--no-arch: PKGBUILD não será executado nesta máquina.");
		return undefined;
	}
	const makepkg = Bun.which("makepkg");
	if (!makepkg) {
		console.log(
			"makepkg não encontrado. O PKGBUILD está em packaging/arch; execute-o em um Arch Linux não-root.",
		);
		return undefined;
	}
	if (typeof process.getuid === "function" && process.getuid() === 0) {
		fail("makepkg não pode rodar como root. Execute o dist:linux como usuário normal.");
	}
	const buildDir = path.join(root, ".cache", "arch");
	await rm(buildDir, { recursive: true, force: true });
	await mkdir(buildDir, { recursive: true });
	for (const file of ["PKGBUILD", "omp-desktop.desktop", "omp-desktop.install"]) {
		await copyFile(path.join(root, "packaging", "arch", file), path.join(buildDir, file));
	}
	console.log("Executando makepkg (Arch Linux)...");
	const child = Bun.spawn([makepkg, "--force", "--noconfirm", "--cleanbuild"], {
		cwd: buildDir,
		env: {
			...process.env,
			OMP_DESKTOP_ARCHIVE: tarballPath,
			OMP_DESKTOP_ARCHIVE_SHA256: tarballHash,
		},
		stdio: ["inherit", "inherit", "inherit"],
	});
	const code = await child.exited;
	if (code !== 0) {
		console.error(`makepkg falhou (código ${code}). Diretório preservado para diagnóstico: ${buildDir}`);
		process.exit(code);
	}
	const entries = await readdir(buildDir);
	const packageName = entries.find((entry) => entry.endsWith(".pkg.tar.zst"));
	if (!packageName) fail("makepkg terminou sem gerar .pkg.tar.zst.");
	const source = path.join(buildDir, packageName);
	const destination = path.join(releaseDir, packageName);
	await copyFile(source, destination);
	const pacman = Bun.which("pacman");
	if (pacman) {
		const info = await capture([pacman, "-Qip", destination]);
		if (!/^Name\s*:\s*omp-desktop$/m.test(info)) fail("pacote Arch: Name diferente de omp-desktop.");
		if (!new RegExp(`^Version\\s*:\\s*${version.replace(/\./g, "\\.")}-\\d+$`, "m").test(info)) {
			fail(`pacote Arch: Version diferente de ${version}.`);
		}
		if (!/^Architecture\s*:\s*x86_64$/m.test(info)) fail("pacote Arch: Architecture diferente de x86_64.");
		console.log(`pacote Arch verificado: ${packageName}`);
	}
	await rm(buildDir, { recursive: true, force: true });
	return destination;
}

async function cleanIntermediates(): Promise<void> {
	await rm(path.join(root, ".cache", "bun"), { recursive: true, force: true });
	if (process.argv.includes("--clean-bun")) {
		await rm(path.join(root, "resources", "bun"), { recursive: true, force: true });
	}
	await rm(path.join(root, ".cache", "arch"), { recursive: true, force: true });
	await rm(path.join(root, ".cache", "electron-builder-linux.json"), { force: true });
	await rm(path.join(releaseDir, "linux-unpacked"), { recursive: true, force: true });
	for (const name of ["builder-debug.yml", "builder-effective-config.yaml"]) {
		await rm(path.join(releaseDir, name), { force: true });
	}
	const entries = await readdir(releaseDir).catch(() => [] as string[]);
	for (const entry of entries) {
		if (/\.blockmap$/.test(entry) || /^latest.*\.yml$/.test(entry)) {
			await rm(path.join(releaseDir, entry), { force: true });
		}
	}
	const archDir = path.join(root, "packaging", "arch");
	const archEntries = await readdir(archDir).catch(() => [] as string[]);
	for (const entry of archEntries) {
		if (!entry.startsWith("OMP-Desktop-") || !entry.endsWith(".tar.gz")) continue;
		const file = path.join(archDir, entry);
		const info = await lstat(file).catch(() => null);
		if (info?.isSymbolicLink()) await rm(file, { force: true });
	}
	console.log(
		process.argv.includes("--clean-bun")
			? "Caches, intermediários e resources/bun removidos."
			: "Caches e intermediários removidos; resources/bun mantido para rebuild (use --clean-bun para remover).",
	);
}

async function main(): Promise<void> {
	if (process.platform !== "linux") {
		fail("dist:linux só pode ser executado em Linux x86_64 (use Docker/WSL para empacotar).");
	}
	if (process.arch !== "x64") {
		fail(`Arquitetura não suportada: ${process.arch}. Somente Linux x86_64.`);
	}

	await assertFile("out/main/index.js");
	await assertFile("out/preload/index.cjs");
	await assertFile("out/renderer/index.html");
	await assertFile("out/host/index.js");
	await assertFile("resources/icons/512x512.png");
	await assertFile("resources/licenses/NOTICE.txt");
	await assertFile("node_modules/electron-builder/cli.js");
	await assertFile("node_modules/electron/dist/electron");
	await assertDirectory("node_modules/@lydell/node-pty-linux-x64");
	if (await stat(path.join(root, "node_modules", "@lydell", "node-pty-win32-x64")).catch(() => null)) {
		fail("node_modules contém prebuild Windows. Execute bun install no Linux e não copie node_modules do Windows.");
	}

	const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
		version?: string;
	};
	const version = packageJson.version;
	if (!version || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
		fail("package.json: version inválida.");
	}
	await verifyPkgbuild(version);

	const bun = await ensureBun();
	await assertFile("resources/bun/bun", BUN_BINARY_SIZE);
	console.log(`Bun empacotado: ${bun.path} (sha256 ${bun.sha256})`);

	const generatedConfig = path.join(root, ".cache", "electron-builder-linux.json");
	await mkdir(path.dirname(generatedConfig), { recursive: true });
	await writeFile(
		generatedConfig,
		`${JSON.stringify(createBuilderConfig("linux"), null, 2)}\n`,
		"utf8",
	);

	const cli = path.join(root, "node_modules", "electron-builder", "cli.js");
	const executable = Bun.which("node") ?? process.execPath;
	const args = [cli, "--linux", "--x64", "--publish", "never", "--config", generatedConfig];
	console.log(`Executando electron-builder com ${path.basename(executable)}...`);
	const child = Bun.spawn([executable, ...args], {
		cwd: root,
		env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
		stdio: ["inherit", "inherit", "inherit"],
	});
	const code = await child.exited;
	if (code !== 0) fail(`electron-builder falhou (código ${code}).`);

	await mkdir(releaseDir, { recursive: true });
	const debPath = path.join(releaseDir, `OMP-Desktop-${version}-linux-amd64.deb`);
	const tarPath = path.join(releaseDir, `OMP-Desktop-${version}-linux-x64.tar.gz`);
	for (const artifact of [debPath, tarPath]) {
		const info = await stat(artifact).catch(() => null);
		if (!info?.isFile() || info.size < 10 * 1024 * 1024) {
			fail(`Artefato ausente ou pequeno demais: ${artifact}`);
		}
	}
	await verifyUnpacked(version);
	await verifyDeb(debPath, version);
	await verifyTar(tarPath, version);

	const artifacts = [debPath, tarPath];
	const tarHash = await sha256File(tarPath);
	// SHA256SUMS é gerado antes do makepkg: o PKGBUILD lê daqui um hash
	// confiável do dist-linux em vez de calcular o checksum da própria fonte.
	await writeChecksums(artifacts);
	const archPackage = await buildArchPackage(version, tarPath, tarHash);
	if (archPackage) artifacts.push(archPackage);

	const sumsPath = await writeChecksums(artifacts);
	console.log("Pacotes Linux gerados:");
	for (const artifact of artifacts) {
		const info = await stat(artifact);
		const hash = await sha256File(artifact);
		console.log(`  ${artifact} (${formatBytes(info.size)}) sha256=${hash}`);
	}
	console.log(`SHA256SUMS: ${sumsPath}`);

	if (process.argv.includes("--clean") || process.argv.includes("--clean-bun")) {
		await cleanIntermediates();
	}
}

await main();
