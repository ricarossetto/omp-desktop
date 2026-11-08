/**
 * Smoke real das dependências opcionais Git e Node.js.
 *
 * Windows: baixa MinGit fixado e Node LTS ZIP, confere SHA-256, extrai em um
 * perfil TEMPORÁRIO e prova `git`, `node` e `npm` com o PATH do aplicativo.
 *
 * Linux: NÃO baixa MinGit; prova que `install("git")` retorna
 * MANUAL_INSTALL_REQUIRED, baixa o Node LTS `linux-x64` TAR.GZ oficial,
 * confere SHASUMS256, extrai com os symlinks `bin/npm`/`bin/npx` e prova
 * `node`/`npm` em processos novos. O Git nativo do PATH é reportado, mas
 * continua opcional.
 *
 * Nunca usa o HOME/perfil do dono da máquina. O diretório temporário só é
 * removido depois de imprimir as versões e os hashes dos binários instalados.
 *
 * Uso:
 *   bun scripts/smoke-dependency-install.ts          # instala, prova e limpa
 *   bun scripts/smoke-dependency-install.ts --keep   # mantém e imprime o root
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	DependencyInstallError,
	OptionalDependencyInstaller,
	optionalDependencyBinDirs,
	resolveDependencyToolsRoot,
} from "../src/main/dependency-install";
import type {
	DependencyInstallProgress,
	DependencyInstallResult,
} from "../src/shared/dependency-install-types";

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	execFile(
		file,
		args,
		{
			env,
			timeout: 120_000,
			windowsHide: true,
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		},
		(error, stdout, stderr) => {
			resolve({
				code: error && typeof error.code === "number" ? error.code : error ? -1 : 0,
				stdout: stdout ?? "",
				stderr: stderr ?? "",
			});
		},
	);
	return promise;
}

async function sha256File(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk as Buffer);
	}
	return hash.digest("hex").toLowerCase();
}

const keep = process.argv.includes("--keep");
const platform = process.platform;
const originalPath = process.env.PATH;
const root = await mkdtemp(path.join(tmpdir(), "omp-deps-smoke-"));
const home = path.join(root, "home");
const systemPath = platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin";
const env: NodeJS.ProcessEnv =
	platform === "win32"
		? {
				...process.env,
				USERPROFILE: home,
				HOME: home,
				APPDATA: path.join(home, "AppData", "Roaming"),
				LOCALAPPDATA: path.join(home, "AppData", "Local"),
				PATH: systemPath,
			}
		: {
				...process.env,
				HOME: home,
				XDG_DATA_HOME: path.join(home, ".local", "share"),
				XDG_CONFIG_HOME: path.join(home, ".config"),
				PATH: systemPath,
			};
delete env.Path;

const phases: Record<string, string[]> = { git: [], node: [] };
let exitCode = 0;
try {
	const installer = new OptionalDependencyInstaller({
		env,
		platform,
		arch: process.arch,
		log: (level, event, fields) => {
			console.log(JSON.stringify({ level, event, ...fields }));
		},
	});
	const record = (kind: string, progress: DependencyInstallProgress) => {
		const list = phases[kind];
		if (list && list[list.length - 1] !== progress.phase) list.push(progress.phase);
	};

	let git: DependencyInstallResult | undefined;
	let gitManualCode: string | undefined;
	const nodePromise = installer.install("node", {
		onProgress: (progress) => record("node", progress),
	});
	if (platform === "win32") {
		git = await installer.install("git", {
			onProgress: (progress) => record("git", progress),
		});
	} else {
		try {
			await installer.install("git");
		} catch (error) {
			gitManualCode = error instanceof DependencyInstallError ? error.code : "UNKNOWN";
		}
	}
	const node = await nodePromise;

	const toolsRoot = resolveDependencyToolsRoot(env, platform);
	const binDirs = optionalDependencyBinDirs(env, platform);
	const appPath = [...binDirs, systemPath].join(path.delimiter);
	const appEnv: NodeJS.ProcessEnv = { ...env, PATH: appPath };

	const nodeVersion = await run(node.executablePath, ["--version"], appEnv);
	const npmPath =
		platform === "win32"
			? path.join(path.dirname(node.executablePath), "npm.cmd")
			: path.join(path.dirname(node.executablePath), "npm");
	const npmVersion = await run(npmPath, ["--version"], appEnv);
	const nodeViaPath = await run("node", ["--version"], appEnv);
	const npmViaPath = await run("npm", ["--version"], appEnv);
	const gitVersion = await run(git?.executablePath ?? "git", ["--version"], appEnv);

	let gitPanel: Record<string, unknown> = { available: false };
	if (gitVersion.code === 0) {
		const repo = path.join(root, "repo");
		await mkdir(repo, { recursive: true });
		await writeFile(path.join(repo, "probe.txt"), "smoke\n");
		const gitExecutable = git?.executablePath ?? "git";
		const gitInit = await run(gitExecutable, ["init", repo], appEnv);
		const gitStatus = await run(gitExecutable, ["-C", repo, "status", "--porcelain"], appEnv);
		const gitAdd = await run(gitExecutable, ["-C", repo, "add", "probe.txt"], appEnv);
		const gitDiff = await run(gitExecutable, ["-C", repo, "diff", "--cached", "--stat"], appEnv);
		const gitCommit = await run(
			gitExecutable,
			["-C", repo, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "smoke"],
			appEnv,
		);
		gitPanel = {
			available: true,
			init: gitInit.code,
			status: gitStatus.stdout.trim(),
			add: gitAdd.code,
			diff: gitDiff.stdout.trim(),
			diffCode: gitDiff.code,
			commit: gitCommit.code,
		};
	}

	const nodeStat = await stat(node.executablePath);
	const npmStat = await stat(npmPath);
	const npmLink = platform === "win32" ? undefined : (await lstat(npmPath)).isSymbolicLink();
	const leftoverTemps = (await readdir(toolsRoot)).filter((name) => name.startsWith(".tmp-"));
	const processPathUnchanged = process.env.PATH === originalPath;
	const nodeMode = nodeStat.mode & 0o777;
	const nodeExecutable = platform === "win32" || (nodeStat.mode & 0o111) !== 0;

	const gitOk =
		platform === "win32"
			? gitVersion.code === 0 &&
				gitVersion.stdout.includes("2.56.0") &&
				gitPanel.available === true &&
				gitPanel.init === 0 &&
				String(gitPanel.status).includes("?? probe.txt") &&
				gitPanel.add === 0 &&
				gitPanel.diffCode === 0 &&
				gitPanel.commit === 0
			: gitManualCode === "MANUAL_INSTALL_REQUIRED";

	const ok =
		nodeVersion.code === 0 &&
		nodeVersion.stdout.trim() === "v26.13.0" &&
		npmVersion.code === 0 &&
		npmVersion.stdout.trim().length > 0 &&
		nodeViaPath.code === 0 &&
		npmViaPath.code === 0 &&
		nodeExecutable &&
		(platform === "win32" || npmLink === true) &&
		gitOk &&
		leftoverTemps.length === 0 &&
		processPathUnchanged;

	console.log(
		JSON.stringify(
			{
				ok,
				platform,
				root,
				toolsRoot,
				binDirs,
				appPath,
				git: {
					executablePath: git?.executablePath ?? "git",
					version: gitVersion.stdout.trim(),
					normalizedVersion: git?.version,
					manualCode: gitManualCode,
					sha256: git ? await sha256File(git.executablePath) : undefined,
					phases: phases.git,
					panel: gitPanel,
				},
				node: {
					executablePath: node.executablePath,
					version: nodeVersion.stdout.trim(),
					normalizedVersion: node.version,
					npmVersion: npmVersion.stdout.trim(),
					npmPath,
					npmSymlink: npmLink,
					sha256: await sha256File(node.executablePath),
					npmSha256: await sha256File(npmPath),
					bytes: nodeStat.size,
					npmBytes: npmStat.size,
					mode: `0o${nodeMode.toString(8)}`,
					phases: phases.node,
				},
				pathResolution: {
					node: nodeViaPath.stdout.trim(),
					npm: npmViaPath.stdout.trim(),
				},
				leftoverTemps,
				processPathUnchanged,
			},
			null,
			2,
		),
	);
	if (!ok) exitCode = 1;
} catch (error) {
	exitCode = 1;
	console.error(
		JSON.stringify({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		}),
	);
} finally {
	if (keep) {
		console.log(`[keep] ${root}`);
	} else {
		await rm(root, { recursive: true, force: true });
	}
}
process.exitCode = exitCode;
