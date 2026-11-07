/**
 * Execução e encerramento de árvores de processos que o aplicativo iniciou.
 * Nunca procura processos por nome; sempre usa o PID concreto.
 *
 * Antes de encerrar, a identidade do processo é conferida com dados do sistema
 * operacional (hora de criação e/ou nome do executável). Isso evita que um PID
 * reciclado depois da saída do processo original seja encerrado por engano.
 *
 * Limite conhecido: a conferência depende de PowerShell/CIM (Windows) ou da
 * existência do PID (demais sistemas). Se o sistema não permitir consultar a
 * criação do processo, encerrar apenas por PID fica recusado; o chamador deve
 * manter o diagnóstico e o processo pode continuar ativo.
 */
import { execFile } from "node:child_process";
import * as path from "node:path";

/** Intervalo tolerado entre a criação informada pelo SO e a observada. */
const CREATION_TIME_TOLERANCE_MS = 2000;
/** Limite defensivo para não varrer árvores absurdas. */
const MAX_TREE_PROCESSES = 512;
/** Deslocamento entre FILETIME (1601-01-01) e a época Unix em milissegundos. */
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000;

export interface ProcessIdentity {
	pid: number;
	/** Instante local em que o aplicativo iniciou o processo (epoch ms). */
	startedAt: number;
	/** Nome do executável iniciado, normalizado (sem caminho e sem .exe). */
	executableName?: string;
	/** Hora de criação informada pelo sistema operacional (epoch ms). */
	creationTimeMs?: number;
}

interface ProcessDetails {
	exists: boolean;
	creationTimeMs?: number;
	name?: string;
}

interface CommandResult {
	code: number;
	stdout: string;
}

function isValidPid(pid: number): boolean {
	return Number.isInteger(pid) && pid > 0;
}

function normalizeExecutableName(value: string): string {
	const base = path.basename(value.trim());
	return base.replace(/\.exe$/i, "").toLowerCase();
}

function powershellPath(): string {
	const root = process.env.SystemRoot ?? process.env.windir;
	if (root) return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return "powershell.exe";
}

