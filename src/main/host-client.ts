/**
 * Cliente do host Bun: spawn com argv (sem shell), JSONL sobre stdin/stdout,
 * correlação de requests por id, remontagem de mensagens fragmentadas,
 * backpressure, rejeição de pendências na saída e logs de stderr redigidos.
 *
 * Não importa Electron; testes injetam um processo falso.
 */
import { spawn } from "node:child_process";
import type { DesktopEvent } from "../shared/contracts";
import {
	HOST_CHUNK_KIND,
	HostChunkAssembler,
	parseHostChunkFrame,
	type AssembledHostChunk,
	type HostChunkEventMeta,
	type HostChunkFailure,
	type HostChunkFrame,
} from "../shared/host-wire";
import {
	captureProcessIdentity,
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
	/** Timeout padrão de request ao host; também é o deadline de streams de evento fragmentados; 0 desliga. */
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
 * (USERPROFILE/APPDATA no Windows; HOME/XDG no Linux), rede, sessão gráfica
 * (DISPLAY/Wayland/DBus para ferramentas que abrem janelas) e credenciais de
 * provedores, e corta o resto do ambiente do Electron.
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
		"USER",
		"LOGNAME",
		"SHELL",
		"TMPDIR",
		"XDG_DATA_HOME",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_STATE_HOME",
		"XDG_RUNTIME_DIR",
		"XDG_SESSION_TYPE",
		"DISPLAY",
		"WAYLAND_DISPLAY",
		"DBUS_SESSION_BUS_ADDRESS",
		"SSH_AUTH_SOCK",
		"SSH_AGENT_PID",
		"XAUTHORITY",
		"LANG",
		"LANGUAGE",
		"LC_ALL",
		"LC_CTYPE",
		"LC_MESSAGES",
		"LC_NUMERIC",
		"LC_TIME",
		"LC_COLLATE",
		"LC_MONETARY",
		"LC_PAPER",
		"LC_NAME",
		"LC_ADDRESS",
		"LC_TELEPHONE",
		"LC_MEASUREMENT",
		"LC_IDENTIFICATION",
		"TERM",
		"COLORTERM",
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
	out = out.replace(/(\/(?:home|Users)\/)[^/\s]+/g, "$1[usuario]");
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

	/** Limpa estado parcial entre processos do host. */
	reset(): void {
		this.parts = [];
		this.size = 0;
		this.discarding = false;
		this.discardedBytes = 0;
		this.discardPrefixParts = [];
		this.discardPrefixSize = 0;
		this.discarded.length = 0;
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

function sameEventIdentity(meta: HostChunkEventMeta, event: DesktopEvent): boolean {
	return (
		event.workspaceId === meta.workspaceId &&
		event.sessionId === meta.sessionId &&
		event.generation === meta.generation &&
		event.sequence === meta.sequence &&
		event.name === meta.name
	);
}

/**
 * Extrai a identidade do evento do prefixo de um frame descartado. O envelope
 * coloca `event` antes de `data`, então os campos cabem no prefixo limitado do
 * decoder mesmo quando a linha inteira foi descartada.
 */
function parseEventPrefix(prefix: string): HostChunkEventMeta | undefined {
	const start = prefix.indexOf('"event":');
	if (start < 0) return undefined;
	const slice = prefix.slice(start);
	const workspaceId = /"workspaceId"\s*:\s*"([^"\\]{1,256})"/.exec(slice)?.[1];
	const sessionId = /"sessionId"\s*:\s*"([^"\\]{1,256})"/.exec(slice)?.[1];
	const generation = Number(/"generation"\s*:\s*(-?\d+)/.exec(slice)?.[1]);
	const sequence = Number(/"sequence"\s*:\s*(-?\d+)/.exec(slice)?.[1]);
	const name = /"name"\s*:\s*"([^"\\]{1,256})"/.exec(slice)?.[1];
	if (!workspaceId || !name || !Number.isFinite(generation) || !Number.isFinite(sequence)) {
		return undefined;
	}
	return {
		workspaceId,
		...(sessionId ? { sessionId } : {}),
		generation,
		sequence,
		name,
	};
}

