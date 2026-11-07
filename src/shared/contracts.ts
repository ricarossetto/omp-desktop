/**
 * Contratos privados entre renderer, Electron main e host Bun.
 * Somente o integrador altera este arquivo.
 */
import { z } from "zod";
import { DEPENDENCY_KINDS } from "./dependency-install-types";
import type { DependencyRuntimeSnapshot } from "./dependency-install-types";

export type {
	DependencyKind,
	DependencyProbe,
	DependencyRuntimeSnapshot,
	DependencyRuntimeState,
} from "./dependency-install-types";

// ---------------------------------------------------------------------------
// Envelope main <-> host (JSONL em stdin/stdout)
// ---------------------------------------------------------------------------

export const hostRequestSchema = z.object({
	kind: z.literal("request"),
	id: z.string().min(1),
	op: z.string().min(1),
	payload: z.unknown(),
});
export type HostRequest = z.infer<typeof hostRequestSchema>;

export interface HostErrorBody {
	code: string;
	message: string;
}

export type HostResponse =
	| { kind: "response"; id: string; ok: true; data: unknown }
	| { kind: "response"; id: string; ok: false; error: HostErrorBody };

/** Evento emitido pelo host (e repassado pelo main) à janela dona do workspace. */
export interface DesktopEvent {
	kind: "event";
	workspaceId: string;
	sessionId?: string;
	/** Muda a cada processo OMP. */
	generation: number;
	/** Cresce de 1 em 1 por sessão e geração; lacunas indicam perda e exigem snapshot. */
	sequence: number;
	/**
	 * `frame` (frame RPC já sanitizado, data = objeto do frame),
	 * `host.status`, `session.status`, `terminal.data`, `terminal.exit`.
	 */
	name: string;
	data: unknown;
}

export type HostMessage = HostResponse | DesktopEvent;

// ---------------------------------------------------------------------------
// Comandos RPC aceitos em session.rpc (subconjunto usado pelas telas)
// ---------------------------------------------------------------------------

const thinking = z.enum(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const attachmentIds = z.array(z.string()).max(16).optional();

export const rpcCommandSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("prompt"), message: z.string(), attachmentIds, streamingBehavior: z.enum(["steer", "followUp"]).optional() }),
	z.object({ type: z.literal("steer"), message: z.string(), attachmentIds }),
	z.object({ type: z.literal("follow_up"), message: z.string(), attachmentIds }),
	z.object({ type: z.literal("remove_queued_message"), message: z.string(), queue: z.enum(["steering", "followUp"]) }),
	z.object({ type: z.literal("promote_queued_message"), message: z.string() }),
	z.object({ type: z.literal("abort") }),
	z.object({ type: z.literal("abort_and_restore_queue") }),
	z.object({ type: z.literal("get_state") }),
	z.object({ type: z.literal("get_available_models") }),
	z.object({ type: z.literal("get_available_thinking_levels") }),
	z.object({ type: z.literal("get_available_commands") }),
	z.object({ type: z.literal("set_model"), provider: z.string().min(1), modelId: z.string().min(1) }),
	z.object({ type: z.literal("set_thinking_level"), level: thinking }),
	z.object({ type: z.literal("set_fast_mode"), enabled: z.boolean() }),
	z.object({ type: z.literal("set_auto_compaction"), enabled: z.boolean() }),
	z.object({ type: z.literal("set_auto_retry"), enabled: z.boolean() }),
	z.object({ type: z.literal("abort_retry") }),
	z.object({ type: z.literal("compact"), customInstructions: z.string().optional() }),
	z.object({ type: z.literal("get_session_stats") }),
	z.object({ type: z.literal("get_tree") }),
	z.object({ type: z.literal("navigate_tree"), entryId: z.string().min(1), summarize: z.boolean().optional() }),
	z.object({ type: z.literal("fork"), entryId: z.string().optional() }),
	z.object({ type: z.literal("branch"), entryId: z.string().min(1) }),
	z.object({ type: z.literal("get_branch_messages") }),
	z.object({ type: z.literal("set_session_name"), name: z.string().min(1).max(200) }),
	z.object({ type: z.literal("get_subagents") }),
	z.object({ type: z.literal("get_subagent_messages"), subagentId: z.string().min(1), fromByte: z.number().int().nonnegative().optional() }),
	z.object({ type: z.literal("cancel_subagent"), subagentId: z.string().min(1) }),
	z.object({ type: z.literal("steer_subagent"), subagentId: z.string().min(1), message: z.string().min(1) }),
	z.object({
		type: z.literal("goal"),
		op: z.enum(["create", "pause", "resume", "drop"]),
		objective: z.string().optional(),
		token_budget: z.number().int().positive().optional(),
	}),
	z.object({ type: z.literal("get_login_providers") }),
	z.object({ type: z.literal("login"), providerId: z.string().min(1) }),
	z.object({ type: z.literal("get_logout_accounts"), providerId: z.string().min(1) }),
	z.object({ type: z.literal("logout"), providerId: z.string().min(1), credentialId: z.number().int() }),
]);
export type RpcCommandInput = z.infer<typeof rpcCommandSchema>;

