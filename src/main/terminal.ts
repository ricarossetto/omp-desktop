/**
 * Gerenciador de PTYs do terminal do usuário (separado da ferramenta bash do
 * agente). Cada terminal pertence a um workspace autorizado e a uma janela.
 * Ao fechar, encerra somente a árvore do PID do PTY que este app iniciou.
 */
import type { IPty } from "@lydell/node-pty";
import { captureProcessIdentity, killProcessTree, type ProcessIdentity } from "./process-tree";

export interface PtySpawnOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	cols?: number;
	rows?: number;
	name?: string;
	encoding?: string | null;
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => IPty;

export interface TerminalInfo {
	terminalId: string;
	workspaceId: string;
	cwd: string;
	pid: number;
	shell: string;
	ownerId: number;
}

export interface TerminalManagerOptions {
	onData(info: TerminalInfo, data: string): void;
	onExit(info: TerminalInfo, exitCode: number): void;
	log?(level: "info" | "warn" | "error", message: string): void;
	spawnImpl?: PtySpawn;
}

interface TerminalEntry {
	info: TerminalInfo;
	pty: IPty;
	identity: Promise<ProcessIdentity>;
	dataSubscription: { dispose(): void };
	exitSubscription: { dispose(): void };
	exitEmitted: boolean;
}

let cachedSpawn: Promise<PtySpawn> | null = null;

async function loadDefaultSpawn(): Promise<PtySpawn> {
	if (!cachedSpawn) {
		cachedSpawn = import("@lydell/node-pty").then((module) => module.spawn as PtySpawn);
	}
	try {
		return await cachedSpawn;
	} catch (error) {
		cachedSpawn = null;
		throw new Error(`O terminal nativo não pôde ser carregado: ${(error as Error).message}`);
	}
}

export interface CreateTerminalInput {
	workspaceId: string;
	cwd: string;
	ownerId: number;
	shellPath: string;
	cols?: number;
	rows?: number;
}

export class TerminalManager {
	private readonly entries = new Map<string, TerminalEntry>();
	private readonly opts: TerminalManagerOptions;
	private counter = 0;

	constructor(options: TerminalManagerOptions) {
		this.opts = options;
	}

	async create(input: CreateTerminalInput): Promise<TerminalInfo> {
		const spawn = this.opts.spawnImpl ?? (await loadDefaultSpawn());
		const terminalId = `terminal-${++this.counter}`;
		const shell = input.shellPath || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
		const isPowerShell = /(?:^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(shell);
		const args = isPowerShell ? ["-NoLogo"] : [];
		const pty = spawn(shell, args, {
			name: "xterm-256color",
			cwd: input.cwd,
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
			cols: input.cols ?? 120,
			rows: input.rows ?? 30,
			encoding: "utf8",
		});
		const info: TerminalInfo = {
			terminalId,
			workspaceId: input.workspaceId,
			cwd: input.cwd,
			pid: pty.pid,
			shell,
			ownerId: input.ownerId,
		};
		const entry: TerminalEntry = {
			info,
			pty,
			identity: captureProcessIdentity(pty.pid, shell),
			exitEmitted: false,
			dataSubscription: { dispose: () => undefined },
			exitSubscription: { dispose: () => undefined },
		};
		entry.dataSubscription = pty.onData((data) => {
			this.opts.onData(info, data);
		});
		entry.exitSubscription = pty.onExit(({ exitCode }) => {
			if (entry.exitEmitted) return;
			entry.exitEmitted = true;
			this.entries.delete(terminalId);
			entry.dataSubscription.dispose();
			entry.exitSubscription.dispose();
			this.opts.onExit(info, exitCode);
		});
		this.entries.set(terminalId, entry);
		this.log("info", `terminal ${terminalId} criado (pid ${pty.pid})`);
		return info;
	}

	get(terminalId: string): TerminalInfo | undefined {
		return this.entries.get(terminalId)?.info;
	}

	/** Verifica existência e (quando informado) o workspace dono do terminal. */
	owns(terminalId: string, workspaceId?: string): boolean {
		const info = this.entries.get(terminalId)?.info;
		if (!info) return false;
		return workspaceId === undefined || info.workspaceId === workspaceId;
	}

	list(): TerminalInfo[] {
		return [...this.entries.values()].map((entry) => entry.info);
	}

	hasActive(): boolean {
		return this.entries.size > 0;
	}

	write(terminalId: string, data: string): boolean {
		const entry = this.entries.get(terminalId);
		if (!entry) return false;
		entry.pty.write(data);
		return true;
	}

	resize(terminalId: string, cols: number, rows: number): boolean {
		const entry = this.entries.get(terminalId);
		if (!entry) return false;
		entry.pty.resize(cols, rows);
		return true;
	}

	/** Encerra a árvore do PTY e, por último, o processo pai. */
	async close(terminalId: string): Promise<boolean> {
		const entry = this.entries.get(terminalId);
		if (!entry) return false;
		this.entries.delete(terminalId);
		// Filhos primeiro, com identidade conferida; o pty.kill fecha o handle do
		// processo pai que este app criou.
		await killProcessTree(await entry.identity);
		try {
			entry.pty.kill();
		} catch {
			/* já encerrado */
		}
		entry.dataSubscription.dispose();
		entry.exitSubscription.dispose();
		this.log("info", `terminal ${terminalId} encerrado`);
		return true;
	}

	/** Encerra todos os terminais (shutdown). Não encerra processos de terceiros. */
	async closeAll(): Promise<void> {
		const ids = [...this.entries.keys()];
		await Promise.all(ids.map((id) => this.close(id)));
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		this.opts.log?.(level, message);
	}
}

/** Árvore de PIDs do app, usada no relatório de shutdown/smoke. */
export function terminalPids(manager: TerminalManager): number[] {
	return manager.list().map((info) => info.pid);
}
