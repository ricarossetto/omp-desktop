/**
 * Cliente do host Bun: spawn com argv (sem shell), JSONL sobre stdin/stdout,
 * correlação de requests por id, backpressure, rejeição de pendências na saída
 * e logs de stderr redigidos.
 *
 * Não importa Electron; testes injetam um processo falso.
 */
import { spawn } from "node:child_process";
import type { DesktopEvent } from "../shared/contracts";
import {
	captureProcessIdentity,
	isProcessRunning,
	killProcessTree,
	type ProcessIdentity,
} from "./process-tree";

export class HostClientError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HostClientError";
	}
}

export interface HostProcessLike {
	pid?: number;
	stdin: {
		write(chunk: string): boolean;
		end(): void;
		on(event: "drain", listener: () => void): unknown;
		destroy?(): void;
	} | null;
	stdout: {
		on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
	} | null;
	stderr: {
		on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
	} | null;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
}

export type HostSpawn = (command: string, args: string[], options: Record<string, unknown>) => HostProcessLike;

export interface HostClientOptions {
	bunPath: string;
	hostScript: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	onEvent(event: DesktopEvent): void;
	onExit(info: { code: number | null; signal: string | null; stderr: string }): void;
	onSpawnError?(error: Error): void;
	log?(level: "info" | "warn" | "error", message: string): void;
	spawnImpl?: HostSpawn;
	/** Timeout padrão de request ao host; 0 desliga. */
	requestTimeoutMs?: number;
	maxLineBytes?: number;
}

interface PendingRequest {
	op: string;
	resolve(data: unknown): void;
	reject(error: HostClientError): void;
	timer?: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Descobre se a op é sensível para nunca aparecer em log.
 * A decisão é conservadora: só nomes claramente de credencial são omitidos.
 */
const SECRET_ENV_NAMES = /(token|secret|password|passwd|credential|api[_-]?key)/i;

/**
 * Variáveis repassadas ao host. Mantém o necessário para o perfil OMP
 * (USERPROFILE/APPDATA), rede e credenciais de provedores, e corta o resto
 * do ambiente do Electron.
 */
const ENV_KEEP = new Set(
	[
		"PATH",
		"SystemRoot",
		"SystemDrive",
		"windir",
		"ComSpec",
		"PATHEXT",
		"USERPROFILE",
		"USERNAME",
		"USERDOMAIN",
		"COMPUTERNAME",
		"OS",
		"HOMEDRIVE",
		"HOMEPATH",
		"APPDATA",
		"LOCALAPPDATA",
		"TEMP",
		"TMP",
		"ProgramFiles",
		"ProgramFiles(x86)",
		"ProgramW6432",
		"ProgramData",
		"HOME",
		"LANG",
		"LC_ALL",
		"TERM",
		"TZ",
		"NUMBER_OF_PROCESSORS",
		"PROCESSOR_ARCHITECTURE",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
		"http_proxy",
		"https_proxy",
		"no_proxy",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_BASE_URL",
		"OPENAI_API_KEY",
		"OPENAI_BASE_URL",
		"OPENAI_ORG_ID",
		"GOOGLE_API_KEY",
		"GEMINI_API_KEY",
		"OPENROUTER_API_KEY",
		"GROQ_API_KEY",
		"XAI_API_KEY",
		"MISTRAL_API_KEY",
		"DEEPSEEK_API_KEY",
		"AZURE_OPENAI_API_KEY",
		"AZURE_OPENAI_ENDPOINT",
		"AWS_PROFILE",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"OLLAMA_HOST",
		"NO_COLOR",
		"FORCE_COLOR",
	].map((name) => name.toLowerCase()),
);

export function buildHostEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	const seen = new Set<string>();
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		const lower = key.toLowerCase();
		const isOmp = lower.startsWith("omp_") && !SECRET_ENV_NAMES.test(lower);
		const isTestFixture = base.OMP_DESKTOP_TEST === "1" && lower.startsWith("fake_omp_");
		if (!ENV_KEEP.has(lower) && !isOmp && !isTestFixture) continue;
		if (seen.has(lower)) continue;
		seen.add(lower);
		env[key] = value;
	}
	return env;
}

