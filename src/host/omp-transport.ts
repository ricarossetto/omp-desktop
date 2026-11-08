/**
 * Transporte do processo OMP por sessão: stdin/stdout JSONL, protocolo v1/v2.
 *
 * - Spawn `omp --mode rpc-ui` por argv (nunca `--no-ui`), com cwd da sessão,
 *   `--profile` e `--resume <sessionPath>` quando aplicáveis.
 * - Prontidão é o frame `ready` (sem delays); negocia v2, assina subagentes,
 *   habilita `set_ask_dialog` e consulta estado/comandos/níveis de thinking.
 * - Usa `RpcFrameDecoder` oficial para remontar `rpc_chunk` com validação de
 *   ordem/base64/UTF-8/limites.
 * - IDs únicos por geração; timers e listeners limpos em sucesso, erro, abort
 *   e saída. stderr nunca vai para stdout.
 * - Queda ou frame inválido resolve pendências com HOST_EXITED e NUNCA reenvia
 *   prompt: o host marca o prompt como interrompido.
 */
import { RpcFrameDecoder } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-frame";
import type {
	RpcCommand,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSubagentSubscriptionLevel,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { isRecord } from "../shared/session-state";
import {
	captureProcessIdentity,
	killProcessTree,
	ompLaunchSpec,
	waitForExit,
	type ProcessIdentity,
} from "./omp-cli";

export interface OmpTransportOptions {
	ompPath: string;
	cwd: string;
	generation: number;
	profile?: string;
	resumePath?: string;
	/** Argumentos extras tipados (budget/thinking); nunca texto vindo do renderer. */
	args?: string[];
	env?: Record<string, string | undefined>;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
	onExit?(info: OmpExitInfo): void;
	onStderr?(text: string): void;
	onWarning?(message: string): void;
}

export interface OmpExitInfo {
	code: number | null;
	fatalReason?: string;
	stderrTail: string;
}

export interface ReadyInfo {
	protocolVersion: 1 | 2;
	supportedProtocolVersions: number[];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
	pid?: number;
	generation: number;
	warnings: string[];
}

export class OmpTransportError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "OmpTransportError";
	}
}

interface PendingRequest {
	command: string;
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
	onAbort?: () => void;
	signal?: AbortSignal;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason?: unknown): void;
}

const DEFAULT_STARTUP_TIMEOUT = 90_000;
const DEFAULT_REQUEST_TIMEOUT = 120_000;
const MAX_PHYSICAL_LINE = 64 * 1024 * 1024;
const MAX_STDERR_TAIL = 8192;

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	if (left.byteLength === 0) return right;
	if (right.byteLength === 0) return left;
	const out = new Uint8Array(left.byteLength + right.byteLength);
	out.set(left, 0);
	out.set(right, left.byteLength);
	return out;
}

export type OmpFrameListener = (frame: object) => void;

export class OmpTransport {
	readonly generation: number;
	private readonly options: OmpTransportOptions;
	private readonly decoder = new RpcFrameDecoder();
	private readonly listeners = new Set<OmpFrameListener>();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly warnings: string[] = [];
	private child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	private identity: Promise<ProcessIdentity | undefined> | undefined;
	private requestCounter = 0;
	private protocolVersion: 1 | 2 = 1;
	private maxFrameBytes = 1024 * 1024;
	private maxReassembledFrameBytes = 64 * 1024 * 1024;
	private stderrTail = "";
	private writeChain: Promise<void> = Promise.resolve();
	private exited: Promise<number> | undefined;
	private started = false;
	private closing = false;
	private closed = false;
	private fatalReason: string | undefined;
	private exitNotified = false;
	private closePromise: Promise<void> | undefined;
	private startDeferred: Deferred<ReadyInfo> | undefined = Promise.withResolvers<ReadyInfo>();

