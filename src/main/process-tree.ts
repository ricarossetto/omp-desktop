/**
 * Execução e encerramento de árvores de processos que o aplicativo iniciou.
 * Nunca procura processos por nome; sempre usa o PID concreto.
 *
 * Antes de encerrar, a identidade do processo é conferida com dados do sistema
 * operacional (hora de criação e/ou nome do executável). Isso evita que um PID
 * reciclado depois da saída do processo original seja encerrado por engano.
 *
 * - Windows: PowerShell/CIM (hora de criação) e tasklist como fallback.
 * - Linux: `/proc/<pid>/stat` (hora de criação desde o boot e grupo) e
 *   `/proc/<pid>/exe`/`comm` (nome). A árvore é lida de `/proc`, sem depender
 *   de `ps`; quando o grupo do processo é o próprio PID (spawn `detached`), o
 *   grupo inteiro recebe o sinal.
 * - Demais POSIX: a existência do PID é o limite documentado.
 *
 * Se o sistema não permitir consultar a identidade, encerrar fica recusado; o
 * chamador deve manter o diagnóstico e o processo pode continuar ativo.
 */
import { execFile } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import * as path from "node:path";

/** Intervalo tolerado entre a criação informada pelo SO e a observada. */
const CREATION_TIME_TOLERANCE_MS = 2000;
/** Limite defensivo para não varrer árvores absurdas. */
const MAX_TREE_PROCESSES = 512;
/** Deslocamento entre FILETIME (1601-01-01) e a época Unix em milissegundos. */
const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000;
/**
 * USER_HZ do Linux em x86_64/arm64. `/proc/<pid>/stat` mede `starttime` nessa
 * unidade; 100 é o valor fixo dessas arquiteturas (não é o HZ do kernel).
 */
const LINUX_CLOCK_TICKS = 100;

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
	/** Grupo de processos do Linux (`pgrp`); igual ao PID quando é líder. */
	processGroupId?: number;
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
	// `/proc/<pid>/exe` acrescenta " (deleted)" quando o binário foi removido.
	return base.replace(/\s+\(deleted\)$/i, "").replace(/\.exe$/i, "").toLowerCase();
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

let linuxBootTimeMs: Promise<number | undefined> | null = null;

/** Hora do boot em epoch ms (`btime` de `/proc/stat`), uma vez por processo. */
function readLinuxBootTimeMs(): Promise<number | undefined> {
	if (!linuxBootTimeMs) {
		linuxBootTimeMs = readFile("/proc/stat", "utf8")
			.then((text) => {
				const match = /^btime\s+(\d+)/m.exec(text);
				return match ? Number(match[1]) * 1000 : undefined;
			})
			.catch(() => undefined);
	}
	return linuxBootTimeMs;
}

/**
 * Campos de `/proc/<pid>/stat` depois do `comm` (o nome pode conter `)` e
 * espaços, por isso o corte é no último `)`):
 *   [0] state (campo 3), [1] ppid (4), [2] pgrp (5), ... [19] starttime (22).
 */
function parseLinuxStat(text: string): { ppid?: number; pgrp?: number; startTicks?: number } {
	const close = text.lastIndexOf(")");
	if (close < 0) return {};
	const fields = text.slice(close + 1).trim().split(/\s+/);
	const ppid = Number(fields[1]);
	const pgrp = Number(fields[2]);
	const startTicks = Number(fields[19]);
	return {
		ppid: Number.isInteger(ppid) ? ppid : undefined,
		pgrp: Number.isInteger(pgrp) ? pgrp : undefined,
		startTicks: Number.isFinite(startTicks) ? startTicks : undefined,
	};
}