/** Redige tokens, headers e códigos OAuth em uma linha de log. */
export function redactLogLine(line: string): string {
	let out = line;
	out = out.replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[removido]");
	out = out.replace(
		/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
		"$1[removido]",
	);
	out = out.replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[removido]");
	out = out.replace(/([?&](?:code|access_token|refresh_token|id_token)=)[^&\s]+/gi, "$1[removido]");
	out = out.replace(/([A-Za-z]:\\Users\\)[^\\\s]+/gi, "$1[usuario]");
	if (out.length > 2000) out = `${out.slice(0, 2000)}…`;
	return out;
}

export interface DiscardedLine {
	/** Bytes da linha descartada, contados sem bufferizar o conteúdo inteiro. */
	bytes: number;
	/** Início da linha (limitado) para correlação e log. */
	prefix: string;
}

/** Quanto do início de uma linha grande é guardado para extrair o id da resposta. */
const DISCARD_PREFIX_BYTES = 8 * 1024;

/**
 * Decodifica bytes em linhas JSONL preservando UTF-8 cortado entre chunks.
 *
 * Linha acima do limite não lança erro nem encerra o host: é descartada até o
 * próximo `\n`, com memória limitada, e o restante do fluxo continua legível.
 */
export class JsonlLineDecoder {
	private parts: Buffer[] = [];
	private size = 0;
	private discarding = false;
	private discardedBytes = 0;
	private discardPrefixParts: Buffer[] = [];
	private discardPrefixSize = 0;
	private readonly discarded: DiscardedLine[] = [];
	private readonly maxLineBytes: number;

	constructor(maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
		this.maxLineBytes = maxLineBytes;
	}

	push(chunk: Buffer | string): string[] {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		const lines: string[] = [];
		let offset = 0;
		while (offset < buffer.length) {
			if (this.discarding) {
				const newline = buffer.indexOf(0x0a, offset);
				if (newline < 0) {
					this.noteDiscarded(buffer.subarray(offset));
					break;
				}
				this.noteDiscarded(buffer.subarray(offset, newline));
				this.finishDiscard();
				offset = newline + 1;
				continue;
			}
			const newline = buffer.indexOf(0x0a, offset);
			const end = newline < 0 ? buffer.length : newline;
			const segment = buffer.subarray(offset, end);
			if (this.size + segment.length > this.maxLineBytes) {
				this.beginDiscard(segment);
				if (newline < 0) break;
				this.finishDiscard();
				offset = newline + 1;
				continue;
			}
			if (segment.length > 0) {
				this.parts.push(segment);
				this.size += segment.length;
			}
			if (newline < 0) break;
			lines.push(this.takeLine());
			offset = newline + 1;
		}
		return lines;
	}

	private takeLine(): string {
		let line: Buffer;
		if (this.parts.length === 0) line = Buffer.alloc(0);
		else if (this.parts.length === 1) line = this.parts[0] as Buffer;
		else line = Buffer.concat(this.parts, this.size);
		this.parts = [];
		this.size = 0;
		if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
		return line.toString("utf8");
	}

	private beginDiscard(segment: Buffer): void {
		this.discarding = true;
		this.discardedBytes = this.size + segment.length;
		this.discardPrefixParts = [];
		this.discardPrefixSize = 0;
		for (const part of this.parts) this.capturePrefix(part);
		this.parts = [];
		this.size = 0;
		this.capturePrefix(segment);
	}

	private noteDiscarded(segment: Buffer): void {
		this.discardedBytes += segment.length;
		this.capturePrefix(segment);
	}

