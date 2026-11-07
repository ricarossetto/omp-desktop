/**
 * Sessões ativas do host.
 *
 * - Um processo OMP (`--mode rpc-ui`) por sessão aberta, sempre no cwd do
 *   projeto e com `--resume <sessionPath>` ao restaurar.
 * - Inventário via `SessionManager.getDefaultSessionDir` +
 *   `listSessionsReadOnly` + `FileSessionStorage` (sem parser JSONL próprio).
 * - `session.open` só aceita caminho presente no inventário daquele workspace.
 * - Snapshot idle lê estado, comandos, níveis, estatísticas, agentes e
 *   histórico por `get_entries` (entryId durável) com fallback paginado por
 *   `get_messages_page`. Frames recebidos durante a leitura são bufferizados.
 * - Queda do OMP marca a sessão como interrompida, preserva o transcript e
 *   NUNCA reenvia prompt.
 * - Abas persistidas em JSON atômico; restaurar não dispara prompt.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type {
	DesktopEvent,
	SessionListItem,
	WorkspaceDto,
} from "../shared/contracts";
import {
	applyEvent,
	chatMessageFromRaw,
	createSessionState,
	isRecord,
} from "../shared/session-state";
import type {
	AgentRow,
	ChatMessage,
	PendingDialog,
	SessionSnapshot,
	SessionStatus,
	SessionViewState,
	ToolExecution,
} from "../shared/session-types";
import type { AttachmentStore } from "./attachments";
import { commandFits } from "./attachments";
import { capValue, compactHistory, compactSnapshot, MAX_EVENT_BYTES } from "./limits";
import type { HostLogger } from "./log";
import { writeFileAtomic } from "./log";
import { parseJsonOutput, resolveOmpPath, runOmp, type RunOmpResult } from "./omp-cli";
import { OmpTransport, OmpTransportError, type ReadyInfo } from "./omp-transport";
import { projectModel, projectModels, sanitizeFrame, sanitizeRpcResult } from "./sanitize";
import type { SettingsService } from "./settings";
import {
	agentRowFromSnapshot,
	finalizedAgentsFromMessages,
	mergeAgentRows,
	readSubagentTranscript,
	SubagentTranscriptError,
	type SubagentTranscript,
} from "./subagents";
import type { WorkspaceStore } from "./workspaces";
import { pathKey } from "./workspaces";

/** Timeout específico para comandos que legitimamente demoram. */
const LONG_RPC_TIMEOUT_MS: Record<string, number> = {
	compact: 600_000,
	export_html: 600_000,
	// OAuth interativo pode esperar o usuário no navegador por vários minutos.
	login: 600_000,
	logout: 600_000,
	get_entries: 300_000,
	get_messages_page: 300_000,
	get_session_stats: 300_000,
};

interface InventoryItem {
	path: string;
	id: string;
	title?: string;
	firstMessage?: string;
	cwd?: string;
	modified: Date | number;
	messageCount?: number;
}

interface LeaseReport {
	held: string[];
	/** Ids cuja posse o OMP não conseguiu determinar (ou não pôde verificar). */
	unknown: string[];
	/** `false` quando não foi possível verificar (comando falhou/formato inválido). */
	verified?: boolean;
	reason?: string;
}

export interface SessionsOptions {
	workspaces: WorkspaceStore;
	attachments: AttachmentStore;
	settings: SettingsService;
	dataDir: string;
	ompPath?: string;
	defaultProfile?: string;
	/** Ambiente extra repassado ao processo OMP (testes/fixtures; produção usa o herdado). */
	env?: Record<string, string | undefined>;
	/** Timeout de resposta do transporte (testes); padrão do transporte em produção. */
	requestTimeoutMs?: number;
	emit(event: DesktopEvent): void;
	log: HostLogger;
	listSessions?: (cwd: string, profile?: string) => Promise<InventoryItem[]>;
	leaseProbe?: (ids: string[], cwd: string, profile?: string) => Promise<LeaseReport>;
}

export interface HostSession {
	sessionId: string;
	workspaceId: string;
	cwd: string;
	profile?: string;
	ompPath: string;
	generation: number;
	transport?: OmpTransport;
	state: SessionViewState;
	sessionPath?: string;
	supportsImages: boolean;
	ready: boolean;
	closed: boolean;
	syncing: number;
	buffer: object[];
	promptCounter: number;
	finalizedAgents: AgentRow[];
	historyDirty: boolean;
	pagedHistory: boolean;
	startupWarnings: string[];
	/** Diálogos já consumidos (resposta enviada ou cancelamento emitido). */
	answeredDialogs: Set<string>;
	syncToken: number;
	syncScheduled: boolean;
}

interface TabRecord {
	workspaceId: string;
	sessionPath: string;
	cwd: string;
	profile?: string;
}

interface TabsFile {
	version: 1;
	tabs: TabRecord[];
}

export class SessionError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SessionError";
	}
}

function asSessionError(error: unknown): SessionError {
	if (error instanceof SessionError) return error;
	if (error instanceof SubagentTranscriptError) return new SessionError(error.code, error.message);
	if (error instanceof OmpTransportError) return new SessionError(error.code, error.message);
	return new SessionError("INTERNAL", error instanceof Error ? error.message : String(error));
}

function nowMs(value: Date | number | undefined): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return 0;
}

function agentDirFor(profile: string | undefined): string | undefined {
	if (!profile || profile === "default" || profile.trim().length === 0) return undefined;
	return path.join(os.homedir(), ".omp", "profiles", profile.trim(), "agent");
}

export class SessionsService {
	private readonly sessions = new Map<string, HostSession>();
	private readonly byPath = new Map<string, HostSession>();
	private readonly opening = new Map<string, Promise<SessionSnapshot>>();
	private generationCounter = 0;
	private readonly tabsFile: string;
	/** >0 enquanto uma operação em lote (restaurar/encerrar) controla o arquivo. */
	private tabSaveSuppressed = 0;

	constructor(private readonly options: SessionsOptions) {
		this.tabsFile = path.join(options.dataDir, "tabs.json");
	}

	/** Processos OMP ativos (usado no encerramento). */
	activeCount(): number {
		let count = 0;
		for (const session of this.sessions.values()) if (session.transport) count++;
		return count;
	}

	async list(workspaceId: string): Promise<SessionListItem[]> {
		// Se o boot ainda está restaurando abas, espera: senão a interface veria a
		// sessão como fechada e não reanexaria a aba.
		if (this.restorePromise) await this.restorePromise.catch(() => undefined);
		const workspace = await this.options.workspaces.require(workspaceId);
		const items = await this.inventory(workspace);
		const ids = items.map((item) => item.id).filter((id) => id.length > 0);
		const lease = await this.probeLease(ids, workspace.path, this.options.defaultProfile);
		const verified = lease.verified !== false;
		const held = new Set(lease.held);
		const unknown = new Set(lease.unknown);
		if (!verified) {
			this.options.log.warn("sessoes.lease_desconhecido", {
				message: lease.reason ?? "não foi possível verificar",
				ids: ids.length,
			});
		}
		const listed = new Set(items.map((item) => pathKey(item.path)));
		// Sessões que já abrimos entram na lista mesmo se o inventário do OMP estiver
		// desatualizado (ex.: arquivo criado por outra versão): sem isso a aba
		// restaurada não teria como ser reanexada pela interface.
		for (const session of this.sessions.values()) {
			if (session.closed || !session.sessionPath) continue;
			const key = pathKey(session.sessionPath);
			if (listed.has(key)) continue;
			listed.add(key);
			items.push({
				path: session.sessionPath,
				id: session.sessionId,
				title: session.state.meta?.sessionName,
				cwd: session.cwd,
				modified: Date.now(),
			} as InventoryItem);
		}
		return items.map((item) => {
			const open = this.byPath.get(pathKey(item.path));
			const openSessionId = open && !open.closed ? open.sessionId : undefined;
			return {
				path: item.path,
				id: item.id,
				title: this.titleFor(item),
				cwd: item.cwd || workspace.path,
				modified: nowMs(item.modified),
				messageCount: item.messageCount,
				openSessionId,
				// Sem verificação o estado é INDEFINIDO (não "livre"). O app aberto
				// nesta sessão já a possui, então não conta como bloqueio.
				locked: openSessionId
					? false
					: !verified || unknown.has(item.id)
						? undefined
						: held.has(item.id),
			};
		});
	}

