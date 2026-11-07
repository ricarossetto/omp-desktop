/**
 * Conversão leve de mensagens do OMP (formato AgentMessage) para o transcript
 * de subagente. Funções puras para permitir teste sem Electron.
 */
import type { AgentRow, TodoPhaseView } from "@shared/session-types";
import { translate } from "../../i18n/translate";
import type { Locale } from "../../i18n/types";
import type { MessageKey } from "../../i18n/pt-BR";
import type { IconKind } from "./StatusIcon";

export type TranscriptRole = "user" | "assistant" | "toolResult" | "system" | "other";

export type TranscriptPart =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "toolCall"; id?: string; name: string; arguments?: unknown }
	| { kind: "toolResult"; toolName?: string; text: string; isError: boolean }
	| { kind: "image"; label: string };

export interface TranscriptItem {
	key: string;
	role: TranscriptRole;
	parts: TranscriptPart[];
	timestamp?: number;
}

export interface SubagentTranscriptPage {
	sessionFile?: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	messages: unknown[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function contentBlocks(content: unknown): unknown[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content;
	return [];
}

/** Serializa argumentos/valores desconhecidos sem estourar em ciclos. */
export function formatValue(value: unknown, maxLength = 4000): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
	try {
		const json = JSON.stringify(value, null, 2);
		if (json === undefined) return String(value);
		return json.length > maxLength ? `${json.slice(0, maxLength)}…` : json;
	} catch {
		return String(value);
	}
}

function blockToPart(block: unknown, locale: Locale = "pt-BR"): TranscriptPart | null {
	if (typeof block === "string") return { kind: "text", text: block };
	if (!isRecord(block)) return null;
	const type = asString(block.type);
	if (type === "text") {
		const text = asString(block.text) ?? "";
		return text ? { kind: "text", text } : null;
	}
	if (type === "thinking" || type === "thinking_delta") {
		const text = asString(block.thinking) ?? asString(block.text) ?? "";
		return text ? { kind: "thinking", text } : null;
	}
	if (type === "image") {
		return { kind: "image", label: translate(locale, "agents.imageAttached") };
	}
	if (type === "toolCall" || type === "tool_call") {
		return {
			kind: "toolCall",
			id: asString(block.id),
			name: asString(block.name) ?? translate(locale, "agents.toolFallback"),
			arguments: block.arguments,
		};
	}
	if (type === "toolResult" || type === "tool_result") {
		return {
			kind: "toolResult",
			toolName: asString(block.toolName) ?? asString(block.name),
			text: extractText(block.content, locale),
			isError: block.isError === true,
		};
	}
	// Blocos desconhecidos são preservados como texto para não sumir com dados.
	const text = asString(block.text);
	return text ? { kind: "text", text } : null;
}

function extractText(content: unknown, locale: Locale = "pt-BR"): string {
	if (typeof content === "string") return content;
	return contentBlocks(content)
		.map(block => {
			const part = blockToPart(block, locale);
			if (!part) return "";
			if (part.kind === "text" || part.kind === "thinking") return part.text;
			if (part.kind === "toolResult") return part.text;
			return part.kind === "image" ? translate(locale, "agents.imageMarker") : "";
		})
		.filter(Boolean)
		.join("\n\n");
}

/** Converte uma mensagem crua do OMP em item de transcript; null quando não há conteúdo. */
export function convertMessage(raw: unknown, key: string, locale: Locale = "pt-BR"): TranscriptItem | null {
	if (!isRecord(raw)) return null;
	const rawRole = asString(raw.role) ?? "other";
	const role: TranscriptRole =
		rawRole === "user" || rawRole === "assistant" || rawRole === "system" || rawRole === "toolResult"
			? rawRole
			: "other";
	const parts: TranscriptPart[] = [];

	if (role === "toolResult") {
		parts.push({
			kind: "toolResult",
			toolName: asString(raw.toolName) ?? asString(raw.name),
			text: extractText(raw.content, locale),
			isError: raw.isError === true || Boolean(raw.errorMessage),
		});
	} else {
		for (const block of contentBlocks(raw.content)) {
			const part = blockToPart(block, locale);
			if (part) parts.push(part);
		}
	}

	const errorMessage = asString(raw.errorMessage);
	if (errorMessage) parts.push({ kind: "text", text: translate(locale, "agents.errorPrefix", { message: errorMessage }) });
	const timestamp = typeof raw.timestamp === "number" ? raw.timestamp : undefined;
	if (parts.length === 0) return null;
	return { key, role, parts, timestamp };
}

/** Normaliza a resposta de `session.subagentTranscript` sem confiar no shape. */
export function parseTranscriptPage(raw: unknown): SubagentTranscriptPage {
	const outer = isRecord(raw) && isRecord(raw.data) && !("messages" in raw) ? raw.data : raw;
	const record = isRecord(outer) ? outer : {};
	const messages = Array.isArray(record.messages) ? record.messages : [];
	const fromByte = typeof record.fromByte === "number" && record.fromByte >= 0 ? record.fromByte : 0;
	const nextByte =
		typeof record.nextByte === "number" && record.nextByte >= fromByte ? record.nextByte : fromByte;
	return {
		sessionFile: asString(record.sessionFile),
		fromByte,
		nextByte,
		reset: record.reset === true,
		messages,
	};
}

/**
 * Anexa uma página incremental. `reset`/leitura a partir de zero substitui o
 * conteúdo anterior; chaves repetidas não duplicam itens.
 */
export function mergeTranscript(
	previous: readonly TranscriptItem[],
	page: SubagentTranscriptPage,
	options: { replace?: boolean; locale?: Locale } = {},
): TranscriptItem[] {
	const base = page.reset || options.replace ? [] : [...previous];
	const seen = new Set(base.map(item => item.key));
	const prefix = page.sessionFile ?? "subagent";
	for (let index = 0; index < page.messages.length; index++) {
		const item = convertMessage(page.messages[index], `${prefix}:${page.fromByte}:${index}`, options.locale ?? "pt-BR");
		if (!item || seen.has(item.key)) continue;
		seen.add(item.key);
		base.push(item);
	}
	return base;
}

// ---------------------------------------------------------------------------
// Agentes, tarefas e objetivo
// ---------------------------------------------------------------------------

const AGENT_STATUS_KEYS: Record<AgentRow["status"], MessageKey> = {
	pending: "agents.agentPending",
	running: "agents.agentRunning",
	completed: "agents.agentCompleted",
	failed: "agents.agentFailed",
	aborted: "agents.agentAborted",
	unknown: "agents.agentUnknown",
};

/** Rótulos em pt-BR; a UI usa `agentStatusLabel` para seguir o idioma ativo. */
export const AGENT_STATUS_LABELS: Record<AgentRow["status"], string> = {
	pending: translate("pt-BR", AGENT_STATUS_KEYS.pending),
	running: translate("pt-BR", AGENT_STATUS_KEYS.running),
	completed: translate("pt-BR", AGENT_STATUS_KEYS.completed),
	failed: translate("pt-BR", AGENT_STATUS_KEYS.failed),
	aborted: translate("pt-BR", AGENT_STATUS_KEYS.aborted),
	unknown: translate("pt-BR", AGENT_STATUS_KEYS.unknown),
};

export function agentStatusLabel(status: AgentRow["status"], locale: Locale = "pt-BR"): string {
	return translate(locale, AGENT_STATUS_KEYS[status]);
}

export const AGENT_STATUS_ICONS: Record<AgentRow["status"], IconKind> = {
	pending: "pending",
	running: "running",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
	unknown: "info",
};

const TODO_STATUS_KEYS: Record<string, MessageKey> = {
	pending: "agents.todoPending",
	in_progress: "agents.todoInProgress",
	completed: "agents.todoCompleted",
	abandoned: "agents.todoAbandoned",
	blocked: "agents.todoBlocked",
};

export const TODO_STATUS_LABELS: Record<string, string> = {
	pending: translate("pt-BR", TODO_STATUS_KEYS.pending),
	in_progress: translate("pt-BR", TODO_STATUS_KEYS.in_progress),
	completed: translate("pt-BR", TODO_STATUS_KEYS.completed),
	abandoned: translate("pt-BR", TODO_STATUS_KEYS.abandoned),
	blocked: translate("pt-BR", TODO_STATUS_KEYS.blocked),
};

export function todoStatusLabel(status: string, locale: Locale = "pt-BR"): string {
	const key = TODO_STATUS_KEYS[status];
	return key ? translate(locale, key) : translate(locale, "agents.statusFallback", { status });
}

export function todoStatusIcon(status: string): "pending" | "running" | "completed" | "aborted" | "blocked" | "info" {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "running";
		case "completed":
			return "completed";
		case "abandoned":
			return "aborted";
		case "blocked":
			return "blocked";
		default:
			return "info";
	}
}