function runCommand(file: string, args: string[], timeoutMs = 10_000): Promise<CommandResult> {
	const { promise, resolve } = Promise.withResolvers<CommandResult>();
	try {
		execFile(
			file,
			args,
			{ windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
			(error, stdout) => {
				const code =
					error && typeof (error as NodeJS.ErrnoException).code === "number"
						? ((error as NodeJS.ErrnoException).code as unknown as number)
						: error
							? -1
							: 0;
				resolve({ code, stdout: stdout ?? "" });
			},
		);
	} catch {
		resolve({ code: -1, stdout: "" });
	}
	return promise;
}

/** FILETIME (100 ns desde 1601) para epoch em milissegundos. */
export function fileTimeToEpochMs(fileTime: number): number | undefined {
	if (!Number.isFinite(fileTime) || fileTime <= 0) return undefined;
	return Math.round(fileTime / 10_000 - WINDOWS_EPOCH_OFFSET_MS);
}

async function windowsProcessDetails(pid: number): Promise<ProcessDetails | undefined> {
	const script = [
		`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
		"if ($null -ne $p) {",
		"  $t = ''",
		"  try { $t = $p.StartTime.ToFileTimeUtc() } catch { }",
		'  Write-Output ("{0}|{1}" -f $t, $p.ProcessName)',
		"}",
	].join("\n");
	const byPowerShell = await runCommand(powershellPath(), [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		script,
	]);
	if (byPowerShell.code === 0) {
		const line = byPowerShell.stdout
			.split(/\r?\n/)
			.map((value) => value.trim())
			.find((value) => value.length > 0);
		if (!line) return { exists: false };
		const [rawTime, rawName] = line.split("|");
		const name = rawName?.trim();
		return {
			exists: true,
			creationTimeMs: fileTimeToEpochMs(Number(rawTime)),
			name: name && name.length > 0 ? name : undefined,
		};
	}
	// Fallback sem data de criação: só o nome confirma a identidade.
	const listed = await runCommand("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
	if (listed.code !== 0) return undefined;
	const text = listed.stdout.trim();
	if (text.length === 0 || text.startsWith("INFO:")) return { exists: false };
	const name = /^"([^"]+)"/.exec(text)?.[1];
	return name ? { exists: true, name } : undefined;
}

async function readProcessDetails(pid: number): Promise<ProcessDetails | undefined> {
	if (!isValidPid(pid)) return { exists: false };
	if (process.platform === "win32") return await windowsProcessDetails(pid);
	return { exists: isProcessRunning(pid) };
}

/** Captura a identidade logo após o spawn, enquanto o PID ainda é o original. */
export async function captureProcessIdentity(
	pid: number,
	executablePath?: string,
): Promise<ProcessIdentity> {
	const identity: ProcessIdentity = {
		pid,
		startedAt: Date.now(),
		executableName: executablePath ? normalizeExecutableName(executablePath) : undefined,
	};
	if (!isValidPid(pid)) return identity;
	const details = await readProcessDetails(pid).catch(() => undefined);
	if (details?.exists) {
		if (details.creationTimeMs !== undefined) identity.creationTimeMs = details.creationTimeMs;
		if (!identity.executableName && details.name) {
			identity.executableName = normalizeExecutableName(details.name);
		}
	}
	return identity;
}

async function matchesIdentity(identity: ProcessIdentity): Promise<boolean> {
	if (!isValidPid(identity.pid)) return false;
	// Fora do Windows não há consulta de hora de criação sem interferir no
	// processo; a existência do PID é o limite documentado.
	if (process.platform !== "win32") return isProcessRunning(identity.pid);
	const details = await readProcessDetails(identity.pid);
	if (details === undefined) return false;
	if (!details.exists) return false;
	if (identity.creationTimeMs !== undefined && details.creationTimeMs !== undefined) {
		return Math.abs(details.creationTimeMs - identity.creationTimeMs) <= CREATION_TIME_TOLERANCE_MS;
	}
	if (identity.executableName && details.name) {
		return normalizeExecutableName(details.name) === identity.executableName;
	}
	// identidade só com PID (chamadas antigas): exige ao menos que ele exista.
	return identity.creationTimeMs === undefined && identity.executableName === undefined;
}

async function listWindowsDescendants(rootPid: number): Promise<number[]> {
	const script =
		'Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
	const result = await runCommand(
		powershellPath(),
		["-NoProfile", "-NonInteractive", "-Command", script],
		15_000,
	);
	if (result.code !== 0) return [];
	return parseDescendants(rootPid, result.stdout);
}

async function listPosixDescendants(rootPid: number): Promise<number[]> {
	const result = await runCommand("ps", ["-A", "-o", "pid=,ppid="], 5000);
	if (result.code !== 0) return [];
	return parseDescendants(rootPid, result.stdout);
}

/** Converte "pid ppid" por linha em descendentes, do mais profundo ao mais raso. */
export function parseDescendants(rootPid: number, output: string): number[] {
	const children = new Map<number, number[]>();
	for (const line of output.split(/\r?\n/)) {
		const [pidText, parentText] = line.trim().split(/\s+/);
		const pid = Number(pidText);
		const parent = Number(parentText);
		if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
		if (pid <= 0 || parent <= 0 || pid === parent) continue;
		const list = children.get(parent);
		if (list) list.push(pid);
		else children.set(parent, [pid]);
	}
	const ordered: Array<{ pid: number; depth: number }> = [];
	const queue = (children.get(rootPid) ?? []).map((pid) => ({ pid, depth: 1 }));
	for (let index = 0; index < queue.length && ordered.length < MAX_TREE_PROCESSES; index += 1) {
		const item = queue[index] as { pid: number; depth: number };
		ordered.push(item);
		for (const child of children.get(item.pid) ?? []) {
			if (ordered.length + queue.length >= MAX_TREE_PROCESSES) break;
			queue.push({ pid: child, depth: item.depth + 1 });
		}
	}
	return ordered.sort((left, right) => right.depth - left.depth).map((item) => item.pid);
}

async function killWindowsTree(identity: ProcessIdentity, force: boolean): Promise<boolean> {
	const forceFlag = force ? ["/F"] : [];
	// Filhos primeiro: se o pai sair antes, a árvore pode ser reparentada e
	// escapar do taskkill /T.
	const descendants = await listWindowsDescendants(identity.pid);
	for (const pid of descendants) {
		await runCommand("taskkill.exe", ["/T", ...forceFlag, "/PID", String(pid)]);
	}
	// O pai pode ter saído durante a limpeza dos filhos; nesse caso não há mais
	// nada a encerrar. Se o PID ainda existe mas não é mais o processo iniciado,
	// ele foi reciclado e não deve receber taskkill.
	if (!(await matchesIdentity(identity))) return !isProcessRunning(identity.pid);
	const result = await runCommand("taskkill.exe", [
		"/T",
		...forceFlag,
		"/PID",
		String(identity.pid),
	]);
	return result.code === 0 || !isProcessRunning(identity.pid);
}

async function killPosixTree(identity: ProcessIdentity, force: boolean): Promise<boolean> {
	const signal = force ? "SIGKILL" : "SIGTERM";
	const descendants = await listPosixDescendants(identity.pid);
	for (const pid of descendants) {
		try {
			process.kill(pid, signal);
		} catch {
			/* filho já saiu */
		}
	}
	if (!(await matchesIdentity(identity))) return true;
	try {
		process.kill(identity.pid, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Encerra a árvore do processo iniciado pelo app. Aceita a identidade capturada
 * no spawn; um número cru é aceito apenas por compatibilidade e exige que o PID
 * ainda exista. Retorna `false` quando o processo não pôde ser confirmado como
 * sendo ainda o original (nenhum sinal é enviado nesse caso).
 */
export async function killProcessTree(
	target: ProcessIdentity | number,
	force = true,
): Promise<boolean> {
	const identity: ProcessIdentity =
		typeof target === "number" ? { pid: target, startedAt: Date.now() } : target;
	if (!isValidPid(identity.pid)) return false;
	if (!(await matchesIdentity(identity))) return false;
	if (process.platform === "win32") return await killWindowsTree(identity, force);
	return await killPosixTree(identity, force);
}

/** `true` quando o PID ainda existe (sem enviar sinal). */
export function isProcessRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM = existe mas sem permissão de sinal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
