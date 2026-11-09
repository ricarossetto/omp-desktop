/**
 * Estado de visão de uma sessão. O reducer puro `applyEvent` em `session-state.ts`
 * é a única forma de alterá-lo, tanto no host quanto no renderer.
 */
import type { DesktopEvent } from "./contracts";

/** Modos de aprovação de ferramentas do OMP (`--approval-mode`). */
export const APPROVAL_MODES = ["always-ask", "always-ask-cached", "write", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "write";

export function isApprovalMode(value: unknown): value is ApprovalMode {
	return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "image"; mimeType?: string; data?: string; omitted?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments: unknown; intent?: string }
	| { type: "unknown"; raw?: unknown };

export interface MessageUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

export interface ChatMessage {
	/** Chave estável na lista: `entry:<entryId>` (histórico) ou `live:<generation>:<messageId>`. */
	key: string;
	entryId?: string;
	messageId?: string;
	generation?: number;
	role: "user" | "assistant" | "toolResult" | "system" | "other";
	content: ContentBlock[];
	timestamp?: number;
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
	usage?: MessageUsage;
	toolCallId?: string;
	toolName?: string;
	/** `details` do toolResult (diff, resultados de task etc.), preservado para a UI. */
	details?: unknown;
	isError?: boolean;
	streaming: boolean;
}

export interface ToolExecution {
	toolCallId: string;
	name: string;
	arguments?: unknown;
	intent?: string;
	status: "running" | "done" | "error";
	/** Saída parcial acumulada (texto). */
	partialText?: string;
	resultText?: string;
	resultTruncated?: boolean;
	details?: unknown;
}

export interface AgentRow {
	/** Identidade: id do OMP; fallback sessionFile ou parentToolCallId+index. */
	key: string;
	id?: string;
	index?: number;
	agent: string;
	description?: string;
	task?: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted" | "unknown";
	sessionFile?: string;
	parentToolCallId?: string;
	/** Modelo efetivo informado pelo progresso ou por TaskToolDetails; ausente = não informado. */
	effectiveModel?: string;
	configuredModel?: string;
	lastUpdate?: number;
	finalized: boolean;
}

export interface PendingDialog {
	id: string;
	method: "select" | "confirm" | "input" | "editor" | "ask";
	title?: string;
	message?: string;
	options?: string[];
	optionDetails?: Array<{ description?: string }>;
	placeholder?: string;
	prefill?: string;
	secret?: boolean;
	questions?: Array<{
		id: string;
		question: string;
		header?: string;
		options: Array<{ label: string; description?: string; preview?: string }>;
		multi?: boolean;
		recommended?: number;
	}>;
	timeout?: number;
	receivedAt: number;
}

export interface SlashCommandInfo {
	name: string;
	aliases?: string[];
	description?: string;
	inputHint?: string;
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source?: string;
}

export interface TodoItemView {
	content: string;
	status: string;
}
export interface TodoPhaseView {
	name: string;
	tasks: TodoItemView[];
}

export interface SessionMeta {
	model?: { provider: string; id: string; name?: string };
	thinkingLevel?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	isSettled: boolean;
	hasPendingAsyncWork: boolean;
	sessionFile?: string;
	sessionName?: string;
	messageCount: number;
	/** Percentual 0–100, como entregue pelo OMP; ausente = indisponível. */
	contextPercent?: number;
	contextTokens?: number;
	contextWindow?: number;
	todoPhases: TodoPhaseView[];
	goal: unknown | null;
	usageLimit?: unknown;
}

export type SessionStatus = "starting" | "ready" | "busy" | "settled" | "interrupted" | "closed" | "error";

export interface PromptRecord {
	id: string;
	status: "sent" | "acked" | "completed" | "aborted" | "error" | "interrupted";
	error?: string;
}

export interface SessionStats {
	/** Custo em USD estimado informado pelo OMP; ausente = indisponível. */
	costUsd?: number;
	tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
	raw?: unknown;
}

export interface SessionViewState {
	workspaceId: string;
	sessionId: string;
	generation: number;
	/** Última sequence aplicada. */
	sequence: number;
	status: SessionStatus;
	messages: ChatMessage[];
	tools: Record<string, ToolExecution>;
	queue: { steering: string[]; followUp: string[]; liveSteered: number };
	meta: SessionMeta | null;
	commands: SlashCommandInfo[];
	thinkingLevels: string[];
	agents: AgentRow[];
	pendingDialogs: PendingDialog[];
	prompts: Record<string, PromptRecord>;
	stats: SessionStats | null;
	/** Entradas já contabilizadas, para deduplicar custo estimado. */
	notices: Array<{ level: "info" | "warning" | "error"; text: string; at: number }>;
	error?: string;
}

export type ApplyEvent = (state: SessionViewState, event: DesktopEvent) => SessionViewState;

/** Snapshot devolvido por `session.snapshot` e `session.open/create`. */
export interface SessionSnapshot {
	state: SessionViewState;
	sessionPath?: string;
	/** Modo com que o processo OMP desta sessão está rodando. */
	approvalMode?: ApprovalMode;
}