async function readLinuxProcessDetails(pid: number): Promise<ProcessDetails | undefined> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const parsed = parseLinuxStat(stat);
		let creationTimeMs: number | undefined;
		if (parsed.startTicks !== undefined) {
			const boot = await readLinuxBootTimeMs();
			if (boot !== undefined) {
				creationTimeMs = boot + Math.round((parsed.startTicks * 1000) / LINUX_CLOCK_TICKS);
			}
		}
		let name: string | undefined;
		try {
			name = path.basename(await readlink(`/proc/${pid}/exe`));
		} catch {
			try {
				name = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
			} catch {
				/* processo saiu durante a leitura */
			}
		}
		return {
			exists: true,
			creationTimeMs,
			name: name && name.length > 0 ? name : undefined,
			processGroupId: parsed.pgrp,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
		// /proc indisponível: a existência ainda pode ser confirmada por sinal 0.
		return { exists: isProcessRunning(pid) };
	}
}

async function readProcessDetails(pid: number): Promise<ProcessDetails | undefined> {
	if (!isValidPid(pid)) return { exists: false };
	if (process.platform === "win32") return await windowsProcessDetails(pid);
	if (process.platform === "linux") return await readLinuxProcessDetails(pid);
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

/**
 * Confere uma identidade contra um snapshot do SO. No Linux a hora de criação
 * (`starttime`) é obrigatória: nome de executável sozinho não distingue um PID
 * reciclado. No Windows a criação é preferida e o nome é o fallback histórico.
 */
function identityMatchesDetails(identity: ProcessIdentity, details: ProcessDetails | undefined): boolean {
	if (!details?.exists) return false;
	if (process.platform === "linux") {
		if (identity.creationTimeMs === undefined || details.creationTimeMs === undefined) return false;
		return Math.abs(details.creationTimeMs - identity.creationTimeMs) <= CREATION_TIME_TOLERANCE_MS;
	}
	if (identity.creationTimeMs !== undefined && details.creationTimeMs !== undefined) {
		return Math.abs(details.creationTimeMs - identity.creationTimeMs) <= CREATION_TIME_TOLERANCE_MS;
	}
	if (identity.executableName && details.name) {
		return normalizeExecutableName(details.name) === identity.executableName;
	}
	return false;
}

async function matchesIdentity(identity: ProcessIdentity): Promise<boolean> {
	if (!isValidPid(identity.pid)) return false;
	return identityMatchesDetails(identity, await readProcessDetails(identity.pid));
}

/** Confere PID + hora de criação capturados na varredura antes de sinalizar. */
async function matchesPidCreation(pid: number, creationTimeMs: number | undefined): Promise<boolean> {
	if (creationTimeMs === undefined) return false;
	const details = await readProcessDetails(pid).catch(() => undefined);
	return identityMatchesDetails({ pid, startedAt: 0, creationTimeMs }, details);
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

interface DescendantDetails {
	pid: number;
	/** Hora de criação observada na varredura; ausente = não sinalizar. */
	creationTimeMs?: number;
}

async function listPosixDescendants(rootPid: number): Promise<DescendantDetails[]> {
	if (process.platform === "linux") {
		let entries: string[];
		try {
			entries = await readdir("/proc");
		} catch {
			return await listPosixDescendantsPs(rootPid);
		}
		const boot = await readLinuxBootTimeMs();
		const pairs: Array<[number, number]> = [];
		const creationTimes = new Map<number, number | undefined>();
		for (const entry of entries) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				const stat = await readFile(`/proc/${entry}/stat`, "utf8");
				const parsed = parseLinuxStat(stat);
				if (parsed.ppid === undefined) continue;
				const pid = Number(entry);
				pairs.push([pid, parsed.ppid]);
				creationTimes.set(
					pid,
					boot !== undefined && parsed.startTicks !== undefined
						? boot + Math.round((parsed.startTicks * 1000) / LINUX_CLOCK_TICKS)
						: undefined,
				);
			} catch {
				/* processo saiu enquanto a lista era montada */
			}
		}
		return descendantsFromPairs(rootPid, pairs).map((pid) => ({
			pid,
			creationTimeMs: creationTimes.get(pid),
		}));
	}
	return await listPosixDescendantsPs(rootPid);
}