	private capturePrefix(segment: Buffer): void {
		if (segment.length === 0 || this.discardPrefixSize >= DISCARD_PREFIX_BYTES) return;
		const take = Math.min(segment.length, DISCARD_PREFIX_BYTES - this.discardPrefixSize);
		// Cópia limitada: o chunk original pode ser liberado sem reter a linha toda.
		this.discardPrefixParts.push(Buffer.from(segment.subarray(0, take)));
		this.discardPrefixSize += take;
	}

	private finishDiscard(): void {
		const prefix =
			this.discardPrefixParts.length > 0
				? Buffer.concat(this.discardPrefixParts, this.discardPrefixSize)
				: Buffer.alloc(0);
		this.discarded.push({ bytes: this.discardedBytes, prefix: prefix.toString("utf8") });
		this.discarding = false;
		this.discardedBytes = 0;
		this.discardPrefixParts = [];
		this.discardPrefixSize = 0;
	}

	/** Linhas grandes descartadas desde a última chamada. */
	takeDiscarded(): DiscardedLine[] {
		return this.discarded.splice(0, this.discarded.length);
	}

	get pendingBytes(): number {
		return this.size;
	}
}

function isDesktopEvent(value: unknown): value is DesktopEvent {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		record.kind === "event" &&
		typeof record.name === "string" &&
		typeof record.workspaceId === "string" &&
		typeof record.generation === "number" &&
		typeof record.sequence === "number"
	);
}

export class HostClient {
	private child: HostProcessLike | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly decoder: JsonlLineDecoder;
	private readonly stderrTail: string[] = [];
	private requestCounter = 0;
	private writeQueue: string[] = [];
	private writeBlocked = false;
	private closing = false;
	private exitHandled = false;
	private exitWaiters: Array<() => void> = [];
	private drainListenerAttached = false;
	private readonly opts: HostClientOptions;
	private readonly requestTimeoutMs: number;
	private readonly maxLineBytes: number;
	private identityPromise: Promise<ProcessIdentity> | null = null;

	constructor(options: HostClientOptions) {
		this.opts = options;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
		this.decoder = new JsonlLineDecoder(this.maxLineBytes);
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get running(): boolean {
		return this.child !== null && !this.exitHandled;
	}

	async start(): Promise<void> {
		if (this.child) throw new HostClientError("INVALID_REQUEST", "O host já foi iniciado.");
		this.exitHandled = false;
		this.closing = false;
		const spawnImpl = this.opts.spawnImpl ?? (spawn as unknown as HostSpawn);
		let child: HostProcessLike;
		try {
			child = spawnImpl(this.opts.bunPath, [this.opts.hostScript], {
				cwd: this.opts.cwd,
				env: this.opts.env ?? buildHostEnv(),
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
				detached: false,
			});
		} catch (error) {
			throw new HostClientError(
				"HOST_EXITED",
				`Não foi possível iniciar o serviço local: ${(error as Error).message}`,
			);
		}
		this.child = child;
		this.log("info", `host iniciado (pid ${child.pid ?? "?"})`);
		this.identityPromise = child.pid
			? captureProcessIdentity(child.pid, this.opts.bunPath)
			: null;
		child.stdout?.on("data", (chunk) => this.handleStdout(chunk));
		child.stderr?.on("data", (chunk) => this.handleStderr(chunk));
		child.on("exit", (code, signal) => this.handleExit(code, signal));
		child.on("error", (error) => {
			this.log("error", `falha no host: ${error.message}`);
			this.opts.onSpawnError?.(error);
			this.handleExit(null, null, error);
		});
	}

	private handleStdout(chunk: Buffer | string): void {
		let lines: string[];
		try {
			lines = this.decoder.push(chunk);
		} catch (error) {
			// Defesa para um erro inesperado do decodificador: o host continua vivo
			// e a próxima linha válida volta a ser lida.
			this.log("error", `falha ao decodificar saída do host: ${(error as Error).message}`);
			return;
		}
		this.rejectDiscardedResponses();
		for (const raw of lines) {
			const line = raw.trim();
			if (line.length === 0) continue;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				this.log("warn", "linha inválida recebida do host (ignorada)");
				continue;
			}
			if (typeof message !== "object" || message === null) continue;
			const record = message as Record<string, unknown>;
			if (record.kind === "response" && typeof record.id === "string") {
				this.settle(record);
				continue;
			}
			if (isDesktopEvent(message)) {
				try {
					this.opts.onEvent(message);
				} catch (error) {
					this.log("error", `falha ao processar evento do host: ${(error as Error).message}`);
				}
				continue;
			}
			this.log("warn", "mensagem desconhecida recebida do host (ignorada)");
		}
	}