	constructor(options: OmpTransportOptions) {
		this.options = options;
		this.generation = options.generation;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get protocol(): 1 | 2 {
		return this.protocolVersion;
	}

	/** Maior JSON de entrada aceito; anexos precisam caber neste limite. */
	get maxRequestBytes(): number {
		return this.maxFrameBytes;
	}

	get supportedProtocolVersions(): number[] {
		return this.protocolVersion === 2 ? [1, 2] : [1];
	}

	subscribe(listener: OmpFrameListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async start(): Promise<ReadyInfo> {
		if (this.started) return this.startDeferred?.promise ?? Promise.reject(new Error("O transporte já iniciou."));
		this.started = true;
		try {
			this.spawn();
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			this.startDeferred?.reject(failure);
			this.startDeferred = undefined;
			throw failure;
		}
		const startupTimer = setTimeout(() => {
			this.fail("O OMP não enviou o frame de prontidão a tempo.");
		}, this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT);
		try {
			const deferred = this.startDeferred;
			if (!deferred) throw new OmpTransportError("OMP_UNAVAILABLE", "A inicialização do OMP já terminou.");
			await deferred.promise;
			const negotiated = await this.negotiate();
			await this.initialize();
			if (this.fatalReason) throw new OmpTransportError("HOST_EXITED", this.fatalReason);
			if (this.closed) throw new OmpTransportError("OMP_UNAVAILABLE", "O OMP encerrou durante a inicialização.");
			return {
				protocolVersion: negotiated,
				supportedProtocolVersions: this.supportedProtocolVersions,
				maxFrameBytes: this.maxFrameBytes,
				maxReassembledFrameBytes: this.maxReassembledFrameBytes,
				pid: this.child?.pid,
				generation: this.generation,
				// Inclui avisos de `initialize()` (set_ask_dialog, subagentes).
				warnings: [...this.warnings],
			};
		} finally {
			clearTimeout(startupTimer);
		}
	}

	private spawn(): void {
		const args = ["--mode", "rpc-ui"];
		if (this.options.profile) args.push("--profile", this.options.profile);
		if (this.options.resumePath) args.push("--resume", this.options.resumePath);
		if (this.options.args) args.push(...this.options.args);
		const spec = ompLaunchSpec(this.options.ompPath, args);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries({ ...process.env, ...this.options.env })) {
			if (typeof value === "string") env[key] = value;
		}
		let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
		try {
			child = Bun.spawn([spec.command, ...spec.args], {
				cwd: this.options.cwd,
				env,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
				// POSIX: líder do próprio grupo para o encerramento cobrir a árvore
				// mesmo se o OMP reparentar filhos.
				detached: process.platform !== "win32",
				...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
			});
		} catch (error) {
			throw new OmpTransportError(
				"OMP_UNAVAILABLE",
				`Não foi possível iniciar o OMP em ${this.options.ompPath}: ${(error as Error).message}`,
			);
		}
		this.child = child;
		this.identity = child.pid
			? captureProcessIdentity(child.pid, spec.command)
			: Promise.resolve(undefined);
		void this.readStdout(child.stdout);
		void this.readStderr(child.stderr);
		this.exited = child.exited.then((code) => {
			this.handleExit(code);
			return code;
		});
	}

	private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		let carry: Uint8Array = new Uint8Array(0);
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				let start = 0;
				for (let index = 0; index < value.byteLength; index++) {
					if (value[index] !== 0x0a) continue;
					const slice = value.subarray(start, index);
					const lineBytes = carry.byteLength > 0 ? concatBytes(carry, slice) : slice;
					carry = new Uint8Array(0);
					start = index + 1;
					if (lineBytes.byteLength === 0) continue;
					const line = this.decodeLine(lineBytes);
					if (line !== undefined) this.handleLine(line);
					if (this.fatalReason) {
						await reader.cancel().catch(() => undefined);
						return;
					}
				}
				if (start < value.byteLength) {
					carry = concatBytes(carry, value.subarray(start));
				}
				if (carry.byteLength > MAX_PHYSICAL_LINE) {
					this.fail("O OMP enviou uma linha maior que o limite físico do transporte.");
					await reader.cancel().catch(() => undefined);
					return;
				}
			}
			if (carry.byteLength > 0) {
				const line = this.decodeLine(carry);
				if (line !== undefined) this.handleLine(line);
			}
		} catch (error) {
			if (!this.closed && !this.closing) {
				this.fail(`Falha ao ler a saída do OMP: ${(error as Error).message}`);
			}
		} finally {
			reader.releaseLock();
		}
	}

	private decodeLine(bytes: Uint8Array): string | undefined {
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			const trimmed = text.endsWith("\r") ? text.slice(0, -1) : text;
			return trimmed.trim().length > 0 ? trimmed : undefined;
		} catch {
			this.fail("O OMP enviou texto inválido (UTF-8) no protocolo.");
			return undefined;
		}
	}

	private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder("utf-8");
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				const text = decoder.decode(value, { stream: true });
				if (!text) continue;
				this.stderrTail = `${this.stderrTail}${text}`.slice(-MAX_STDERR_TAIL);
				this.options.onStderr?.(this.stderrTail);
			}
		} catch {
			/* stderr é diagnóstico; a saída principal manda */
		} finally {
			reader.releaseLock();
		}
	}

	private handleLine(line: string): void {
		if (this.fatalReason) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.fail("O OMP enviou uma linha JSON inválida.");
			return;
		}
		let frame: object | undefined;
		try {
			frame = this.decoder.push(parsed);
		} catch (error) {
			this.fail(`Frame inválido do OMP: ${(error as Error).message}`);
			return;
		}
		if (!frame) return;
		if (!isRecord(frame)) return;
		const type = typeof frame.type === "string" ? frame.type : "";
		if (type === "ready") {
			this.handleReady(frame);
			return;
		}
		if (type === "response") {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			const pending = id ? this.pending.get(id) : undefined;
			if (pending && id) {
				// Fronteira do protocolo: `type === "response"` já foi verificado.
				const response = frame as RpcResponse;
				this.settlePending(id, response);
				return;
			}
			// Resposta tardia (ex.: erro após o ack do prompt) ou sem id: emite
			// para o host acompanhar; nunca resolve duas vezes.
			this.emit(frame);
			return;
		}
		this.emit(frame);
	}

	private handleReady(frame: Record<string, unknown>): void {
		const supported = Array.isArray(frame.supportedProtocolVersions)
			? frame.supportedProtocolVersions.filter((item): item is number => typeof item === "number")
			: [typeof frame.protocolVersion === "number" ? frame.protocolVersion : 1];
		if (typeof frame.maxFrameBytes === "number" && frame.maxFrameBytes > 0) {
			this.maxFrameBytes = frame.maxFrameBytes;
		}
		if (typeof frame.maxReassembledFrameBytes === "number" && frame.maxReassembledFrameBytes > 0) {
			this.maxReassembledFrameBytes = frame.maxReassembledFrameBytes;
		}
		if (!supported.includes(2)) {
			this.warnings.push("O OMP anunciou apenas o protocolo v1; respostas grandes usam o limite de 1 MiB.");
		}
		const deferred = this.startDeferred;
		if (deferred) {
			this.startDeferred = undefined;
			deferred.resolve({
				protocolVersion: 1,
				supportedProtocolVersions: supported,
				maxFrameBytes: this.maxFrameBytes,
				maxReassembledFrameBytes: this.maxReassembledFrameBytes,
				generation: this.generation,
				warnings: [...this.warnings],
			});
		}
	}

	private async negotiate(): Promise<1 | 2> {
		try {
			const response = await this.request(
				{ type: "negotiate_protocol", protocolVersion: 2 },
				undefined,
				15_000,
			);
			if (response.success === true) {
				this.protocolVersion = 2;
				return 2;
			}
			this.warnings.push("O OMP recusou o protocolo v2; seguindo em v1 (limite de 1 MiB por frame).");
		} catch (error) {
			this.warnings.push(
				`Não foi possível negociar o protocolo v2 (${(error as Error).message}); seguindo em v1.`,
			);
		}
		return 1;
	}

	private async initialize(): Promise<void> {
		const subscription = await this.tryRequest<RpcSubagentSubscriptionLevel>({
			type: "set_subagent_subscription",
			level: "events",
		});
		if (!subscription) this.warnings.push("O OMP não confirmou a assinatura de subagentes.");
		const ask = await this.tryRequest<{ enabled: boolean }>({ type: "set_ask_dialog", enabled: true });
		if (!ask) this.warnings.push("O OMP não confirmou o diálogo `ask`.");
		await this.tryRequest<{ levels: string[] }>({ type: "get_available_thinking_levels" });
		await this.tryRequest<Record<string, unknown>>({ type: "get_state" });
		await this.tryRequest<{ commands: unknown[] }>({ type: "get_available_commands" });
		for (const warning of this.warnings) this.options.onWarning?.(warning);
	}

	private async tryRequest<T>(command: RpcCommand): Promise<T | undefined> {
		try {
			const response = await this.request(command);
			if (response.success === true && "data" in response) {
				// Fronteira do protocolo: o comando e o formato de `data` são conhecidos pelo chamador.
				return response.data as T;
			}
			if (response.success === false) {
				this.warnings.push(`O OMP recusou ${command.type}: ${response.error}`);
			}
			return undefined;
		} catch (error) {
			this.warnings.push(`Falha em ${command.type}: ${(error as Error).message}`);
			return undefined;
		}
	}

	private emit(frame: object): void {
		for (const listener of this.listeners) {
			try {
				listener(frame);
			} catch (error) {
				this.options.onWarning?.(`Listener de frame falhou: ${(error as Error).message}`);
			}
		}
	}

	private settlePending(id: string, response: RpcResponse): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		pending.resolve(response);
	}

	async request(command: RpcCommand, signal?: AbortSignal, timeoutMs?: number): Promise<RpcResponse> {
		if (this.fatalReason) {
			throw new OmpTransportError("HOST_EXITED", this.fatalReason);
		}
		if (!this.child || this.closed) {
			throw new OmpTransportError("HOST_EXITED", "O processo do OMP já foi encerrado.");
		}
		if (signal?.aborted) {
			throw new OmpTransportError("INTERNAL", "Operação cancelada.");
		}
		const id = command.id ?? this.nextRequestId(command.type);
		// Fronteira do protocolo: todos os comandos aceitam `id`; o payload é o próprio comando.
		const payload = { ...command, id } as RpcCommand;
		const json = JSON.stringify(payload);
		const bytes = Buffer.byteLength(json, "utf8") + 1;
		if (bytes > this.maxFrameBytes) {
			throw new OmpTransportError(
				"FRAME_TOO_LARGE",
				`O pedido tem ${Math.ceil(bytes / 1024)} KiB e excede o limite de ${Math.floor(
					this.maxFrameBytes / 1024,
				)} KiB aceito pelo OMP. Reduza o anexo ou o texto e tente novamente.`,
			);
		}
		const deferred = Promise.withResolvers<RpcResponse>();
		const timer = setTimeout(() => {
			this.rejectPending(id, new OmpTransportError("INTERNAL", `O OMP não respondeu a ${command.type} a tempo.`));
		}, timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT);
		const entry: PendingRequest = {
			command: command.type,
			resolve: deferred.resolve,
			reject: deferred.reject,
			timer,
		};
		if (signal) {
			const onAbort = () => {
				this.rejectPending(id, new OmpTransportError("INTERNAL", "Operação cancelada."));
			};
			entry.signal = signal;
			entry.onAbort = onAbort;
			signal.addEventListener("abort", onAbort, { once: true });
		}
		this.pending.set(id, entry);
		try {
			await this.enqueueWrite(`${json}\n`);
		} catch (error) {
			this.rejectPending(id, error instanceof Error ? error : new Error(String(error)));
		}
		return deferred.promise;
	}

	private rejectPending(id: string, error: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		clearTimeout(pending.timer);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		pending.reject(error);
	}

	async respondUI(response: RpcExtensionUIResponse): Promise<void> {
		if (this.fatalReason) throw new OmpTransportError("HOST_EXITED", this.fatalReason);
		if (!this.child || this.closed) throw new OmpTransportError("HOST_EXITED", "A sessão não está mais aberta.");
		const json = JSON.stringify(response);
		if (Buffer.byteLength(json, "utf8") + 1 > this.maxFrameBytes) {
			throw new OmpTransportError("FRAME_TOO_LARGE", "A resposta do diálogo excedeu o limite de transporte.");
		}
		await this.enqueueWrite(`${json}\n`);
	}

	private enqueueWrite(text: string): Promise<void> {
		const run = async () => {
			if (this.fatalReason) throw new OmpTransportError("HOST_EXITED", this.fatalReason);
			const stdin = this.child?.stdin;
			if (!stdin) throw new OmpTransportError("HOST_EXITED", "A entrada do OMP não está disponível.");
			try {
				const result = stdin.write(text);
				if (typeof result !== "number") await result;
				await stdin.flush();
			} catch (error) {
				throw new OmpTransportError(
					"HOST_EXITED",
					`Não foi possível enviar dados ao OMP: ${(error as Error).message}`,
				);
			}
		};
		const next = this.writeChain.then(run, run);
		this.writeChain = next.catch(() => undefined);
		return next;
	}

	private nextRequestId(command: string): string {
		this.requestCounter += 1;
		const prefix = command.replace(/[^a-z0-9_]/gi, "").slice(0, 24) || "req";
		return `${prefix}-${this.generation}-${this.requestCounter}`;
	}

	private fail(reason: string): void {
		if (this.closing || this.closed || this.fatalReason) return;
		this.fatalReason = reason;
		this.rejectAll(new OmpTransportError("HOST_EXITED", reason));
		// Diagnóstico é entregue imediatamente; o encerramento do processo segue em background.
		this.notifyExit(null);
		void this.forceStop();
	}

	private rejectAll(error: Error): void {
		const ids = [...this.pending.keys()];
		for (const id of ids) this.rejectPending(id, error);
	}

	private async forceStop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		try {
			child.kill();
		} catch {
			/* já saiu */
		}
		try {
			await child.stdin.end();
		} catch {
			/* já fechado */
		}
		const identity = this.identity ? await this.identity : undefined;
		if (identity) await killProcessTree(identity);
		await waitForExit(child.exited, 3_000);
	}

	private notifyExit(code: number | null): void {
		if (this.exitNotified || this.closing) return;
		this.exitNotified = true;
		this.options.onExit?.({ code, fatalReason: this.fatalReason, stderrTail: this.stderrTail });
	}

	private handleExit(code: number | null): void {
		this.closed = true;
		this.rejectAll(
			new OmpTransportError(
				"HOST_EXITED",
				this.fatalReason ?? `O processo do OMP encerrou (código ${code ?? "desconhecido"}).`,
			),
		);
		const deferred = this.startDeferred;
		if (deferred) {
			this.startDeferred = undefined;
			deferred.reject(
				new OmpTransportError("OMP_UNAVAILABLE", `O OMP encerrou durante a inicialização (código ${code ?? "?"}).`),
			);
		}
		this.notifyExit(code);
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = this.performClose();
		return this.closePromise;
	}

	private async performClose(): Promise<void> {
		this.closing = true;
		const child = this.child;
		if (!child) {
			this.closed = true;
			return;
		}
		try {
			await child.stdin.end();
		} catch {
			/* já fechado */
		}
		const exited = this.exited ?? child.exited;
		const ended = await waitForExit(exited, 10_000);
		if (!ended) {
			const identity = this.identity ? await this.identity : undefined;
			const killed = identity ? await killProcessTree(identity) : false;
			if (!killed) {
				// Identidade indisponível/recusada: só o handle deste spawn é
				// seguro; nunca resolve o PID de novo.
				try {
					child.kill();
				} catch {
					/* já saiu */
				}
			}
			await waitForExit(exited, 5_000);
		}
		this.closed = true;
		this.rejectAll(new OmpTransportError("HOST_EXITED", "A sessão foi encerrada."));
	}
}