/** Resposta de ui (diálogos de ferramentas). */
export const uiResponseSchema = z.union([
	z.object({ type: z.literal("extension_ui_response"), id: z.string(), value: z.string() }),
	z.object({ type: z.literal("extension_ui_response"), id: z.string(), confirmed: z.boolean() }),
	z.object({ type: z.literal("extension_ui_response"), id: z.string(), cancelled: z.literal(true), timedOut: z.boolean().optional() }),
	z.object({
		type: z.literal("extension_ui_response"),
		id: z.string(),
		answers: z.array(z.object({ id: z.string(), selectedOptions: z.array(z.string()), customInput: z.string().optional() })),
	}),
]);
export type UiResponse = z.infer<typeof uiResponseSchema>;

// ---------------------------------------------------------------------------
// Operações do renderer
// ---------------------------------------------------------------------------

const workspaceId = z.string().min(1);
const sessionId = z.string().min(1);
const relPath = z.string().min(1).max(4096);

export const desktopRequestSchema = z.discriminatedUnion("op", [
	// Ambiente
	z.object({ op: z.literal("runtime.status") }),
	z.object({ op: z.literal("runtime.selectOmp") }),
	z.object({ op: z.literal("runtime.installOmp") }),
	z.object({ op: z.literal("runtime.dependencies") }),
	z.object({ op: z.literal("runtime.installDependency"), dependency: z.enum(DEPENDENCY_KINDS) }),
	z.object({ op: z.literal("runtime.openExternal"), url: z.string().url() }),
	z.object({ op: z.literal("ui.getState") }),
	z.object({ op: z.literal("ui.setState"), state: z.record(z.string(), z.unknown()) }),
	// Workspaces e sessões
	z.object({ op: z.literal("workspace.pick") }),
	z.object({ op: z.literal("workspace.list") }),
	z.object({ op: z.literal("workspace.removeRecent"), workspaceId }),
	z.object({ op: z.literal("workspace.relocate"), workspaceId }),
	z.object({ op: z.literal("session.list"), workspaceId }),
	z.object({ op: z.literal("session.create"), workspaceId }),
	z.object({ op: z.literal("session.open"), workspaceId, sessionPath: z.string().min(1) }),
	z.object({ op: z.literal("session.close"), workspaceId, sessionId }),
	z.object({ op: z.literal("session.snapshot"), workspaceId, sessionId }),
	z.object({ op: z.literal("session.rpc"), workspaceId, sessionId, command: rpcCommandSchema }),
	z.object({ op: z.literal("session.uiResponse"), workspaceId, sessionId, response: uiResponseSchema }),
	z.object({ op: z.literal("session.exportHtml"), workspaceId, sessionId }),
	z.object({ op: z.literal("session.subagentTranscript"), workspaceId, sessionId, subagentId: z.string().min(1), fromByte: z.number().int().nonnegative().optional() }),
	// Configuração e contas
	// `workspaceId` é opcional nas operações globais: o onboarding roda antes de
	// existir um projeto e usa o diretório do usuário como cwd. Quando presente,
	// o host valida o projeto como antes.
	z.object({ op: z.literal("settings.list"), workspaceId: workspaceId.optional() }),
	z.object({
		op: z.literal("settings.save"),
		workspaceId: workspaceId.optional(),
		scope: z.enum(["global", "project"]),
		key: z.string().min(1),
		value: z.unknown(),
		/**
		 * Valor exato da camada no momento em que a tela foi aberta. Obrigatório
		 * salvo quando `expectedMissing` sinaliza que a chave não existia.
		 */
		expectedValue: z.unknown().optional(),
		/** A chave deve estar AUSENTE na camada; nunca inferir ausência de `undefined`. */
		expectedMissing: z.boolean().optional(),
	}),
	z.object({ op: z.literal("settings.listModels") }),
	z.object({ op: z.literal("settings.applyPreset"), workspaceId, sessionId, name: z.string().min(1) }),
	z.object({ op: z.literal("account.usage"), workspaceId: workspaceId.optional() }),
	// Terminal
	z.object({ op: z.literal("terminal.create"), workspaceId }),
	z.object({ op: z.literal("terminal.write"), terminalId: z.string(), data: z.string().max(1_000_000) }),
	z.object({ op: z.literal("terminal.resize"), terminalId: z.string(), cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) }),
	z.object({ op: z.literal("terminal.close"), terminalId: z.string() }),
	// Git e arquivos
	z.object({ op: z.literal("git.status"), workspaceId }),
	z.object({ op: z.literal("git.diff"), workspaceId, path: relPath, source: z.enum(["working", "index"]) }),
	z.object({ op: z.literal("git.stage"), workspaceId, paths: z.array(relPath).min(1).max(500) }),
	z.object({ op: z.literal("git.unstage"), workspaceId, paths: z.array(relPath).min(1).max(500) }),
	z.object({ op: z.literal("git.commit"), workspaceId, message: z.string().min(1).max(20_000) }),
	z.object({ op: z.literal("files.read"), workspaceId, path: relPath }),
	z.object({ op: z.literal("files.openExternal"), workspaceId, path: relPath }),
	// Anexos
	z.object({ op: z.literal("attachment.pick"), workspaceId }),
	z.object({ op: z.literal("attachment.import"), workspaceId, name: z.string().min(1).max(260), mimeType: z.string().min(1).max(100), bytes: z.instanceof(Uint8Array) }),
	z.object({ op: z.literal("attachment.remove"), attachmentId: z.string() }),
]);
export type DesktopRequest = z.infer<typeof desktopRequestSchema>;
export type DesktopOp = DesktopRequest["op"];