	/**
	 * Descarta a linha grande sem derrubar o host. Se o prefixo ainda identifica
	 * a resposta de uma request pendente, só aquela request falha com
	 * `FRAME_TOO_LARGE`; as demais continuam e o parser segue no próximo `\n`.
	 */
	private rejectDiscardedResponses(): void {
		for (const dropped of this.decoder.takeDiscarded()) {
			const message = `O host enviou uma linha de ${dropped.bytes} bytes acima do limite de ${this.maxLineBytes} bytes.`;
			this.log("error", `resposta descartada: ${message}`);
			if (!/^\s*\{\s*"kind"\s*:\s*"response"/.test(dropped.prefix)) continue;
			const id = /"id"\s*:\s*"([A-Za-z0-9._:-]{1,64})"/.exec(dropped.prefix)?.[1];
			if (!id) continue;
			const entry = this.pending.get(id);
			if (!entry) continue;
			this.pending.delete(id);
			clearTimeout(entry.timer);
			entry.reject(new HostClientError("FRAME_TOO_LARGE", message));
		}
	}

	private settle(record: Record<string, unknown>): void {
		const entry = this.pending.get(record.id as string);
		if (!entry) {
			this.log("warn", `resposta sem solicitante (${String(record.id)})`);
			return;
		}
		this.pending.delete(record.id as string);
		clearTimeout(entry.timer);
		if (record.ok === true) {
			entry.resolve(record.data);
			return;
		}
		const error = (record.error ?? {}) as Record<string, unknown>;
		entry.reject(
			new HostClientError(
				typeof error.code === "string" ? error.code : "INTERNAL",
				typeof error.message === "string" && error.message.length > 0
					? error.message
					: "O serviço local recusou a operação.",
			),
		);
	}

	private handleStderr(chunk: Buffer | string): void {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		for (const raw of text.split(/\r?\n/)) {
			if (raw.trim().length === 0) continue;
			const redacted = redactLogLine(raw);
			this.stderrTail.push(redacted);
			while (this.stderrTail.length > 20) this.stderrTail.shift();
			this.log("warn", `host stderr: ${redacted}`);
		}
	}

	private handleExit(code: number | null, signal: string | null, causedBy?: Error): void {
		if (this.exitHandled) return;
		this.exitHandled = true;
		const stderr = this.stderrTail.join("\n");
		this.child = null;
		this.writeBlocked = false;
		this.writeQueue = [];
		const suffix = causedBy
			? causedBy.message
			: code ?? signal
				? `código ${code ?? "?"}${signal ? `, sinal ${signal}` : ""}`
				: "sem código";
		this.failAll(
			new HostClientError(
				"HOST_EXITED",
				`O serviço local encerrou (${suffix}).${stderr.length > 0 ? ` Detalhe: ${stderr.slice(-500)}` : ""}`,
			),
		);
		const waiters = this.exitWaiters;
		this.exitWaiters = [];
		for (const resolve of waiters) resolve();
		this.opts.onExit({ code, signal, stderr });
	}

	private failAll(error: HostClientError): void {
		for (const [id, entry] of this.pending) {
			this.pending.delete(id);
			clearTimeout(entry.timer);
			entry.reject(error);
		}
	}

	request<T = unknown>(op: string, payload: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
		if (!this.child || this.exitHandled || this.closing) {
			return Promise.reject(
				new HostClientError("HOST_EXITED", "O serviço local não está em execução. Reabra o aplicativo."),
			);
		}
		let serialized: string;
		try {
			serialized = JSON.stringify({ kind: "request", id: `h${++this.requestCounter}`, op, payload });
		} catch (error) {
			return Promise.reject(
				new HostClientError("INVALID_REQUEST", `Não foi possível serializar o pedido: ${(error as Error).message}`),
			);
		}
		const id = `h${this.requestCounter}`;
		const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
		return new Promise<T>((resolve, reject) => {
			const entry: PendingRequest = {
				op,
				resolve: (data) => resolve(data as T),
				reject,
			};
			if (timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					if (!this.pending.delete(id)) return;
					reject(
						new HostClientError(
							"INTERNAL",
							`O serviço local não respondeu a "${op}" em ${Math.round(timeoutMs / 1000)} s.`,
						),
					);
				}, timeoutMs);
			}
			this.pending.set(id, entry);
			this.queueWrite(`${serialized}\n`);
		});
	}

	private queueWrite(line: string): void {
		if (!this.child?.stdin || this.writeBlocked) {
			this.writeQueue.push(line);
			return;
		}
		try {
			const ok = this.child.stdin.write(line);
			if (!ok) this.setWriteBlocked(true);
		} catch (error) {
			this.log("error", `falha ao escrever no host: ${(error as Error).message}`);
			this.handleExit(null, null, error as Error);
		}
	}

	private setWriteBlocked(blocked: boolean): void {
		this.writeBlocked = blocked;
		if (!blocked || !this.child?.stdin || this.drainListenerAttached) return;
		this.drainListenerAttached = true;
		this.child.stdin.on("drain", () => {
			this.drainListenerAttached = false;
			this.writeBlocked = false;
			this.flushWrites();
		});
	}

	private flushWrites(): void {
		while (!this.writeBlocked && this.writeQueue.length > 0 && this.child?.stdin) {
			const next = this.writeQueue.shift() as string;
			try {
				const ok = this.child.stdin.write(next);
				if (!ok) this.setWriteBlocked(true);
			} catch (error) {
				this.log("error", `falha ao escrever no host: ${(error as Error).message}`);
				this.handleExit(null, null, error as Error);
				return;
			}
		}
	}

	/**
	 * Encerra a árvore somente depois de confirmar que o PID ainda é o processo
	 * iniciado neste cliente. A identidade é capturada logo após o spawn.
	 */
	private async killOwnedProcess(pid: number): Promise<void> {
		const identity = this.identityPromise
			? await this.identityPromise
			: { pid, startedAt: Date.now() };
		await killProcessTree(identity.pid === pid ? identity : pid);
	}

	/**
	 * Encerra o host: fecha stdin, espera a saída até `timeoutMs` e, se preciso,
	 * encerra somente a árvore do PID que este cliente iniciou.
	 */
	async close(timeoutMs = 10_000): Promise<void> {
		if (!this.child) return;
		this.closing = true;
		const child = this.child;
		this.failAll(new HostClientError("HOST_EXITED", "O serviço local foi encerrado pelo aplicativo."));
		const exit = Promise.withResolvers<void>();
		this.exitWaiters.push(exit.resolve);
		try {
			child.stdin?.end();
		} catch {
			/* stdin já fechado */
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = await Promise.race([
			exit.promise.then(() => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(true), timeoutMs);
			}),
		]);
		clearTimeout(timer);
		if (timedOut && this.child && !this.exitHandled) {
			this.log("warn", "host não saiu a tempo; encerrando a árvore do processo");
			if (child.pid) await this.killOwnedProcess(child.pid);
			if (isProcessRunning(child.pid ?? 0)) {
				try {
					child.kill("SIGKILL");
				} catch {
					/* já encerrado */
				}
			}
			let forceTimer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				exit.promise,
				new Promise<void>((resolve) => {
					forceTimer = setTimeout(resolve, 3000);
				}),
			]);
			clearTimeout(forceTimer);
		}
	}

	private log(level: "info" | "warn" | "error", message: string): void {
		this.opts.log?.(level, message);
	}
}