	private titleFor(item: InventoryItem): string {
		const title = item.title?.trim();
		if (title) return title;
		const first = item.firstMessage?.trim().replace(/\s+/g, " ");
		if (first) return first.length > 80 ? `${first.slice(0, 80)}…` : first;
		// Rótulo neutro: o host não conhece o idioma da interface.
		return item.id.slice(0, 8);
	}

	private async inventory(
		workspace: WorkspaceDto,
		profile: string | undefined = this.options.defaultProfile,
	): Promise<InventoryItem[]> {
		const custom = this.options.listSessions;
		if (custom) return custom(workspace.path, profile);
		const { listSessionsReadOnly } = await import("@oh-my-pi/pi-coding-agent/session/session-listing");
		const { FileSessionStorage } = await import("@oh-my-pi/pi-coding-agent/session/session-storage");
		const { SessionManager } = await import("@oh-my-pi/pi-coding-agent/session/session-manager");
		const storage = new FileSessionStorage();
		const dir = SessionManager.getDefaultSessionDir(
			workspace.path,
			agentDirFor(profile),
			storage,
		);
		const sessions = await listSessionsReadOnly(dir, storage);
		return sessions.map((session: SessionInfo) => ({
			path: session.path,
			id: session.id,
			title: session.title,
			firstMessage: session.firstMessage,
			cwd: session.cwd,
			modified: session.modified,
			messageCount: session.messageCount,
		}));
	}