export type DesktopResult<T = unknown> = { ok: true; data: T } | { ok: false; error: HostErrorBody };

/** API exposta ao renderer via contextBridge. Nada além disso. */
export interface OmpDesktopApi {
	invoke(request: DesktopRequest): Promise<DesktopResult>;
	subscribe(listener: (event: DesktopEvent) => void): () => void;
}

declare global {
	interface Window {
		ompDesktop: OmpDesktopApi;
	}
}

// ---------------------------------------------------------------------------
// DTOs de resposta
// ---------------------------------------------------------------------------

export interface WorkspaceDto {
	workspaceId: string;
	path: string;
	name: string;
	available: boolean;
	lastOpenedAt: number;
	isGitRepo?: boolean;
}

export interface SessionListItem {
	/** Caminho do arquivo de sessão (do inventário autorizado pelo host). */
	path: string;
	id: string;
	title: string;
	cwd: string;
	model?: string;
	modified: number;
	messageCount?: number;
	/** Aberta neste app. */
	openSessionId?: string;
	/** Ocupada por outro processo. */
	locked?: boolean;
}

export type OmpInstallPhase = "resolving" | "downloading" | "verifying" | "activating";

/**
 * Estado da instalação do OMP iniciada pelo usuário. `idle` é o padrão;
 * `installing` carrega a fase e o progresso do download; `success` e `error`
 * são terminais até uma nova tentativa.
 */
export type OmpInstallState =
	| { state: "idle" }
	| {
			state: "installing";
			phase: OmpInstallPhase;
			receivedBytes?: number;
			totalBytes?: number;
	  }
	| { state: "success"; ompPath: string; ompVersion: string }
	| { state: "error"; code: string; message: string };

export interface RuntimeStatus {
	phase: "starting-host" | "ready" | "omp-missing" | "omp-incompatible" | "host-failed";
	ompPath?: string;
	ompVersion?: string;
	gitVersion?: string;
	shell?: string;
	bunPath?: string;
	message?: string;
	/** Instalação do OMP em andamento/último resultado; ausente = idle. */
	install?: OmpInstallState;
	/**
	 * Snapshot de Git/Node opcionais. Ausente quando o main ainda não sondou;
	 * nunca é fabricado pelo renderer. Não altera `phase` nem bloqueia o app.
	 */
	dependencies?: DependencyRuntimeSnapshot;
	signed: boolean;
}

/** Item de `omp models ls --json`, já projetado e sem dados sensíveis. */
export interface ModelCatalogEntry {
	provider: string;
	id: string;
	name: string;
	selector: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinking?: string[];
	input?: string[];
	/** Custo estimado por milhão de tokens, quando o OMP informa. */
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export interface ModelCatalogDto {
	models: ModelCatalogEntry[];
	updatedAt: number;
}

export interface TerminalDataEvent {
	terminalId: string;
	data: string;
}

export interface GitFileStatus {
	path: string;
	origPath?: string;
	/** Colunas X (índice) e Y (árvore) do porcelain v1. */
	index: string;
	worktree: string;
	untracked: boolean;
	binary?: boolean;
}

export interface GitStatusResult {
	isRepo: boolean;
	hasHead: boolean;
	branch?: string;
	files: GitFileStatus[];
}

export interface GitDiffResult {
	path: string;
	source: "working" | "index";
	binary: boolean;
	original: string;
	modified: string;
	truncated: boolean;
}

export interface AttachmentDto {
	attachmentId: string;
	name: string;
	mimeType: string;
	size: number;
	kind: "image" | "text" | "file";
}

export const ERROR_CODES = [
	"INVALID_REQUEST",
	"UNKNOWN_WORKSPACE",
	"UNKNOWN_SESSION",
	"FORBIDDEN_PATH",
	"CONFIG_CONFLICT",
	"OMP_UNAVAILABLE",
	"OMP_INCOMPATIBLE",
	"SESSION_BUSY",
	"SESSION_LOCKED",
	"FRAME_TOO_LARGE",
	"HOST_EXITED",
	"UNSUPPORTED",
	"INTERNAL",
] as const;