async function listPosixDescendantsPs(rootPid: number): Promise<DescendantDetails[]> {
	const result = await runCommand("ps", ["-A", "-o", "pid=,ppid="], 5000);
	if (result.code !== 0) return [];
	// `ps` não informa a criação; os filhos não são sinalizados sem identidade.
	return parseDescendants(rootPid, result.stdout).map((pid) => ({ pid }));
}

/** Converte "pid ppid" por linha em descendentes, do mais profundo ao mais raso. */
export function parseDescendants(rootPid: number, output: string): number[] {
	const pairs: Array<[number, number]> = [];
	for (const line of output.split(/\r?\n/)) {
		const [pidText, parentText] = line.trim().split(/\s+/);
		const pid = Number(pidText);
		const parent = Number(parentText);
		if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
		pairs.push([pid, parent]);
	}
	return descendantsFromPairs(rootPid, pairs);
}

function descendantsFromPairs(rootPid: number, pairs: Array<[number, number]>): number[] {
	const children = new Map<number, number[]>();
	for (const [pid, parent] of pairs) {
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
	// Caminho rápido: `taskkill /T` encerra a árvore numa única chamada. A
	// varredura de descendentes (PowerShell/CIM, lenta em runners frios) fica
	// como fallback para quando a raiz sobrevive — por exemplo, um filho
	// reparentado durante a saída. A identidade já foi conferida em
	// `killProcessTree` imediatamente antes desta chamada.
	const direct = await runCommand("taskkill.exe", [
		"/T",
		...forceFlag,
		"/PID",
		String(identity.pid),
	]);
	if (direct.code === 0 || !isProcessRunning(identity.pid)) return true;
	// Fallback: filhos primeiro, depois a raiz, reconferindo a identidade
	// depois da varredura para não sinalizar um PID reciclado.
	const descendants = await listWindowsDescendants(identity.pid);
	for (const pid of descendants) {
		await runCommand("taskkill.exe", ["/T", ...forceFlag, "/PID", String(pid)]);
	}
	const stillOurs = await matchesIdentity(identity);
	if (!stillOurs) return !isProcessRunning(identity.pid);
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
	// A raiz pode ter saído/reutilizado entre a checagem inicial e a varredura;
	// sem ela, os "descendentes" seriam de outro processo.
	if (!(await matchesIdentity(identity))) return false;
	const descendants = await listPosixDescendants(identity.pid);
	if (!(await matchesIdentity(identity))) return false;
	for (const child of descendants) {
		// A varredura pode ter visto um PID que saiu e foi reutilizado antes do
		// sinal; confere a criação capturada imediatamente antes de cada kill.
		if (!(await matchesPidCreation(child.pid, child.creationTimeMs))) continue;
		try {
			process.kill(child.pid, signal);
		} catch {
			/* filho já saiu */
		}
	}
	const details = await readProcessDetails(identity.pid).catch(() => undefined);
	if (!identityMatchesDetails(identity, details)) return true;
	// Spawn `detached` no POSIX torna o filho líder do próprio grupo; nesse
	// caso o grupo inteiro é sinalizado, cobrindo processos reparentados. A
	// identidade foi reconferida no snapshot imediatamente acima.
	if (details?.processGroupId === identity.pid) {
		try {
			process.kill(-identity.pid, signal);
			return true;
		} catch {
			/* cai para o sinal individual */
		}
	}
	try {
		process.kill(identity.pid, signal);
		return true;
	} catch {
		return !isProcessRunning(identity.pid);
	}
}

/**
 * Encerra a árvore do processo iniciado pelo app. Exige a identidade capturada
 * no spawn (PID + hora de criação no Linux). Um número cru nunca encerra nada:
 * sem identidade não há como distinguir o processo original de um PID
 * reutilizado. Retorna `false` quando nenhum sinal foi enviado.
 */
export async function killProcessTree(
	target: ProcessIdentity | number,
	force = true,
): Promise<boolean> {
	if (typeof target === "number") return false;
	const identity = target;
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