	private async probeLease(ids: string[], cwd: string, profile?: string): Promise<LeaseReport> {
		if (ids.length === 0) return { held: [], unknown: [], verified: true };
		if (this.options.leaseProbe) {
			try {
				const report = await this.options.leaseProbe(ids, cwd, profile);
				return { ...report, verified: report.verified !== false };
			} catch (error) {
				return {
					held: [],
					unknown: [...ids],
					verified: false,
					reason: (error as Error).message,
				};
			}
		}
		let ompPath: string;
		try {
			ompPath = this.options.ompPath ?? (await this.requireOmpPath());
		} catch (error) {
			return {
				held: [],
				unknown: [...ids],
				verified: false,
				reason: (error as Error).message,
			};
		}
		const env = profile && profile !== "default" ? { OMP_PROFILE: profile } : undefined;
		// Lotes de 200: o OMP limita a lista por chamada; acima disso o lote inteiro
		// ficaria sem sondagem e sessões ocupadas apareceriam como livres.
		const held: string[] = [];
		const unknown: string[] = [];
		for (let offset = 0; offset < ids.length; offset += 200) {
			const batch = ids.slice(offset, offset + 200);
			let result: RunOmpResult;
			try {
				result = await runOmp(ompPath, ["session", "lease", "--json", "--", ...batch], {
					cwd,
					timeoutMs: 30_000,
					env,
				});
			} catch (error) {
				return {
					held: [],
					unknown: [...ids],
					verified: false,
					reason: (error as Error).message,
				};
			}
			// Fail-closed: sem exit 0 e JSON `{held, unknown}` a posse é DESCONHECIDA.
			if (result.exitCode !== 0 || result.timedOut) {
				const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 300);
				return {
					held: [],
					unknown: [...ids],
					verified: false,
					reason: `omp session lease saiu com código ${result.exitCode}${detail ? `: ${detail}` : ""}`,
				};
			}
			const parsed = parseJsonOutput(result.stdout);
			if (!isRecord(parsed) || !Array.isArray(parsed.held) || !Array.isArray(parsed.unknown)) {
				return {
					held: [],
					unknown: [...ids],
					verified: false,
					reason: "omp session lease não devolveu {held, unknown} em JSON",
				};
			}
			held.push(...parsed.held.filter((item): item is string => typeof item === "string"));
			unknown.push(...parsed.unknown.filter((item): item is string => typeof item === "string"));
		}
		// O contrato do OMP: ids em NENHUMA das listas estão livres.
		return { held, unknown, verified: true };
	}

	private async requireOmpPath(): Promise<string> {
		const resolved = this.options.ompPath ?? resolveOmpPath();
		if (!resolved) {
			throw new SessionError(
				"OMP_UNAVAILABLE",
				"O executável do OMP não foi encontrado. Selecione o omp.exe na tela de diagnóstico ou instale o OMP.",
			);
		}
		return resolved;
	}

	async create(workspaceId: string): Promise<SessionSnapshot> {
		const workspace = await this.options.workspaces.require(workspaceId);
		const key = `new:${workspace.workspaceId}`;
		const running = this.opening.get(key);
		if (running) return running;
		const task = this.spawnFor(workspace, undefined).finally(() => this.opening.delete(key));
		this.opening.set(key, task);
		return task;
	}

	async open(
		workspaceId: string,
		sessionPath: string,
		options: { profile?: string; trustedPath?: boolean } = {},
	): Promise<SessionSnapshot> {
		const workspace = await this.options.workspaces.require(workspaceId);
		const profile = options.profile ?? this.options.defaultProfile;
		const items = await this.inventory(workspace, profile);
		// Restauração de aba usa o caminho que nós mesmos persistimos: a listagem do
		// OMP pode estar indisponível (versão diferente) sem impedir a reabertura.
		const match = options.trustedPath
			? { id: path.basename(sessionPath, path.extname(sessionPath)), path: sessionPath }
			: items.find((item) => pathKey(item.path) === pathKey(sessionPath));
		if (!match) {
			throw new SessionError(
				"UNKNOWN_SESSION",
				"Essa sessão não está na listagem autorizada deste projeto. Recarregue a lista e escolha novamente.",
			);
		}
		const existing = this.byPath.get(pathKey(match.path));
		if (existing && !existing.closed) {
			if (existing.transport) return this.snapshot(existing.workspaceId, existing.sessionId);
			this.removeSession(existing);
		}
		const key = `open:${pathKey(match.path)}`;
		const running = this.opening.get(key);
		if (running) return running;
		const task = (async () => {
			const lease = await this.probeLease([match.id], workspace.path, profile);
			if (lease.verified === false) {
				throw new SessionError(
					"SESSION_LOCKED",
					"Não foi possível verificar se a sessão está em uso por outro processo do OMP. Nada foi aberto para evitar corromper o histórico; feche outros processos do OMP (ou selecione um executável compatível) e tente novamente.",
				);
			}
			if (lease.held.includes(match.id)) {
				throw new SessionError(
					"SESSION_LOCKED",
					"Essa sessão já está aberta em outro processo do OMP. Feche-a lá ou abra outra sessão.",
				);
			}
			if (lease.unknown.includes(match.id)) {
				throw new SessionError(
					"SESSION_LOCKED",
					"O OMP não conseguiu confirmar se esta sessão está em uso por outro processo. Nada foi aberto; tente novamente após fechar os outros processos do OMP.",
				);
			}
			return this.spawnFor(workspace, match.path, profile);
		})().finally(() => this.opening.delete(key));
		this.opening.set(key, task);
		return task;
	}

	private async spawnFor(
		workspace: WorkspaceDto,
		resumePath: string | undefined,
		profileOverride?: string,
	): Promise<SessionSnapshot> {
		const ompPath = await this.requireOmpPath();
		const profile = profileOverride ?? this.options.defaultProfile;
		const generation = ++this.generationCounter;
		const earlyFrames: object[] = [];
		const transport = new OmpTransport({
			ompPath,
			cwd: workspace.path,
			generation,
			profile,
			resumePath,
			env: this.options.env,
			requestTimeoutMs: this.options.requestTimeoutMs,
			onExit: (info) => {
				const session = this.findByTransport(transport) ?? this.sessions.get(pendingSessionId);
				if (session && session.transport === transport) {
					this.handleExit(session, info.code, info.fatalReason);
				}
			},
			onStderr: () => {
				/* conteúdo de stderr não é logado: pode carregar prompt/resposta */
			},
			onWarning: (message) => this.options.log.warn("omp.aviso", { message }),
		});
		const unsubscribeEarly = transport.subscribe((frame) => earlyFrames.push(frame));
		// Identificador provisório para correlacionar uma queda durante o start.
		let pendingSessionId = `pending_${generation}`;
		let ready: ReadyInfo;
		try {
			ready = await transport.start();
		} catch (error) {
			unsubscribeEarly();
			await transport.close().catch(() => undefined);
			throw asSessionError(error);
		}
		unsubscribeEarly();
		const stateResponse = await transport
			.request({ type: "get_state" })
			.catch((error: unknown) => Promise.reject(asSessionError(error)));
		const initialState = responseData(stateResponse);
		if (!isRecord(initialState)) {
			await transport.close().catch(() => undefined);
			throw new SessionError("OMP_INCOMPATIBLE", "O OMP não informou o estado da sessão após iniciar.");
		}
		const rpcState = initialState;
		const sessionId = typeof rpcState.sessionId === "string" ? rpcState.sessionId : undefined;
		const reportedFile = typeof rpcState.sessionFile === "string" ? rpcState.sessionFile : undefined;
		if (!sessionId) {
			await transport.close().catch(() => undefined);
			throw new SessionError("OMP_INCOMPATIBLE", "O OMP não informou o identificador da sessão.");
		}
		if (resumePath && reportedFile && pathKey(reportedFile) !== pathKey(resumePath)) {
			await transport.close().catch(() => undefined);
			throw new SessionError(
				"OMP_INCOMPATIBLE",
				"O OMP abriu uma sessão diferente do arquivo escolhido. Nenhuma alteração foi feita.",
			);
		}
		const state = createSessionState({
			workspaceId: workspace.workspaceId,
			sessionId,
			generation,
		});
		state.status = "starting";
		const session: HostSession = {
			sessionId,
			workspaceId: workspace.workspaceId,
			cwd: workspace.path,
			profile,
			ompPath,
			generation,
			transport,
			state,
			sessionPath: reportedFile ?? resumePath,
			supportsImages: false,
			ready: false,
			closed: false,
			syncing: 1,
			buffer: earlyFrames,
			promptCounter: 0,
			finalizedAgents: [],
			historyDirty: false,
			pagedHistory: false,
			startupWarnings: [...ready.warnings],
			answeredDialogs: new Set<string>(),
			syncToken: 0,
			syncScheduled: false,
		};
		pendingSessionId = sessionId;
		this.sessions.set(sessionId, session);
		if (session.sessionPath) this.byPath.set(pathKey(session.sessionPath), session);
		transport.subscribe((frame) => this.onFrame(session, frame));
		try {
			const snapshot = await this.buildSnapshot(session, { drainBuffer: true });
			session.state = snapshot.state;
			session.ready = true;
			session.syncing = 0;
			this.emitStartupNotices(session, ready);
			await this.saveTabs();
			this.options.log.info("sessao.aberta", {
				sessionId,
				workspaceId: workspace.workspaceId,
				generation,
				resumed: Boolean(resumePath),
				protocol: ready.protocolVersion,
			});
			return snapshot;
		} catch (error) {
			session.syncing = 0;
			this.removeSession(session);
			await transport.close().catch(() => undefined);
			throw asSessionError(error);
		}
	}

	/**
	 * Avisos de inicialização (fallback v1, `set_ask_dialog` recusado, limites
	 * do transporte) precisam chegar ao usuário: eram coletados e descartados.
	 */
	private emitStartupNotices(session: HostSession, ready: ReadyInfo): void {
		for (const warning of ready.warnings) {
			this.emitEvent(session, "desktop_notice", { level: "warning", text: warning });
		}
		const limitKb = Math.floor(ready.maxFrameBytes / 1024);
		this.emitEvent(session, "desktop_notice", {
			level: ready.protocolVersion === 1 ? "warning" : "info",
			text:
				ready.protocolVersion === 1
					? `O OMP está no protocolo v1: pedidos e respostas acima de ${limitKb} KiB serão recusados com aviso (nada é truncado silenciosamente).`
					: `Limite do transporte OMP: ${limitKb} KiB por frame; anexos maiores são recusados antes do envio.`,
		});
	}

	private findByTransport(transport: OmpTransport): HostSession | undefined {
		for (const session of this.sessions.values()) if (session.transport === transport) return session;
		return undefined;
	}

	private removeSession(session: HostSession): void {
		session.closed = true;
		if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
		if (session.sessionPath && this.byPath.get(pathKey(session.sessionPath)) === session) {
			this.byPath.delete(pathKey(session.sessionPath));
		}
	}

	private requireSession(workspaceId: string, sessionId: string): HostSession {
		const session = this.sessions.get(sessionId);
		if (!session || session.closed) {
			throw new SessionError(
				"UNKNOWN_SESSION",
				"Esta sessão não está mais aberta. Abra a sessão novamente pela lista do projeto.",
			);
		}
		if (session.workspaceId !== workspaceId) {
			throw new SessionError("UNKNOWN_SESSION", "A sessão não pertence a este projeto.");
		}
		return session;
	}

	private nextSequence(session: HostSession): number {
		return session.state.sequence + 1;
	}

	private emitEvent(session: HostSession, name: string, data: unknown): void {
		const sequence = this.nextSequence(session);
		// Toda data de evento passa pela projeção com remoção de campos de dump no
		// topo (`systemPrompt`/`dumpTools` de get_state), conteúdo intacto, e por
		// um teto de tamanho: nenhuma linha do protocolo chega perto de 64 MiB.
		const projected = name === "frame" ? sanitizeFrame(data) : sanitizeRpcResult(data);
		const safeData = capValue(projected, MAX_EVENT_BYTES);
		const event: DesktopEvent = {
			kind: "event",
			workspaceId: session.workspaceId,
			sessionId: session.sessionId,
			generation: session.generation,
			sequence,
			name,
			data: safeData,
		};
		this.options.emit(event);
		const next = applyEvent(session.state, event);
		session.state = next.sequence === sequence ? next : { ...next, sequence };
	}

	private emitStatus(session: HostSession, status: SessionStatus, error?: string): void {
		this.emitEvent(session, "session.status", error ? { status, error } : { status });
	}

	private onFrame(session: HostSession, frame: object): void {
		if (session.closed) return;
		const frameType = isRecord(frame) && typeof frame.type === "string" ? frame.type : "";
		if (frameType === "message_end") session.historyDirty = true;
		if (session.syncing > 0) {
			session.buffer.push(frame);
			return;
		}
		this.emitEvent(session, "frame", frame);
		const type = frameType;
		if (type === "session_settled") {
			this.emitStatus(session, "settled");
			this.scheduleSync(session);
			return;
		}
		if (type === "prompt_result" && isRecord(frame)) {
			const settled = frame.sessionSettled === true;
			if (settled) {
				this.emitStatus(session, "settled");
				this.scheduleSync(session);
			}
			return;
		}
		if (type === "extension_ui_request" && isRecord(frame)) {
			this.handleUiRequest(session, frame);
		}
	}

	/**
	 * `notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`/`open_url`/
	 * `cancel` não exigem resposta. Pedidos desconhecidos que podem travar o
	 * agente são cancelados explicitamente e avisados na conversa.
	 */
	private handleUiRequest(session: HostSession, frame: Record<string, unknown>): void {
		const method = typeof frame.method === "string" ? frame.method : "";
		const id = typeof frame.id === "string" ? frame.id : undefined;
		switch (method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
			case "ask":
			case "notify":
			case "cancel":
			case "setStatus":
			case "setWidget":
			case "setTitle":
			case "set_editor_text":
			case "open_url":
				if (method === "notify") this.options.log.info("dialogo.notify", { sessionId: session.sessionId });
				return;
			default: {
				const label = method.length > 0 ? method : "sem método";
				this.options.log.warn("dialogo.desconhecido", { sessionId: session.sessionId, method: label });
				this.emitEvent(session, "desktop_notice", {
					level: "warning",
					text: `O OMP pediu um diálogo não suportado (${label}); o pedido foi cancelado para não deixar o agente travado.`,
				});
				if (!id || !session.transport) return;
				this.consumeDialog(session, id);
				void session.transport
					.respondUI({ type: "extension_ui_response", id, cancelled: true } as RpcExtensionUIResponse)
					.catch((error: unknown) => {
						this.options.log.warn("dialogo.cancelar_falhou", {
							sessionId: session.sessionId,
							message: (error as Error).message,
						});
					});
			}
		}
	}

	private drainBuffer(session: HostSession, emit: boolean): void {
		let sawSettled = false;
		while (session.buffer.length > 0) {
			const frame = session.buffer.shift();
			if (!frame) break;
			if (isRecord(frame) && (frame.type === "session_settled" || frame.type === "prompt_result")) {
				sawSettled = true;
			}
			if (emit) this.emitEvent(session, "frame", frame);
			else {
				// Inclui no snapshot sem emitir: o renderer recebe o estado já pronto.
				const sequence = this.nextSequence(session);
				const event: DesktopEvent = {
					kind: "event",
					workspaceId: session.workspaceId,
					sessionId: session.sessionId,
					generation: session.generation,
					sequence,
					name: "frame",
					data: capValue(sanitizeFrame(frame), MAX_EVENT_BYTES),
				};
				const next = applyEvent(session.state, event);
				session.state = { ...next, sequence };
			}
		}
		if (emit && sawSettled) {
			this.scheduleSync(session);
		}
	}

	private scheduleSync(session: HostSession): void {
		if (session.syncScheduled || session.closed || !session.transport) return;
		session.syncScheduled = true;
		queueMicrotask(() => {
			session.syncScheduled = false;
			void this.syncAfterSettle(session);
		});
	}

	async snapshot(workspaceId: string, sessionId: string): Promise<SessionSnapshot> {
		const session = this.requireSession(workspaceId, sessionId);
		return compactSnapshot({ state: session.state, sessionPath: session.sessionPath });
	}

	async close(workspaceId: string, sessionId: string): Promise<{ closed: true }> {
		const session = this.requireSession(workspaceId, sessionId);
		const transport = session.transport;
		const pending = session.state.pendingDialogs.slice();
		for (const dialog of pending) session.answeredDialogs.add(dialog.id);
		if (transport) {
			for (const dialog of pending) {
				await transport
					.respondUI({ type: "extension_ui_response", id: dialog.id, cancelled: true } as RpcExtensionUIResponse)
					.catch(() => undefined);
			}
			await transport.close();
		}
		session.transport = undefined;
		for (const dialog of pending) {
			this.emitEvent(session, "desktop_dialog_closed", { id: dialog.id, reason: "session_closed" });
		}
		this.emitStatus(session, "closed");
		this.removeSession(session);
		await this.saveTabs();
		this.options.log.info("sessao.fechada", { sessionId });
		return { closed: true };
	}

	private handleExit(session: HostSession, code: number | null, fatalReason?: string): void {
		if (session.closed || !session.transport) return;
		session.transport = undefined;
		session.ready = false;
		for (const dialog of session.state.pendingDialogs.slice()) {
			session.answeredDialogs.add(dialog.id);
			this.emitEvent(session, "desktop_dialog_closed", { id: dialog.id, reason: "host_exited" });
		}
		for (const prompt of Object.values(session.state.prompts)) {
			if (prompt.status === "sent" || prompt.status === "acked") {
				this.emitEvent(session, "desktop_prompt", {
					promptId: prompt.id,
					status: "interrupted",
					error: "O processo do OMP encerrou durante a solicitação.",
				});
			}
		}
		const message =
			fatalReason ??
			`O processo do OMP encerrou inesperadamente (código ${code ?? "desconhecido"}). A conversa foi preservada; reabra a sessão para continuar.`;
		this.emitStatus(session, "interrupted", message);
		this.emitEvent(session, "desktop_notice", { level: "error", text: message });
		this.options.log.error("sessao.omp_encerrou", {
			sessionId: session.sessionId,
			code,
			fatalReasonLength: fatalReason?.length ?? 0,
			transcriptPreservado: true,
		});
	}

	async rpc(input: {
		workspaceId: string;
		sessionId: string;
		command: unknown;
	}): Promise<unknown> {
		const session = this.requireSession(input.workspaceId, input.sessionId);
		const command = input.command as RpcCommand;
		if (!isRecord(command) || typeof command.type !== "string") {
			throw new SessionError("INVALID_REQUEST", "Comando RPC inválido.");
		}
		const transport = session.transport;
		if (!transport) {
			throw new SessionError(
				"HOST_EXITED",
				"O processo desta sessão não está mais ativo. Reabra a sessão; o histórico foi preservado.",
			);
		}
		const result = await this.dispatchRpc(session, command);
		return this.projectRpcResponse(command.type, result);
	}

	/**
	 * Toda resposta de `session.rpc` sai projetada: campos de transporte fora,
	 * conteúdo de conversa intacto, tamanho limitado por evento.
	 */
	private projectRpcResponse(type: string, value: unknown): unknown {
		if (type === "get_available_models") return { models: projectModels(value) };
		if (type === "set_model") return projectModel(value);
		const sanitized = sanitizeRpcResult(value);
		return capValue(sanitized, MAX_EVENT_BYTES);
	}

	private async dispatchRpc(session: HostSession, command: RpcCommand): Promise<unknown> {
		switch (command.type) {
			case "prompt":
				return this.sendPrompt(session, command);
			case "steer":
			case "follow_up": {
				const prepared = this.prepareTextCommand(session, command);
				const response = await this.transportRequest(session, prepared);
				return response.data ?? null;
			}
			case "get_state": {
				const data = await this.requestData(session, command);
				if (isRecord(data)) {
					session.supportsImages = supportsImagesFromRpcState(data);
					this.emitEvent(session, "desktop_state", data);
				}
				return data;
			}
			case "get_available_commands": {
				const data = await this.requestData(session, command);
				if (isRecord(data)) this.emitEvent(session, "desktop_commands", data);
				return data;
			}
			case "get_available_thinking_levels": {
				const data = await this.requestData(session, command);
				if (isRecord(data)) this.emitEvent(session, "desktop_thinking_levels", data);
				return data;
			}
			case "get_session_stats": {
				const data = await this.requestData(session, command);
				if (isRecord(data)) this.emitEvent(session, "desktop_stats", data);
				return data;
			}
			case "get_subagents": {
				const data = await this.requestData(session, command);
				if (isRecord(data)) this.emitAgentsFromSnapshots(session, data.subagents);
				return data;
			}
			case "set_model":
			case "set_thinking_level":
			case "set_fast_mode":
			case "set_auto_compaction":
			case "set_auto_retry":
			case "goal":
			case "set_session_name": {
				const data = await this.requestData(session, command);
				await this.refreshState(session);
				if (command.type === "set_model") await this.refreshThinkingLevels(session);
				return data;
			}
			case "fork":
			case "branch":
			case "navigate_tree": {
				const data = await this.requestData(session, command);
				const cancelled = isRecord(data) && data.cancelled === true;
				if (!cancelled) await this.replaceWithSnapshot(session);
				return data;
			}
			case "compact": {
				// O OMP aborta o turno em andamento para compactar: nunca compactar
				// por engano enquanto o agente trabalha (a UI também desabilita).
				if (session.state.status === "busy" || session.state.meta?.isStreaming === true) {
					throw new SessionError("SESSION_BUSY", "O agente está trabalhando. Pare ou espere terminar antes de compactar.");
				}
				const data = await this.requestData(session, command);
				await this.refreshState(session);
				await this.refreshStats(session);
				return data;
			}
			case "abort":
			case "abort_and_restore_queue": {
				const data = await this.requestData(session, command);
				return data;
			}
			default: {
				const response = await this.transportRequest(session, command);
				return response.data ?? null;
			}
		}
	}

	private async transportRequest(
		session: HostSession,
		command: RpcCommand,
	): Promise<{ data?: unknown; success: boolean }> {
		const transport = session.transport;
		if (!transport) {
			throw new SessionError("HOST_EXITED", "O processo desta sessão encerrou. Reabra a sessão para continuar.");
		}
		let response: RpcResponse;
		try {
			// Operações longas (compactar, exportar, histórico enorme) não cabem no
			// timeout padrão: o OMP continuaria trabalhando e a UI veria um erro falso.
			response = await transport.request(command, undefined, LONG_RPC_TIMEOUT_MS[command.type]);
		} catch (error) {
			throw asSessionError(error);
		}
		if (response.success === false) {
			throw mapRpcFailure(response.error, response.code);
		}
		return { success: true, data: responseData(response) };
	}

	private async requestData(session: HostSession, command: RpcCommand): Promise<unknown> {
		const response = await this.transportRequest(session, command);
		return response.data ?? null;
	}

	private prepareTextCommand(session: HostSession, command: RpcCommand & { attachmentIds?: string[] }): RpcCommand {
		const { attachmentIds: rawAttachmentIds, ...withoutAttachments } = command;
		const attachmentIds = Array.isArray(rawAttachmentIds) ? rawAttachmentIds : [];
		if (attachmentIds.length === 0) return withoutAttachments as RpcCommand;
		const resolved = this.options.attachments.resolveForPrompt(attachmentIds, {
			workspaceId: session.workspaceId,
			supportsImages: session.supportsImages,
		});
		const base = withoutAttachments as RpcCommand & { message?: string; images?: unknown };
		const original = typeof base.message === "string" ? base.message : "";
		const message = resolved.textSuffix
			? `${original}${original.length > 0 ? "\n\n" : ""}${resolved.textSuffix}`
			: original;
		const prepared = {
			...withoutAttachments,
			message,
			...(resolved.images.length > 0 ? { images: resolved.images } : {}),
		};
		const fit = commandFits(prepared, session.transport?.maxRequestBytes ?? 1024 * 1024);
		if (!fit.fits) {
			throw new SessionError(
				"FRAME_TOO_LARGE",
				`O texto e os anexos somam ${Math.ceil(fit.bytes / 1024)} KiB e excedem o limite de ${
					Math.floor((session.transport?.maxRequestBytes ?? 1024 * 1024) / 1024)
				} KiB aceito pelo OMP. Remova um anexo ou reduza a imagem; nada foi enviado.`,
			);
		}
		return prepared as RpcCommand;
	}

	private async sendPrompt(session: HostSession, command: RpcCommand & { attachmentIds?: string[] }): Promise<unknown> {
		const prepared = this.prepareTextCommand(session, command);
		const transport = session.transport;
		if (!transport) throw new SessionError("HOST_EXITED", "O processo desta sessão encerrou.");
		const promptId = `prompt-${session.generation}-${++session.promptCounter}`;
		this.emitEvent(session, "desktop_prompt", { promptId, status: "sent" });
		// O OMP não publica "começou a trabalhar": quem sabe é o host, no ack do pedido.
		// Sem isso a interface não mostra Trabalhando/Parar durante um turno longo.
		this.emitStatus(session, "busy");
		let response: RpcResponse;
		try {
			response = await transport.request({ ...prepared, id: promptId });
		} catch (error) {
			const mapped = asSessionError(error);
			// Indeterminação (timeout, queda, falha de escrita) NUNCA vira "error"
			// reenviável: o OMP pode ter executado ferramentas. Marca interrompido.
			this.emitEvent(session, "desktop_prompt", {
				promptId,
				status: "interrupted",
				error: `Não foi possível confirmar o recebimento do pedido pelo OMP. Ele pode ter sido executado; confira a conversa antes de enviar de novo. (${mapped.message})`,
			});
			throw mapped;
		}
		if (response.success === false) {
			const mapped = mapRpcFailure(response.error, response.code);
			this.emitEvent(session, "desktop_prompt", { promptId, status: "error", error: mapped.message });
			throw mapped;
		}
		this.emitEvent(session, "desktop_prompt", { promptId, status: "acked" });
		const promptData = responseData(response);
		const agentInvoked = isRecord(promptData) && promptData.agentInvoked === true;
		if (!agentInvoked) {
			this.emitEvent(session, "desktop_prompt", { promptId, status: "completed" });
		}
		return promptData ?? null;
	}

	async uiResponse(input: {
		workspaceId: string;
		sessionId: string;
		response: unknown;
	}): Promise<{ delivered: boolean }> {
		const session = this.requireSession(input.workspaceId, input.sessionId);
		const response = input.response;
		if (!isRecord(response) || typeof response.id !== "string") {
			throw new SessionError("INVALID_REQUEST", "Resposta de diálogo inválida.");
		}
		const dialog = session.state.pendingDialogs.find((item) => item.id === response.id);
		// Segunda resposta ao mesmo id nunca é reenviada ao OMP.
		if (!dialog || session.answeredDialogs.has(response.id)) return { delivered: false };
		this.validateDialogResponse(dialog, response);
		// Consumo ATÔMICO: sem `await` entre localizar e remover, duas chamadas
		// concorrentes não conseguem enviar a mesma resposta.
		this.consumeDialog(session, dialog.id);
		const transport = session.transport;
		if (!transport) {
			this.emitEvent(session, "desktop_dialog_closed", { id: response.id, reason: "session_closed" });
			return { delivered: false };
		}
		// Fronteira validada pelo `uiResponseSchema` no host e pelas opções ofertadas.
		const uiResponse = response as unknown as RpcExtensionUIResponse;
		try {
			await transport.respondUI(uiResponse);
		} catch (error) {
			// Falha de envio com processo vivo: devolve o diálogo para o usuário.
			session.answeredDialogs.delete(response.id);
			if (session.transport) {
				session.state = {
					...session.state,
					pendingDialogs: [...session.state.pendingDialogs, dialog].sort(
						(left, right) => left.receivedAt - right.receivedAt,
					),
				};
			}
			throw asSessionError(error);
		}
		this.emitEvent(session, "desktop_dialog_closed", {
			id: response.id,
			reason: "cancelled" in response && response.cancelled === true ? "cancelled" : "answered",
		});
		return { delivered: true };
	}

	/** Remove o diálogo do estado imediatamente (síncrono). */
	private consumeDialog(session: HostSession, id: string): void {
		session.answeredDialogs.add(id);
		if (!session.state.pendingDialogs.some((item) => item.id === id)) return;
		session.state = {
			...session.state,
			pendingDialogs: session.state.pendingDialogs.filter((item) => item.id !== id),
		};
	}

	private validateDialogResponse(dialog: PendingDialog, response: Record<string, unknown>): void {
		if (response.cancelled === true) return;
		if (dialog.method === "ask") {
			if (!Array.isArray(response.answers)) {
				throw new SessionError("INVALID_REQUEST", "Este diálogo exige resposta para cada pergunta.");
			}
			const questions = new Map((dialog.questions ?? []).map((question) => [question.id, question]));
			const seen = new Set<string>();
			for (const answer of response.answers) {
				if (!isRecord(answer) || typeof answer.id !== "string") {
					throw new SessionError("INVALID_REQUEST", "A resposta não corresponde às perguntas deste diálogo.");
				}
				const question = questions.get(answer.id);
				if (!question) {
					throw new SessionError("INVALID_REQUEST", "A resposta não corresponde às perguntas deste diálogo.");
				}
				if (seen.has(answer.id)) {
					throw new SessionError("INVALID_REQUEST", "Há mais de uma resposta para a mesma pergunta.");
				}
				seen.add(answer.id);
				const labels = new Set(question.options.map((option) => option.label));
				const selected = Array.isArray(answer.selectedOptions) ? answer.selectedOptions : [];
				for (const option of selected) {
					if (typeof option !== "string" || !labels.has(option)) {
						throw new SessionError(
							"INVALID_REQUEST",
							"A opção escolhida não foi oferecida nesta pergunta. Recarregue o diálogo e tente novamente.",
						);
					}
				}
				if (question.multi !== true && selected.length > 1) {
					throw new SessionError("INVALID_REQUEST", "Esta pergunta aceita apenas uma opção.");
				}
			}
			if (seen.size !== questions.size) {
				throw new SessionError("INVALID_REQUEST", "Responda todas as perguntas deste diálogo.");
			}
			return;
		}
		if ("answers" in response) {
			throw new SessionError("INVALID_REQUEST", "Este diálogo não aceita respostas de múltipla escolha.");
		}
		if (dialog.method === "select") {
			if ("value" in response) {
				const options = dialog.options ?? [];
				if (typeof response.value !== "string" || !options.includes(response.value)) {
					throw new SessionError(
						"INVALID_REQUEST",
						"A opção escolhida não foi oferecida neste diálogo. Recarregue o diálogo e tente novamente.",
					);
				}
			}
			return;
		}
		if (dialog.method === "confirm" && typeof response.confirmed !== "boolean" && !("value" in response)) {
			throw new SessionError("INVALID_REQUEST", "Este diálogo exige confirmação explícita.");
		}
		if ("value" in response && typeof response.value !== "string") {
			throw new SessionError("INVALID_REQUEST", "O valor do diálogo precisa ser texto.");
		}
	}

	async subagentTranscript(input: {
		workspaceId: string;
		sessionId: string;
		subagentId: string;
		fromByte?: number;
	}): Promise<SubagentTranscript> {
		const session = this.requireSession(input.workspaceId, input.sessionId);
		try {
			const transcript = await readSubagentTranscript(
				{
					transport: session.transport,
					parentSessionFile: session.sessionPath,
					agents: session.state.agents,
				},
				input.subagentId,
				input.fromByte ?? 0,
			);
			const messages = capValue(transcript.messages, MAX_EVENT_BYTES);
			return { ...transcript, messages: Array.isArray(messages) ? messages : [messages] };
		} catch (error) {
			throw asSessionError(error);
		}
	}

	async exportHtml(input: {
		workspaceId: string;
		sessionId: string;
		destinationPath: string;
	}): Promise<{ path: string }> {
		const session = this.requireSession(input.workspaceId, input.sessionId);
		const data = await this.requestData(session, {
			type: "export_html",
			outputPath: input.destinationPath,
		});
		const exported = isRecord(data) && typeof data.path === "string" ? data.path : input.destinationPath;
		return { path: exported };
	}

	async applyPreset(input: {
		workspaceId: string;
		sessionId: string;
		name: string;
	}): Promise<{ applied: true; preset: string; modelRoles: Record<string, string> }> {
		const session = this.requireSession(input.workspaceId, input.sessionId);
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(input.name)) {
			throw new SessionError("INVALID_REQUEST", `Nome de preset inválido: "${input.name}".`);
		}
		if (!session.state.commands.some((command) => command.name === "modelpreset")) {
			throw new SessionError(
				"UNSUPPORTED",
				"Este executável do OMP não anunciou o comando /modelpreset; o preset não foi aplicado.",
			);
		}
		const settings = await this.options.settings.list(session.cwd);
		const preset = settings.presets[input.name];
		if (!preset) {
			throw new SessionError("INVALID_REQUEST", `O preset "${input.name}" não existe na configuração do OMP.`);
		}
		const transport = session.transport;
		if (!transport) throw new SessionError("HOST_EXITED", "O processo desta sessão encerrou.");
		const waiter = Promise.withResolvers<string | undefined>();
		const unsubscribe = transport.subscribe((frame) => {
			if (!isRecord(frame)) return;
			if (frame.type === "command_output" && typeof frame.text === "string") waiter.resolve(frame.text);
			if (frame.type === "config_update") waiter.resolve(undefined);
		});
		const timer = setTimeout(() => waiter.resolve(undefined), 20_000);
		try {
			await this.sendPrompt(session, {
				type: "prompt",
				message: `/modelpreset switch ${input.name}`,
			});
			const output = await waiter.promise;
			if (output && !/^Switched to preset/.test(output)) {
				throw new SessionError("INTERNAL", `O OMP não aplicou o preset: ${output}`);
			}
			const fresh = await this.options.settings.list(session.cwd);
			const rolesMatch = Object.entries(preset.modelRoles).every(
				([role, model]) => fresh.modelRoles[role] === model,
			);
			if (!rolesMatch) {
				throw new SessionError(
					"INTERNAL",
					"O OMP respondeu ao comando, mas os papéis de modelo não refletem o preset. Recarregue as configurações.",
				);
			}
			await this.refreshState(session);
			return { applied: true, preset: input.name, modelRoles: fresh.modelRoles };
		} finally {
			clearTimeout(timer);
			unsubscribe();
		}
	}

	// -----------------------------------------------------------------------
	// Snapshot / sincronização
	// -----------------------------------------------------------------------

	private applyLocal(
		session: HostSession,
		state: SessionViewState,
		name: string,
		data: unknown,
	): SessionViewState {
		const sequence = state.sequence + 1;
		const event: DesktopEvent = {
			kind: "event",
			workspaceId: session.workspaceId,
			sessionId: session.sessionId,
			generation: session.generation,
			sequence,
			name,
			data: capValue(sanitizeRpcResult(data), MAX_EVENT_BYTES),
		};
		const next = applyEvent(state, event);
		return { ...next, sequence };
	}

	private async buildSnapshot(
		session: HostSession,
		options: { drainBuffer: boolean },
	): Promise<SessionSnapshot> {
		const transport = session.transport;
		if (!transport) throw new SessionError("HOST_EXITED", "O processo do OMP encerrou.");
		let state = createSessionState({
			workspaceId: session.workspaceId,
			sessionId: session.sessionId,
			generation: session.generation,
		});
		state.status = "starting";
		const stateData = await this.requestData(session, { type: "get_state" });
		if (!isRecord(stateData)) {
			throw new SessionError("OMP_INCOMPATIBLE", "O OMP não informou o estado da sessão.");
		}
		session.supportsImages = supportsImagesFromRpcState(stateData);
		session.sessionPath =
			typeof stateData.sessionFile === "string" ? stateData.sessionFile : session.sessionPath;
		if (session.sessionPath) this.byPath.set(pathKey(session.sessionPath), session);
		state = this.applyLocal(session, state, "desktop_state", stateData);
		const status = stateData.isStreaming === true ? "busy" : stateData.isSettled === true ? "settled" : "ready";
		state = this.applyLocal(session, state, "desktop_status", { status });

		const commands = await this.requestData(session, { type: "get_available_commands" }).catch(() => undefined);
		if (isRecord(commands)) state = this.applyLocal(session, state, "desktop_commands", commands);
		const levels = await this.requestData(session, {
			type: "get_available_thinking_levels",
		}).catch(() => undefined);
		if (isRecord(levels)) state = this.applyLocal(session, state, "desktop_thinking_levels", levels);

		const history = await this.readHistory(session).catch((error: unknown) => {
			this.options.log.warn("sessao.historico_inicial_falhou", {
				message: (error as Error).message,
			});
			return undefined;
		});
		if (history) {
			session.pagedHistory = history.paged;
			const compacted = compactHistory(history.messages, history.tools);
			state = this.applyLocal(session, state, "desktop_history", {
				messages: compacted.messages,
				tools: compacted.tools,
			});
			if (compacted.dropped > 0 || compacted.truncated) {
				state = this.applyLocal(session, state, "desktop_notice", {
					level: "warning",
					text:
						compacted.dropped > 0
							? `O histórico é muito grande: ${compacted.dropped} mensagens antigas não couberam na janela de exibição e permanecem salvas no OMP.`
							: "Parte do histórico muito grande foi resumida na exibição; o conteúdo completo continua salvo no OMP.",
				});
			}
			const finalized = finalizedAgentsFromMessages(history.rawMessages);
			session.finalizedAgents = mergeAgentRows(finalized, [], session.finalizedAgents);
		}
		const stats = await this.requestData(session, { type: "get_session_stats" }).catch(() => undefined);
		if (isRecord(stats)) state = this.applyLocal(session, state, "desktop_stats", stats);
		const subagents = await this.requestData(session, { type: "get_subagents" }).catch(() => undefined);
		const liveAgents =
			isRecord(subagents) && Array.isArray(subagents.subagents)
				? subagents.subagents
						.map(agentRowFromSnapshot)
						.filter((agent): agent is AgentRow => agent !== null)
				: [];
		const agents = mergeAgentRows(
			session.finalizedAgents,
			liveAgents,
			session.state.agents.filter((agent) => agent.finalized),
		);
		state = this.applyLocal(session, state, "desktop_agents", { agents });

		session.state = state;
		if (options.drainBuffer) this.drainBuffer(session, false);
		return compactSnapshot({ state: session.state, sessionPath: session.sessionPath });
	}

	private async readHistory(
		session: HostSession,
	): Promise<{
		messages: ChatMessage[];
		tools: Record<string, ToolExecution>;
		rawMessages: unknown[];
		paged: boolean;
	}> {
		try {
			const entries = await this.requestData(session, { type: "get_entries" });
			if (isRecord(entries) && Array.isArray(entries.entries)) {
				const branch = branchMessages(entries.entries, entries.leafId);
				return {
					messages: branch.messages,
					tools: toolsFromMessages(branch.messages),
					rawMessages: branch.rawMessages,
					paged: false,
				};
			}
		} catch (error) {
			this.options.log.warn("sessao.entries_indisponivel", { message: (error as Error).message });
		}
		const paged = await this.readHistoryPages(session);
		return { ...paged, paged: true };
	}

	private async readHistoryPages(session: HostSession): Promise<{
		messages: ChatMessage[];
		tools: Record<string, ToolExecution>;
		rawMessages: unknown[];
	}> {
		const rawMessages: unknown[] = [];
		let cursor: string | undefined;
		let attempt = 0;
		for (;;) {
			const response = await this.transportRequest(session, {
				type: "get_messages_page",
				...(cursor ? { cursor } : {}),
				limit: 256,
			});
			const data = response.data;
			if (!isRecord(data) || !Array.isArray(data.messages)) break;
			rawMessages.push(...data.messages);
			cursor = typeof data.nextCursor === "string" ? data.nextCursor : undefined;
			if (!cursor) break;
			attempt += 1;
			if (attempt > 200) {
				this.options.log.warn("sessao.historico_longo", { sessionId: session.sessionId, pages: attempt });
				break;
			}
		}
		const messages = rawMessages.map((raw, index) =>
			chatMessageFromRaw(raw, {
				generation: session.generation,
				key: `hist:${session.generation}:${index}`,
				streaming: false,
			}),
		);
		return { messages, tools: toolsFromMessages(messages), rawMessages };
	}

	private async refreshState(session: HostSession): Promise<void> {
		if (!session.transport) return;
		try {
			const data = await this.requestData(session, { type: "get_state" });
			if (isRecord(data)) {
				session.supportsImages = supportsImagesFromRpcState(data);
				if (typeof data.sessionFile === "string") session.sessionPath = data.sessionFile;
				this.emitEvent(session, "desktop_state", data);
			}
		} catch (error) {
			this.options.log.warn("sessao.estado_falhou", { message: (error as Error).message });
		}
	}

	private async refreshThinkingLevels(session: HostSession): Promise<void> {
		if (!session.transport) return;
		try {
			const data = await this.requestData(session, { type: "get_available_thinking_levels" });
			if (isRecord(data)) this.emitEvent(session, "desktop_thinking_levels", data);
		} catch {
			/* opcional */
		}
	}

	private async refreshStats(session: HostSession): Promise<void> {
		if (!session.transport) return;
		try {
			const data = await this.requestData(session, { type: "get_session_stats" });
			if (isRecord(data)) this.emitEvent(session, "desktop_stats", data);
		} catch (error) {
			this.options.log.warn("sessao.stats_falhou", { message: (error as Error).message });
		}
	}

	private emitAgentsFromSnapshots(session: HostSession, raw: unknown): void {
		const live = Array.isArray(raw)
			? raw.map(agentRowFromSnapshot).filter((agent): agent is AgentRow => agent !== null)
			: [];
		const agents = mergeAgentRows(
			session.finalizedAgents,
			live,
			session.state.agents.filter((agent) => agent.finalized),
		);
		this.emitEvent(session, "desktop_agents", { agents });
	}

	private async syncAfterSettle(session: HostSession): Promise<void> {
		if (session.closed || !session.transport || session.syncing > 0) return;
		const token = ++session.syncToken;
		session.syncing = 1;
		try {
			await this.refreshState(session);
			await this.refreshStats(session);
			try {
				const subagents = await this.requestData(session, { type: "get_subagents" });
				if (isRecord(subagents)) this.emitAgentsFromSnapshots(session, subagents.subagents);
			} catch {
				/* opcional */
			}
			const shouldRefreshHistory = session.historyDirty || session.pagedHistory;
			if (shouldRefreshHistory) {
				session.historyDirty = false;
				try {
					const history = await this.readHistory(session);
					session.pagedHistory = history.paged;
					const finalized = finalizedAgentsFromMessages(history.rawMessages);
					session.finalizedAgents = mergeAgentRows(finalized, [], session.finalizedAgents);
					const compacted = compactHistory(history.messages, history.tools);
					this.emitEvent(session, "desktop_history", {
						messages: compacted.messages,
						tools: compacted.tools,
					});
					if (compacted.dropped > 0) {
						this.emitEvent(session, "desktop_notice", {
							level: "warning",
							text: `O histórico é muito grande: ${compacted.dropped} mensagens antigas não couberam na janela de exibição e permanecem salvas no OMP.`,
						});
					}
				} catch (error) {
					session.historyDirty = true;
					this.options.log.warn("sessao.historico_sync_falhou", {
						message: (error as Error).message,
					});
				}
			}
		} finally {
			if (token === session.syncToken) {
				session.syncing = 0;
				if (session.buffer.length > 0) this.drainBuffer(session, true);
			}
		}
	}

	private async replaceWithSnapshot(session: HostSession): Promise<void> {
		if (!session.transport) return;
		const token = ++session.syncToken;
		session.syncing = 1;
		try {
			const stateResponse = await this.requestData(session, { type: "get_state" });
			if (isRecord(stateResponse) && typeof stateResponse.sessionFile === "string") {
				session.sessionPath = stateResponse.sessionFile;
				if (session.sessionPath) this.byPath.set(pathKey(session.sessionPath), session);
			}
			const snapshot = await this.buildSnapshot(session, { drainBuffer: false });
			if (token !== session.syncToken) return;
			const nextSequence = session.state.sequence + 1;
			const event: DesktopEvent = {
				kind: "event",
				workspaceId: session.workspaceId,
				sessionId: session.sessionId,
				generation: session.generation,
				sequence: nextSequence,
				name: "desktop_snapshot",
				data: { ...snapshot, state: { ...snapshot.state, sequence: nextSequence } },
			};
			this.options.emit(event);
			session.state = applyEvent(session.state, event);
			session.state = { ...session.state, sequence: nextSequence };
		} finally {
			if (token === session.syncToken) {
				session.syncing = 0;
				if (session.buffer.length > 0) this.drainBuffer(session, true);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Abas persistentes
	// -----------------------------------------------------------------------

	/** Lista de abas desejada a partir das sessões abertas (sem tocar no arquivo). */
	private collectTabs(): TabRecord[] {
		const seen = new Set<string>();
		const tabs: TabRecord[] = [];
		for (const session of this.sessions.values()) {
			if (session.closed || !session.sessionPath) continue;
			const key = pathKey(session.sessionPath);
			if (seen.has(key)) continue;
			seen.add(key);
			tabs.push({
				workspaceId: session.workspaceId,
				sessionPath: session.sessionPath,
				cwd: session.cwd,
				profile: session.profile,
			});
		}
		return tabs;
	}

	private async writeTabs(tabs: TabRecord[]): Promise<void> {
		const payload: TabsFile = { version: 1, tabs };
		try {
			await writeFileAtomic(this.tabsFile, `${JSON.stringify(payload, null, 2)}\n`);
		} catch (error) {
			this.options.log.warn("abas.salvar_falhou", { message: (error as Error).message });
		}
	}

	async saveTabs(): Promise<void> {
		// Durante restauração/encerramento em lote o arquivo é escrito uma vez, ao
		// final: gravar a cada `open`/`close` truncaria tabs.json no meio do lote.
		if (this.tabSaveSuppressed > 0) return;
		await this.writeTabs(this.collectTabs());
	}

	/** Reabre abas persistidas sem prompt; falhas ficam no log e não bloqueiam o app. */
	/** Restauração em andamento: `list()` espera para não responder antes das abas abrirem. */
	private restorePromise: Promise<void> | null = null;

	/** Chamado pelo host no boot; idempotente. */
	startRestore(): Promise<void> {
		if (!this.restorePromise) {
			this.restorePromise = this.restoreTabs().finally(() => {
				this.restorePromise = null;
			});
		}
		return this.restorePromise;
	}

	async restoreTabs(): Promise<void> {
		let tabs: TabRecord[] = [];
		try {
			const raw = JSON.parse(await fs.promises.readFile(this.tabsFile, "utf8")) as unknown;
			if (isRecord(raw) && Array.isArray(raw.tabs)) {
				tabs = raw.tabs
					.filter(isRecord)
					.map((item) => ({
						workspaceId: typeof item.workspaceId === "string" ? item.workspaceId : "",
						sessionPath: typeof item.sessionPath === "string" ? item.sessionPath : "",
						cwd: typeof item.cwd === "string" ? item.cwd : "",
						profile:
							typeof item.profile === "string" && item.profile.trim().length > 0
								? item.profile.trim()
								: undefined,
					}))
					.filter((item) => item.workspaceId && item.sessionPath);
			}
		} catch {
			return;
		}
		if (tabs.length === 0) return;
		// Lista desejada: abas que abriram e abas que falharam por motivo
		// transitório (lease/transporte) continuam para a próxima abertura. Só
		// saem as que apontam para projeto/arquivo que não existe mais.
		const keep: TabRecord[] = [];
		const seen = new Set<string>();
		this.tabSaveSuppressed++;
		try {
			for (const tab of tabs) {
				const key = pathKey(tab.sessionPath);
				if (seen.has(key)) continue;
				let workspace: WorkspaceDto | undefined;
				try {
					workspace = await this.options.workspaces.get(tab.workspaceId);
				} catch (error) {
					// Falha ao ler o registro de projetos: mantém a aba para a próxima.
					seen.add(key);
					keep.push(tab);
					this.options.log.warn("abas.restaurar_falhou", {
						workspaceId: tab.workspaceId,
						message: (error as Error).message,
					});
					continue;
				}
				if (!workspace?.available) continue;
				try {
					await fs.promises.access(tab.sessionPath);
				} catch {
					// Arquivo de sessão removido: a aba não faz mais sentido.
					continue;
				}
				seen.add(key);
				try {
					if (!this.byPath.get(key)) {
						// Perfil persistido é reutilizado (e não o perfil padrão): abrir a
						// sessão no perfil errado falharia com UNKNOWN_SESSION.
						await this.open(tab.workspaceId, tab.sessionPath, { profile: tab.profile, trustedPath: true });
					}
					keep.push(tab);
				} catch (error) {
					// Falha transitória (lease/transporte): a aba continua desejada.
					keep.push(tab);
					this.options.log.warn("abas.restaurar_falhou", {
						workspaceId: tab.workspaceId,
						message: (error as Error).message,
					});
				}
			}
		} finally {
			this.tabSaveSuppressed--;
		}
		// Grava a lista desejada de uma vez, ao final: nada de truncar o arquivo
		// entre uma aba e outra. Sessões abertas durante a restauração entram na
		// lista (o save delas foi suprimido).
		const openTabs = this.collectTabs();
		const openKeys = new Set(openTabs.map((tab) => pathKey(tab.sessionPath)));
		const desired = [
			...openTabs,
			...keep.filter((tab) => !openKeys.has(pathKey(tab.sessionPath))),
		];
		await this.writeTabs(desired);
	}

	async closeAll(): Promise<void> {
		// Captura ANTES de fechar: `close()` removeria as sessões e o save final
		// gravaria uma lista vazia, apagando as abas no encerramento normal.
		const tabs = this.collectTabs();
		const sessions = [...this.sessions.values()];
		this.options.log.info("abas.encerrando", { tabs: tabs.length, sessions: sessions.length });
		this.tabSaveSuppressed++;
		try {
			await Promise.all(
				sessions.map(async (session) => {
					try {
						await this.close(session.workspaceId, session.sessionId);
					} catch {
						await session.transport?.close().catch(() => undefined);
					}
				}),
			);
		} finally {
			this.tabSaveSuppressed--;
		}
		if (tabs.length > 0) await this.writeTabs(tabs);
	}

	/** Fecha as sessões de um projeto removido/relocalizado (nunca apaga arquivos). */
	async closeWorkspace(workspaceId: string): Promise<void> {
		const sessions = [...this.sessions.values()].filter((session) => session.workspaceId === workspaceId);
		await Promise.all(
			sessions.map(async (session) => {
				try {
					await this.close(session.workspaceId, session.sessionId);
				} catch {
					await session.transport?.close().catch(() => undefined);
					this.removeSession(session);
				}
			}),
		);
	}
}

function responseData(response: RpcResponse): unknown {
	if (response.success === true && "data" in response) return response.data;
	return undefined;
}

function supportsImagesFromRpcState(state: Record<string, unknown>): boolean {
	const model = isRecord(state.model) ? state.model : undefined;
	const input = model?.input;
	// Sem `input` anunciado pelo modelo, o suporte é DESCONHECIDO: o padrão
	// conservador é recusar imagens em vez de enviá-las e falhar no provedor.
	if (!Array.isArray(input)) return false;
	return input.includes("image");
}

function mapRpcFailure(error: string, code?: string): SessionError {
	const text = error.trim().length > 0 ? error : "O OMP recusou o comando.";
	if (code === "session_busy" || code === "stale_cursor" || /session busy/i.test(error)) {
		return new SessionError("SESSION_BUSY", "A sessão está ocupada; aguarde o turno atual terminar.");
	}
	if (code === "entry_not_found") {
		return new SessionError("INVALID_REQUEST", "O ponto escolhido não existe mais nesta conversa.");
	}
	if (/transport limit/i.test(error)) {
		return new SessionError(
			"FRAME_TOO_LARGE",
			"A resposta do OMP é grande demais para o transporte atual. Atualize o OMP ou reduza o histórico.",
		);
	}
	return new SessionError("INTERNAL", text);
}

interface BranchResult {
	messages: ChatMessage[];
	rawMessages: unknown[];
}

function branchMessages(entries: readonly unknown[], leafId: unknown): BranchResult {
	const byId = new Map<string, Record<string, unknown>>();
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		byId.set(entry.id, entry);
	}
	const chain: Record<string, unknown>[] = [];
	const visited = new Set<string>();
	let current = typeof leafId === "string" ? leafId : undefined;
	if (!current) {
		// Sem leaf explícito, usa o último que se auto-seleciona.
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (!isRecord(entry) || typeof entry.id !== "string") continue;
			const activeLeaf = entry.activeLeafId;
			if (activeLeaf === undefined || activeLeaf === entry.id) {
				current = entry.id;
				break;
			}
		}
	}
	while (current) {
		if (visited.has(current)) break;
		visited.add(current);
		const entry = byId.get(current);
		if (!entry) break;
		chain.push(entry);
		const parent = entry.parentId;
		current = typeof parent === "string" ? parent : undefined;
	}
	chain.reverse();
	const messages: ChatMessage[] = [];
	const rawMessages: unknown[] = [];
	for (const entry of chain) {
		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		const entryId = typeof entry.id === "string" ? entry.id : undefined;
		if (!entryId) continue;
		messages.push(
			chatMessageFromRaw(entry.message, {
				generation: 0,
				entryId,
				key: `entry:${entryId}`,
				streaming: false,
			}),
		);
		rawMessages.push(entry.message);
	}
	return { messages, rawMessages };
}

function toolsFromMessages(messages: readonly ChatMessage[]): Record<string, ToolExecution> {
	const tools: Record<string, ToolExecution> = {};
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall" || !block.id) continue;
				tools[block.id] = {
					toolCallId: block.id,
					name: block.name,
					arguments: block.arguments,
					intent: block.intent,
					status: tools[block.id]?.status ?? "done",
					partialText: tools[block.id]?.partialText,
					resultText: tools[block.id]?.resultText,
				};
			}
			continue;
		}
		if (message.role === "toolResult" && message.toolCallId) {
			const current = tools[message.toolCallId];
			const resultText = message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("");
			tools[message.toolCallId] = {
				toolCallId: message.toolCallId,
				name: message.toolName ?? current?.name ?? "ferramenta",
				arguments: current?.arguments,
				intent: current?.intent,
				status: message.isError ? "error" : "done",
				partialText: current?.partialText,
				// O diff inline do card vem daqui; sem isto ele some no primeiro settle.
				details: message.details,
				resultText: resultText.length > 0 ? resultText : current?.resultText,
			};
		}
	}
	return tools;
}
