/**
 * Smoke real da instalação do OMP pelo instalador do aplicativo.
 *
 * Baixa o binário oficial fixado (18.16.0) do serviço de builds usado pelo
 * instalador Windows do OMP, confere o SHA-256, executa `--version` e imprime
 * o caminho resultante. Usa um perfil temporário (USERPROFILE/HOME/APPDATA/
 * LOCALAPPDATA) para nunca tocar o `~/.omp` do dono da máquina.
 *
 * Uso:
 *   bun scripts/smoke-omp-install.ts          # instala, verifica e limpa
 *   bun scripts/smoke-omp-install.ts --keep   # mantém o diretório e imprime o caminho
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { OmpInstaller, OMP_INSTALL_VERSION, ompInstallTarget } from "../src/main/omp-install";
import { RuntimeResolver } from "../src/main/runtime";

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(file, args, { env, timeout: 60_000, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
			resolve({
				code: error && typeof error.code === "number" ? error.code : error ? -1 : 0,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			});
		});
	});
}

const keep = process.argv.includes("--keep");
const platform = process.platform;
const root = await mkdtemp(path.join(tmpdir(), "omp-install-smoke-"));
const home = path.join(root, "home");
const installDir = path.join(root, "bin");
const env: NodeJS.ProcessEnv = {
	...process.env,
	USERPROFILE: home,
	HOME: home,
	APPDATA: path.join(home, "AppData", "Roaming"),
	LOCALAPPDATA: path.join(home, "AppData", "Local"),
	XDG_CONFIG_HOME: path.join(home, ".config"),
	XDG_DATA_HOME: path.join(home, ".local", "share"),
	PI_INSTALL_DIR: installDir,
};

try {
	const resolver = new RuntimeResolver({
		userDataDir: path.join(root, "userdata"),
		appPath: process.cwd(),
		resourcesPath: process.cwd(),
		isPackaged: false,
		execPath: process.execPath,
		env,
	});
	let lastPhase = "";
	const installer = new OmpInstaller({
		installDir,
		version: OMP_INSTALL_VERSION,
		target: ompInstallTarget(process.arch, platform),
		probe: (ompPath, options) => resolver.probeOmpPath(ompPath, options),
		onProgress: (progress) => {
			if (progress.phase !== lastPhase) {
				lastPhase = progress.phase;
				console.log(`[fase] ${progress.phase}`);
			}
		},
	});
	const result = await installer.install();
	const info = await stat(result.ompPath);
	const verified = await run(result.ompPath, ["--version"], env);
	// PATH sem o diretório do Bun: o binário standalone precisa funcionar
	// sozinho numa máquina limpa (o app já usa o Bun empacotado para o host).
	const standaloneEnv = {
		...env,
		PATH: platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin",
	};
	const standalone = await run(result.ompPath, ["--version"], standaloneEnv);
	const executable = platform === "win32" || (info.mode & 0o111) !== 0;
	console.log(
		JSON.stringify(
			{
				ok:
					verified.code === 0 &&
					verified.stdout.includes(result.ompVersion) &&
					standalone.code === 0 &&
					standalone.stdout.includes(result.ompVersion) &&
					executable,
				platform,
				installDir: result.installDir,
				ompPath: result.ompPath,
				ompVersion: result.ompVersion,
				downloaded: result.downloaded,
				bytes: info.size,
				mode: `0o${(info.mode & 0o777).toString(8)}`,
				versionOutput: verified.stdout.trim(),
				versionStderr: verified.stderr.trim(),
				standaloneWithoutBun: standalone.stdout.trim(),
				standaloneStderr: standalone.stderr.trim(),
			},
			null,
			2,
		),
	);
	if (verified.code !== 0 || standalone.code !== 0 || !executable) process.exitCode = 1;
	if (keep) {
		console.log(`[keep] ${root}`);
	} else {
		await rm(root, { recursive: true, force: true });
	}
} catch (error) {
	console.error(error);
	process.exitCode = 1;
	if (!keep) await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
