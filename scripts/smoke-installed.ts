/**
 * Smoke do aplicativo INSTALADO (fora do checkout).
 *
 * Uso:
 *   bun scripts/smoke-installed.ts --exe "C:\\...\\OMP Desktop.exe" --cwd "C:\\fixture"
 *
 * - Usa userData temporário (--user-data-dir).
 * - Remove o Bun global do PATH para provar que o Bun empacotado inicia o host.
 * - Aponta OMP_DESKTOP_OMP_PATH para o OMP real e espera o relatório
 *   `--smoke-report` gravado pelo main quando janela + host estão prontos.
 * - Fecha o aplicativo e confirma que nenhum PID iniciado por ele continua vivo.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

interface SmokeReport {
	ok?: boolean;
	phase?: string;
	windowLoaded?: boolean;
	hostStarted?: boolean;
	hostReady?: boolean;
	message?: string | null;
	ompPath?: string | null;
	bunPath?: string | null;
	appPath?: string;
	userDataDir?: string;
	pids?: { electron?: number; host?: number | null; terminals?: number[] };
}

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let index = 0; index < argv.length; index += 1) {
		const current = argv[index];
		if (!current.startsWith("--")) continue;
		const eq = current.indexOf("=");
		if (eq > 0) {
			out[current.slice(2, eq)] = current.slice(eq + 1);
			continue;
		}
		const key = current.slice(2);
		const next = argv[index + 1];
		if (next && !next.startsWith("--")) {
			out[key] = next;
			index += 1;
		} else {
			out[key] = "true";
		}
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const exe = args.exe;
const cwd = args.cwd;
const timeoutMs = Number(args.timeout ?? 180_000);
if (!exe || !cwd) {
	console.error('Uso: bun scripts/smoke-installed.ts --exe "<executável instalado>" --cwd "<workspace>"');
	process.exit(2);
}

const exePath = path.resolve(exe);
await stat(exePath).catch(() => {
	console.error(`Executável não encontrado: ${exePath}`);
	process.exit(2);
});
const workspace = path.resolve(cwd);
const workspaceInfo = await stat(workspace).catch(() => null);
if (!workspaceInfo?.isDirectory()) {
	console.error(`Workspace inválido: ${workspace}`);
	process.exit(2);
}

const userDataDir = await mkdtemp(path.join(tmpdir(), "omp-desktop-smoke-"));
const reportPath = path.join(userDataDir, "smoke-report.json");

function pathWithoutBun(): string {
	const bunDir = path.dirname(process.execPath).toLowerCase();
	const entries = (process.env.PATH ?? "").split(path.delimiter);
	const filtered = entries.filter((entry) => {
		if (!entry) return false;
		const normalized = path.resolve(entry).toLowerCase();
		return normalized !== bunDir && !normalized.endsWith(`${path.sep}.bun${path.sep}bin`);
	});
	return filtered.join(path.delimiter);
}

const ompOnPath = Bun.which("omp") ?? Bun.which("omp.exe");
const env: Record<string, string | undefined> = {
	...process.env,
	// --com-bun-global mantém o Bun no PATH (necessário ao shim do OMP); o padrão prova o Bun empacotado.
	PATH: args["com-bun-global"] === "true" ? process.env.PATH : pathWithoutBun(),
	OMP_DESKTOP_OMP_PATH: ompOnPath ?? process.env.OMP_DESKTOP_OMP_PATH,
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processRunning(pid: number | null | undefined): Promise<boolean> {
	if (!pid || !Number.isInteger(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function taskkill(pid: number, force: boolean): Promise<void> {
	const task = Bun.spawn(["taskkill", "/PID", String(pid), ...(force ? ["/T", "/F"] : [])], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	await task.exited.catch(() => undefined);
}

console.log(`Smoke instalado: ${exePath}`);
console.log(`Workspace: ${workspace}`);
console.log(`userData temporário: ${userDataDir}`);
console.log(`OMP: ${ompOnPath ?? "(descoberta do aplicativo)"}`);
const appProcess = Bun.spawn(
	[
		exePath,
		`--user-data-dir=${userDataDir}`,
		`--cwd=${workspace}`,
		`--smoke-report=${reportPath}`,
	],
	{
		cwd: workspace,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: false,
	},
);

const stderrChunks: Buffer[] = [];
void (async () => {
	const stream = appProcess.stderr;
	if (!stream) return;
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) stderrChunks.push(Buffer.from(value));
		}
	} catch {
		/* stream encerrado */
	}
})();

let report: SmokeReport | null = null;
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
	try {
		const raw = await readFile(reportPath, "utf8");
		report = JSON.parse(raw) as SmokeReport;
		break;
	} catch {
		/* aguardando o relatório */
	}
	await sleep(300);
}

if (!report) {
	console.error(`O aplicativo não gravou o relatório de smoke em ${timeoutMs} ms.`);
	const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
	if (stderr) console.error(`stderr do aplicativo:\n${stderr.slice(-3000)}`);
	await taskkill(appProcess.pid, true);
	process.exit(1);
}

console.log("Relatório:", JSON.stringify(report, null, 2));
const bundledBunRoot = path.dirname(exePath).toLowerCase();
const usesBundledBun = (report.bunPath ?? "").toLowerCase().startsWith(bundledBunRoot);
// Sem Bun global no PATH o shim do OMP não roda; nesse modo basta o host subir com o Bun empacotado.
const stripMode = args["com-bun-global"] !== "true";
const ok = stripMode
	? report.windowLoaded === true && report.hostStarted === true && report.hostReady === true && usesBundledBun
	: report.ok === true && report.phase === "ready" && report.windowLoaded === true && report.hostStarted === true;
if (!ok) {
	console.error("O aplicativo não chegou ao estado pronto.");
	if (report.message) console.error(`Mensagem: ${report.message}`);
	await taskkill(appProcess.pid, true);
	process.exit(1);
}

console.log("Encerrando o aplicativo (WM_CLOSE)...");
await taskkill(appProcess.pid, false);
const exitDeadline = Date.now() + 12_000;
let exited = false;
while (Date.now() < exitDeadline) {
	if (appProcess.exitCode !== null) {
		exited = true;
		break;
	}
	if (!(await processRunning(appProcess.pid))) {
		exited = true;
		break;
	}
	await sleep(250);
}
let graceful = exited;
if (!exited) {
	console.log("O aplicativo não encerrou sozinho; encerrando a árvore do PID iniciado pelo smoke.");
	await taskkill(appProcess.pid, true);
}
await Promise.race([appProcess.exited.catch(() => undefined), sleep(5000)]);

const pids = [report.pids?.electron, report.pids?.host, ...(report.pids?.terminals ?? [])].filter(
	(pid): pid is number => typeof pid === "number",
);
let lingering: number[] = [];
const cleanupDeadline = Date.now() + 5000;
do {
	lingering = [];
	for (const pid of pids) {
		if (await processRunning(pid)) lingering.push(pid);
	}
	if (lingering.length === 0) break;
	await sleep(250);
} while (Date.now() < cleanupDeadline);
if (lingering.length > 0) {
	console.error(`Processos do aplicativo continuam ativos após o fechamento: ${lingering.join(", ")}`);
	for (const pid of lingering) await taskkill(pid, true);
	graceful = false;
}
if (!graceful) {
	console.error("O aplicativo não fechou de forma limpa; o smoke falhou.");
	process.exit(1);
}

if (args.keep !== "true") {
	await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
}
console.log("Smoke instalado: OK (janela, host e encerramento sem processos pendentes).");