export function todoCounts(phases: readonly TodoPhaseView[] | undefined): { total: number; done: number } {
	let total = 0;
	let done = 0;
	for (const phase of phases ?? []) {
		for (const task of phase.tasks ?? []) {
			total += 1;
			if (task.status === "completed") done += 1;
		}
	}
	return { total, done };
}

const GOAL_STATUS_KEYS: Record<string, MessageKey> = {
	active: "agents.goalActive",
	paused: "agents.goalPaused",
	"budget-limited": "agents.goalBudgetLimited",
	complete: "agents.goalComplete",
	dropped: "agents.goalDropped",
};

export const GOAL_STATUS_LABELS: Record<string, string> = {
	active: translate("pt-BR", "agents.goalActive"),
	paused: translate("pt-BR", "agents.goalPaused"),
	"budget-limited": translate("pt-BR", "agents.goalBudgetLimited"),
	complete: translate("pt-BR", "agents.goalComplete"),
	dropped: translate("pt-BR", "agents.goalDropped"),
};

export function goalStatusLabel(status: string, locale: Locale = "pt-BR"): string {
	const key = GOAL_STATUS_KEYS[status];
	return key ? translate(locale, key) : translate(locale, "agents.statusFallback", { status });
}

export interface GoalView {
	id?: string;
	objective: string;
	status: string;
	tokenBudget?: number;
	tokensUsed?: number;
	timeUsedSeconds?: number;
}

