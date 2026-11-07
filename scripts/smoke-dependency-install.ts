/**
 * Smoke real das dependências opcionais Git e Node.js.
 *
 * Baixa os artefatos oficiais (MinGit fixado e Node LTS resolvido no
 * `index.json` oficial), confere SHA-256, extrai em um perfil TEMPORÁRIO
 * (`%LOCALAPPDATA%` dentro de `os.tmpdir()`) e prova em processos novos que
 * `git`, `node` e `npm` funcionam apenas com o PATH que o aplicativo monta.
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
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	OptionalDependencyInstaller,
	optionalDependencyBinDirs,
	resolveDependencyToolsRoot,
} from "../src/main/dependency-install";
import type { DependencyInstallProgress } from "../src/shared/dependency-install-types";

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
const originalPath = process.env.PATH;
const root = await mkdtemp(path.join(tmpdir(), "omp-deps-smoke-"));
const home = path.join(root, "home");
const localAppData = path.join(home, "AppData", "Local");
const windowsPath = "C:\\Windows\\System32;C:\\Windows";
const env: NodeJS.ProcessEnv = {
	...process.env,
	USERPROFILE: home,
	HOME: home,
	APPDATA: path.join(home, "AppData", "Roaming"),
	LOCALAPPDATA: localAppData,
	PATH: windowsPath,
};
delete env.Path;

const phases: Record<string, string[]> = { git: [], node: [] };
let exitCode = 0;
try {
	const installer = new OptionalDependencyInstaller({
		env,
		platform: "win32",
		arch: process.arch,
		log: (level, event, fields) => {
			console.log(JSON.stringify({ level, event, ...fields }));
		},
	});
	const record = (kind: string, progress: DependencyInstallProgress) => {
		const list = phases[kind];
		if (list && list[list.length - 1] !== progress.phase) list.push(progress.phase);
	};

	const [git, node] = await Promise.all([
		installer.install("git", { onProgress: (progress) => record("git", progress) }),
		installer.install("node", { onProgress: (progress) => record("node", progress) }),
	]);

	const toolsRoot = resolveDependencyToolsRoot(env);
	const binDirs = optionalDependencyBinDirs(env);
	const appPath = [...binDirs, windowsPath].join(path.delimiter);
	const appEnv: NodeJS.ProcessEnv = { ...env, PATH: appPath };

	const gitVersion = await run(git.executablePath, ["--version"], appEnv);
	const nodeVersion = await run(node.executablePath, ["--version"], appEnv);
	const npmVersion = await run("cmd.exe", ["/d", "/s", "/c", "npm --version"], appEnv);
	const where = await run(
		"cmd.exe",
		["/d", "/s", "/c", "where git.exe && where node.exe && where npm.cmd"],
		appEnv,
	);

	const repo = path.join(root, "repo");
	await mkdir(repo, { recursive: true });
	await writeFile(path.join(repo, "probe.txt"), "smoke\n");
	const gitInit = await run(git.executablePath, ["init", repo], appEnv);
	const gitStatus = await run(git.executablePath, ["-C", repo, "status", "--porcelain"], appEnv);
	const gitAdd = await run(git.executablePath, ["-C", repo, "add", "probe.txt"], appEnv);
	const gitDiff = await run(git.executablePath, ["-C", repo, "diff", "--cached", "--stat"], appEnv);
	const gitCommit = await run(
		git.executablePath,
		["-C", repo, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "smoke"],
		appEnv,
	);

	const gitStat = await stat(git.executablePath);
	const nodeStat = await stat(node.executablePath);
	const npmPath = path.join(path.dirname(node.executablePath), "npm.cmd");
	const npmStat = await stat(npmPath);
	const leftoverTemps = (await readdir(toolsRoot)).filter((name) => name.startsWith(".tmp-"));
	const processPathUnchanged = process.env.PATH === originalPath;

	const ok =
		gitVersion.code === 0 &&
		gitVersion.stdout.includes("2.56.0") &&
		nodeVersion.code === 0 &&
		nodeVersion.stdout.trim() === "v26.13.0" &&
		npmVersion.code === 0 &&
		npmVersion.stdout.trim().length > 0 &&
		where.code === 0 &&
		gitInit.code === 0 &&
		gitStatus.stdout.includes("?? probe.txt") &&
		gitAdd.code === 0 &&
		gitDiff.code === 0 &&
		gitCommit.code === 0 &&
		leftoverTemps.length === 0 &&
		processPathUnchanged;

	console.log(
		JSON.stringify(
			{
				ok,
				root,
				toolsRoot,
				binDirs,
				appPath,
				git: {
					executablePath: git.executablePath,
					version: gitVersion.stdout.trim(),
					normalizedVersion: git.version,
					sha256: await sha256File(git.executablePath),
					bytes: gitStat.size,
					phases: phases.git,
				},
				node: {
					executablePath: node.executablePath,
					version: nodeVersion.stdout.trim(),
					normalizedVersion: node.version,
					npmVersion: npmVersion.stdout.trim(),
					sha256: await sha256File(node.executablePath),
					npmSha256: await sha256File(npmPath),
					bytes: nodeStat.size,
					npmBytes: npmStat.size,
					phases: phases.node,
				},
				pathResolution: where.stdout.trim().split(/\r?\n/),
				gitPanel: {
					init: gitInit.code,
					status: gitStatus.stdout.trim(),
					add: gitAdd.code,
					diff: gitDiff.stdout.trim(),
					commit: gitCommit.code,
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
