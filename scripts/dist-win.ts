/**
 * Gera o instalador NSIS x64 do OMP Desktop.
 *
 * Pré-requisitos: `bun run build` concluído (out/main, out/preload, out/renderer,
 * out/host) e dependências instaladas. Copia o Bun do processo atual para
 * `.cache/bun/bun.exe`, remove esse diretório do PATH do build e delega ao
 * electron-builder. Não publica nem assina.
 */
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { createBuilderConfig } from "../electron-builder.config";

const root = path.resolve(import.meta.dir, "..");
const config = createBuilderConfig("win32");

async function assertBuilt(relative: string): Promise<void> {
	try {
		const info = await stat(path.join(root, relative));
		if (!info.isFile() || info.size === 0) throw new Error("vazio");
	} catch {
		console.error(`Artefato ausente: ${relative}. Execute "bun run build" antes de "bun run dist:win".`);
		process.exit(1);
	}
}

async function main(): Promise<void> {
	await assertBuilt("out/main/index.js");
	await assertBuilt("out/preload/index.cjs");
	await assertBuilt("out/renderer/index.html");
	await assertBuilt("out/host/index.js");
	await assertBuilt("resources/icon.ico");

	const bunExe = process.execPath;
	if (!/bun(\.exe)?$/i.test(path.basename(bunExe))) {
		console.error("O script precisa rodar com Bun (process.execPath não é bun.exe).");
		process.exit(1);
	}
	const cacheDir = path.join(root, ".cache", "bun");
	await mkdir(cacheDir, { recursive: true });
	const bundledBun = path.join(cacheDir, "bun.exe");
	await copyFile(bunExe, bundledBun);
	const bunInfo = await stat(bundledBun);
	if (bunInfo.size < 1_000_000) {
		console.error("A cópia do Bun empacotado parece inválida.");
		process.exit(1);
	}

	const generatedConfig = path.join(root, ".cache", "electron-builder.json");
	await writeFile(generatedConfig, `${JSON.stringify(config, null, 2)}\n`, "utf8");

	const cli = path.join(root, "node_modules", "electron-builder", "cli.js");
	try {
		await stat(cli);
	} catch {
		console.error("electron-builder não está instalado. Execute bun install.");
		process.exit(1);
	}

	const nodePath = Bun.which("node");
	const executable = nodePath ?? process.execPath;
	// `--publish never`: sem feed de atualizacao, o build nunca deve tentar publicar
	// (o electron-builder ativa publicacao implicita quando detecta CI).
	const args = [cli, "--win", "nsis", "--x64", "--publish", "never", "--config", generatedConfig];
	console.log(`Executando electron-builder com ${path.basename(executable)}...`);
	const child = Bun.spawn([executable, ...args], {
		cwd: root,
		env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
		stdio: ["inherit", "inherit", "inherit"],
	});
	const code = await child.exited;
	if (code !== 0) {
		console.error(`electron-builder falhou (código ${code}).`);
		process.exit(code);
	}

	const releaseDir = path.join(root, "release");
	const entries = await readdir(releaseDir).catch(() => [] as string[]);
	const installers = entries.filter((entry) => /\.exe$/i.test(entry));
	if (installers.length === 0) {
		console.error("O build terminou sem gerar um instalador .exe em release/.");
		process.exit(1);
	}
	console.log("Instalador gerado:");
	for (const installer of installers) {
		const info = await stat(path.join(releaseDir, installer));
		console.log(`  ${path.join(releaseDir, installer)} (${(info.size / (1024 * 1024)).toFixed(1)} MB, não assinado)`);
	}
}

await main();