/**
 * `state.meta.goal` pode ser o Goal direto ou o envelope `{goal, state}` do
 * comando `goal`. Aceita as duas formas.
 */
export function readGoal(raw: unknown): GoalView | null {
	if (!isRecord(raw)) return null;
	const candidates: unknown[] = [raw];
	if (isRecord(raw.goal)) candidates.unshift(raw.goal);
	if (isRecord(raw.state) && isRecord(raw.state.goal)) candidates.unshift(raw.state.goal);
	for (const candidate of candidates) {
		if (!isRecord(candidate)) continue;
		const objective = asString(candidate.objective);
		if (!objective) continue;
		return {
			id: asString(candidate.id),
			objective,
			status: asString(candidate.status) ?? "unknown",
			tokenBudget: typeof candidate.tokenBudget === "number" ? candidate.tokenBudget : undefined,
			tokensUsed: typeof candidate.tokensUsed === "number" ? candidate.tokensUsed : undefined,
			timeUsedSeconds:
				typeof candidate.timeUsedSeconds === "number" ? candidate.timeUsedSeconds : undefined,
		};
	}
	return null;
}

export function formatDurationSeconds(seconds: number | undefined, locale: Locale = "pt-BR"): string | undefined {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
	if (seconds < 60) return translate(locale, "agents.durationSeconds", { seconds: Math.round(seconds) });
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return translate(locale, "agents.durationMinutes", { minutes });
	const hours = Math.floor(minutes / 60);
	return translate(locale, "agents.durationHours", { hours, minutes: minutes % 60 });
}