export class HostClient {
	private child: HostProcessLike | null = null;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly decoder: JsonlLineDecoder;
	private readonly chunks = new HostChunkAssembler();
	/** Deadline único por fluxo de evento; limpa payload parcial órfão. */
	private readonly eventDeadlines = new Map<
		string,
		{ timer: ReturnType<typeof setTimeout>; event?: HostChunkEventMeta }
	>();
	/** Evita repetir o sinal de resync para o mesmo evento perdido. */
	private readonly resyncSignaled = new Set<string>();
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

	/** Diagnóstico/testes: fluxos de fragmentos ainda em memória. */
	get pendingChunkStreams(): number {
		return this.chunks.pendingStreams;
	}

	/** Diagnóstico/testes: bytes de payload parcial retidos. */
	get pendingChunkBytes(): number {
		return this.chunks.pendingBytes;
	}

	async start(): Promise<void> {
		if (this.child) throw new HostClientError("INVALID_REQUEST", "O host já foi iniciado.");
		this.exitHandled = false;
		this.closing = false;
		this.decoder.reset();
		this.chunks.clear();
		this.resyncSignaled.clear();
		this.clearEventDeadlines();
		const spawnImpl = this.opts.spawnImpl ?? (spawn as unknown as HostSpawn);
		let child: HostProcessLike;
		try {
			child = spawnImpl(this.opts.bunPath, [this.opts.hostScript], {
				cwd: this.opts.cwd,
				env: this.opts.env ?? buildHostEnv(),
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
				// No POSIX o host vira líder do próprio grupo; o encerramento
				// sinaliza o grupo inteiro, cobrindo filhos reparentados.
				detached: process.platform !== "win32",
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
			if (record.kind === HOST_CHUNK_KIND) {
				this.handleChunk(record);
				continue;
			}
			this.dispatchMessage(record);
		}
	}

	private dispatchMessage(record: Record<string, unknown>): void {
		if (record.kind === "response" && typeof record.id === "string") {
			this.settle(record);
			return;
		}
		if (isDesktopEvent(record)) {
			try {
				this.opts.onEvent(record);
			} catch (error) {
				this.log("error", `falha ao processar evento do host: ${(error as Error).message}`);
			}
			return;
		}
		this.log("warn", "mensagem desconhecida recebida do host (ignorada)");
	}

	private handleChunk(record: Record<string, unknown>): void {
		const parsed = parseHostChunkFrame(record);
		if (!parsed.ok) {
			this.failChunk(parsed.failure);
			return;
		}
		const frame = parsed.frame;
		// Resposta já resolvida/expirada: não remonta payload que ninguém vai
		// consumir. O timeout/rejeição já removeu o fluxo correlacionado.
		if (frame.responseId && !this.pending.has(frame.responseId)) {
			this.dropChunkStream(frame.id);
			if (frame.index === 0) this.log("warn", `resposta fragmentada sem solicitante (${frame.responseId})`);
			return;
		}
		// Fluxos de evento não têm request pendente: um deadline único limpa o
		// payload parcial se o host parar no meio e não encerrar o processo.
		if (frame.index === 0 && !frame.responseId) this.armEventDeadline(frame);
		const result = this.chunks.push(frame);
		if (result.failure) this.failChunk(result.failure);
		if (result.assembled) {
			this.clearEventDeadline(result.assembled.id);
			this.deliverAssembled(result.assembled);
		}
	}

	private armEventDeadline(frame: HostChunkFrame): void {
		if (this.eventDeadlines.has(frame.id)) return;
		const timeoutMs = this.requestTimeoutMs;
		if (timeoutMs <= 0) return;
		const event = frame.event;
		const timer = setTimeout(() => {
			this.dropChunkStream(frame.id);
			this.log(
				"error",
				`evento fragmentado incompleto; fluxo ${frame.id} descartado após ${Math.round(timeoutMs / 1000)} s.`,
			);
			if (event) {
				this.signalEventResync(
					event,
					"stream-timeout",
					`o fluxo ${frame.id} não completou em ${Math.round(timeoutMs / 1000)} s.`,
				);
			}
		}, timeoutMs);
		this.eventDeadlines.set(frame.id, { timer, event });
	}

	private clearEventDeadline(id: string): void {
		const entry = this.eventDeadlines.get(id);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.eventDeadlines.delete(id);
	}

	private clearEventDeadlines(): void {
		for (const entry of this.eventDeadlines.values()) clearTimeout(entry.timer);
		this.eventDeadlines.clear();
	}

	private dropChunkStream(id: string): void {
		this.clearEventDeadline(id);
		this.chunks.dropById(id);
	}

	private failChunk(failure: HostChunkFailure): void {
		const event = failure.event ?? (failure.id ? this.chunks.eventOf(failure.id) : undefined);
		if (failure.id) this.dropChunkStream(failure.id);
		const detail = `O host enviou uma mensagem fragmentada inválida (${failure.reason}): ${failure.detail}`;
		this.log("error", detail);
		if (failure.responseId) {
			this.rejectPending(failure.responseId, new HostClientError("INTERNAL", detail));
			return;
		}
		if (event) this.signalEventResync(event, failure.reason, failure.detail);
	}

	private deliverAssembled(assembled: AssembledHostChunk): void {
		let message: unknown;
		try {
			message = JSON.parse(assembled.text);
		} catch {
			const detail = "O host enviou uma mensagem fragmentada com JSON inválido.";
			this.log("error", detail);
			if (assembled.responseId) {
				this.rejectPending(assembled.responseId, new HostClientError("INTERNAL", detail));
			} else if (assembled.event) {
				this.signalEventResync(assembled.event, "invalid-frame", detail);
			}
			return;
		}
		if (typeof message !== "object" || message === null) {
			const detail = "O host enviou uma mensagem fragmentada que não é um objeto JSON.";
			this.log("error", detail);
			if (assembled.responseId) {
				this.rejectPending(assembled.responseId, new HostClientError("INTERNAL", detail));
			} else if (assembled.event) {
				this.signalEventResync(assembled.event, "invalid-frame", detail);
			}
			return;
		}
		const record = message as Record<string, unknown>;
		if (assembled.responseId) {
			if (record.kind !== "response" || record.id !== assembled.responseId) {
				const detail = "O host enviou uma resposta fragmentada com correlação inconsistente.";
				this.log("error", detail);
				this.rejectPending(assembled.responseId, new HostClientError("INTERNAL", detail));
				return;
			}
		} else if (assembled.event) {
			if (!isDesktopEvent(record) || !sameEventIdentity(assembled.event, record)) {
				const detail = "O host enviou um evento fragmentado com identidade inconsistente.";
				this.log("error", detail);
				this.signalEventResync(assembled.event, "invalid-frame", detail);
				return;
			}
		}
		this.dispatchMessage(record);
	}

	private rejectPending(id: string, error: HostClientError): void {
		const entry = this.pending.get(id);
		if (!entry) {
			this.chunks.dropResponse(id);
			return;
		}
		this.pending.delete(id);
		clearTimeout(entry.timer);
		entry.reject(error);
		this.chunks.dropResponse(id);
	}

	/**
	 * Um evento fragmentado perdido deixa uma lacuna de sequência. O evento
	 * sintético abaixo usa a sequência seguinte à perdida para que o renderer
	 * classifique a lacuna como `resync`; isso também cobre o caso em que o
	 * próximo evento real é `session.status`, cujo tratamento especial poderia
	 * mascarar a lacuna. O evento sintético nunca é aplicado ao reducer.
	 */
	private signalEventResync(event: HostChunkEventMeta, reason: string, detail: string): void {
		// Eventos sem sessão (host.status) não têm estado de reducer para
		// ressincronizar; o log de falha já é o sinal explícito.
		if (!event.sessionId) return;
		const key = `${event.workspaceId}\u0000${event.sessionId}\u0000${event.generation}\u0000${event.sequence}`;
		if (this.resyncSignaled.has(key)) return;
		this.resyncSignaled.add(key);
		const sequence = event.sequence < Number.MAX_SAFE_INTEGER ? event.sequence + 1 : event.sequence;
		const synthetic: DesktopEvent = {
			kind: "event",
			workspaceId: event.workspaceId,
			sessionId: event.sessionId,
			generation: event.generation,
			sequence,
			name: "wire.resync",
			data: { reason, detail },
		};
		this.log(
			"error",
			`evento fragmentado perdido (${reason}); sinalizando resync em ${event.workspaceId}/${event.sessionId} sequência ${event.sequence}.`,
		);
		try {
			this.opts.onEvent(synthetic);
		} catch (error) {
			this.log("error", `falha ao sinalizar resync do host: ${(error as Error).message}`);
		}
	}

	/**
	 * Descarta a linha grande sem derrubar o host. Se o prefixo ainda identifica
	 * a resposta de uma request pendente, só aquela request falha com
	 * `FRAME_TOO_LARGE`; as demais continuam e o parser segue no próximo `\n`.
	 * Fragmentos descartados também limpam o fluxo parcial e sinalizam resync
	 * quando a identidade do evento está no prefixo.
	 */
	private rejectDiscardedResponses(): void {
		for (const dropped of this.decoder.takeDiscarded()) {
			const message = `O host enviou uma linha de ${dropped.bytes} bytes acima do limite de ${this.maxLineBytes} bytes.`;
			if (/^\s*\{\s*"kind"\s*:\s*"chunk"/.test(dropped.prefix)) {
				this.log("error", `fragmento descartado: ${message}`);
				const chunkId = /"id"\s*:\s*"([A-Za-z0-9._:-]{1,128})"/.exec(dropped.prefix)?.[1];
				const existingEvent = chunkId ? this.chunks.eventOf(chunkId) : undefined;
				if (chunkId) this.dropChunkStream(chunkId);
				const responseId = /"responseId"\s*:\s*"([A-Za-z0-9._:-]{1,128})"/.exec(dropped.prefix)?.[1];
				if (responseId) {
					this.rejectPending(responseId, new HostClientError("FRAME_TOO_LARGE", message));
					continue;
				}
				const event = parseEventPrefix(dropped.prefix) ?? existingEvent;
				if (event) this.signalEventResync(event, "frame-too-large", message);
				continue;
			}
			this.log("error", `resposta descartada: ${message}`);
			if (!/^\s*\{\s*"kind"\s*:\s*"response"/.test(dropped.prefix)) continue;
			const id = /"id"\s*:\s*"([A-Za-z0-9._:-]{1,64})"/.exec(dropped.prefix)?.[1];
			if (!id) continue;
			this.rejectPending(id, new HostClientError("FRAME_TOO_LARGE", message));
		}
	}

	private settle(record: Record<string, unknown>): void {
		const id = record.id as string;
		const entry = this.pending.get(id);
		if (!entry) {
			this.log("warn", `resposta sem solicitante (${String(record.id)})`);
			return;
		}
		this.pending.delete(id);
		clearTimeout(entry.timer);
		this.chunks.dropResponse(id);
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
		this.decoder.reset();
		const waiters = this.exitWaiters;
		this.exitWaiters = [];
		for (const resolve of waiters) resolve();
		this.opts.onExit({ code, signal, stderr });
	}

	private failAll(error: HostClientError): void {
		this.clearEventDeadlines();
		this.chunks.clear();
		this.resyncSignaled.clear();
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
					this.chunks.dropResponse(id);
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
	 * Encerra a árvore somente com a identidade capturada no spawn. Sem
	 * identidade (ou com PID diferente) nenhum sinal por número é enviado; o
	 * chamador usa o handle do processo como fallback.
	 */
	private async killOwnedProcess(pid: number): Promise<void> {
		const identity = this.identityPromise ? await this.identityPromise : undefined;
		if (!identity || identity.pid !== pid) {
			this.log("warn", `host.identidade_indisponivel pid=${pid}`);
			return;
		}
		await killProcessTree(identity);
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
			// Fallback pelo handle do processo criado por este cliente; nunca
			// resolve o PID de novo (evita matar um PID reutilizado).
			try {
				child.kill("SIGKILL");
			} catch {
				/* já encerrado */
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
