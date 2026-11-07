/**
 * Reducer puro do estado de visão de uma sessão.
 *
 * Usado pelo host (cache vivo) e pelo renderer (aplicação de eventos). Nenhum
 * efeito colateral: `applyEvent` devolve sempre um novo estado quando o evento
 * pertence à sessão; caso contrário, devolve a mesma referência.
 *
 * Frames sintéticos (name `desktop_*`) definidos aqui:
 * - `desktop_snapshot`      data = SessionSnapshot; substitui o estado inteiro.
 * - `desktop_history`       data = { messages: ChatMessage[], tools?: Record<string, ToolExecution> }
 * - `desktop_state`         data = RpcSessionState (estrutural) projetado.
 * - `desktop_commands`      data = { commands: SlashCommandInfo[] }.
 * - `desktop_thinking_levels` data = { levels: string[] }.
 * - `desktop_agents`        data = { agents: AgentRow[] }.
 * - `desktop_stats`         data = SessionStats no formato do OMP.
 * - `desktop_prompt`        data = { promptId, status, error? }.
 * - `desktop_status`        data = { status: SessionStatus, error?: string }.
 * - `desktop_dialog_closed` data = { id: string, reason?: string }.
 * - `desktop_notice`        data = { level, text }.
 *
 * Regras: `agent_end` NÃO torna a sessão ociosa; `agent_end.messages` não
 * substitui histórico; `message_end` é autoridade de conteúdo/usage; custo só
 * vem de `desktop_stats` (nunca somamos usage de mensagens).
 */
import type { DesktopEvent } from "./contracts";
import type {
	AgentRow,
	ChatMessage,
	ContentBlock,
	MessageUsage,
	PendingDialog,
	SessionMeta,
	SessionSnapshot,
	SessionStats,
	SessionStatus,
	SessionViewState,
	SlashCommandInfo,
	TodoPhaseView,
	ToolExecution,
} from "./session-types";

type Unknown = Record<string, unknown>;

/** Guard canônico compartilhado pelo reducer e pelo host; campos continuam `unknown`. */
export function isRecord(value: unknown): value is Unknown {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function arrayOf<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

function cloneNotices(notices: SessionViewState["notices"], entry?: SessionViewState["notices"][number]) {
	const next = notices.length >= 60 ? notices.slice(notices.length - 59) : notices.slice();
	if (entry) next.push(entry);
	return next;
}

function withNotice(
	state: SessionViewState,
	level: "info" | "warning" | "error",
	text: string,
): SessionViewState {
	if (!text) return state;
	const limited = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
	return {
		...state,
		notices: cloneNotices(state.notices, { level, text: limited, at: Date.now() }),
	};
}

// ---------------------------------------------------------------------------
// Mapeamento de mensagens cruas (RPC) para ChatMessage
// ---------------------------------------------------------------------------

export interface RawMessageOptions {
	generation: number;
	messageId?: string;
	entryId?: string;
	key?: string;
	streaming?: boolean;
}

function mapUsage(raw: unknown): MessageUsage | undefined {
	if (!isRecord(raw)) return undefined;
	const cost = isRecord(raw.cost)
		? {
				input: num(raw.cost.input),
				output: num(raw.cost.output),
				cacheRead: num(raw.cost.cacheRead),
				cacheWrite: num(raw.cost.cacheWrite),
				total: num(raw.cost.total),
			}
		: undefined;
	const usage: MessageUsage = {
		input: num(raw.input),
		output: num(raw.output),
		cacheRead: num(raw.cacheRead),
		cacheWrite: num(raw.cacheWrite),
		totalTokens: num(raw.totalTokens) ?? num(raw.total),
		cost,
	};
	return usage;
}

function mapImageBlock(raw: Unknown): ContentBlock | null {
	const mimeType = str(raw.mimeType);
	const data = str(raw.data);
	if (!data) return null;
	return { type: "image", mimeType, data };
}

/** Converte blocos de conteúdo do OMP em blocos do contrato (sem metadados do provider). */
export function contentBlocksFromRaw(content: unknown): ContentBlock[] {
	if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
	if (!Array.isArray(content)) return [];
	const blocks: ContentBlock[] = [];
	for (const raw of content) {
		if (!isRecord(raw)) continue;
		switch (raw.type) {
			case "text":
				blocks.push({ type: "text", text: str(raw.text) ?? "" });
				break;
			case "thinking":
				blocks.push({ type: "thinking", thinking: str(raw.thinking) ?? "" });
				break;
			case "image": {
				const mapped = mapImageBlock(raw);
				if (mapped) blocks.push(mapped);
				break;
			}
			case "toolCall":
				blocks.push({
					type: "toolCall",
					id: str(raw.id) ?? "",
					name: str(raw.name) ?? "",
					arguments: raw.arguments ?? {},
					intent: str(raw.intent),
				});
				break;
			default:
				blocks.push({ type: "unknown" });
				break;
		}
	}
	return blocks;
}

/** Converte uma AgentMessage crua em ChatMessage, sem providerPayload/headers/segredos. */
export function chatMessageFromRaw(raw: unknown, options: RawMessageOptions): ChatMessage {
	const record = isRecord(raw) ? raw : {};
	const roleRaw = str(record.role);
	const role: ChatMessage["role"] =
		roleRaw === "user" || roleRaw === "assistant" || roleRaw === "toolResult"
			? roleRaw
			: roleRaw === "developer" || roleRaw === "system"
				? "system"
				: "other";
	const messageId = options.messageId;
	const key =
		options.key ??
		(options.entryId
			? `entry:${options.entryId}`
			: `live:${options.generation}:${messageId ?? "anon"}`);
	return {
		key,
		entryId: options.entryId,
		messageId,
		generation: options.generation,
		role,
		content: contentBlocksFromRaw(record.content),
		timestamp: num(record.timestamp),
		model: str(record.model) ?? (isRecord(record.model) ? str(record.model.id) : undefined),
		provider: str(record.provider) ?? (isRecord(record.model) ? str(record.model.provider) : undefined),
		stopReason: str(record.stopReason),
		errorMessage: str(record.errorMessage),
		usage: mapUsage(record.usage),
		toolCallId: str(record.toolCallId),
		toolName: str(record.toolName),
		details: record.details,
		isError: bool(record.isError),
		streaming: options.streaming === true,
	};
}

/** Chave de uma mensagem viva; messageId ausente cai em um slot estável por gênero. */
function liveKey(generation: number, messageId: string | undefined, fallback: string): string {
	return `live:${generation}:${messageId ?? fallback}`;
}

function upsertMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
	const index = messages.findIndex((item) => item.key === message.key);
	if (index < 0) return [...messages, message];
	const next = messages.slice();
	next[index] = message;
	return next;
}

function messagesByKey(messages: ChatMessage[]): Map<string, ChatMessage> {
	return new Map(messages.map((message) => [message.key, message]));
}

// ---------------------------------------------------------------------------
// Metadados
// ---------------------------------------------------------------------------

const EMPTY_META: SessionMeta = {
	isStreaming: false,
	isCompacting: false,
	isSettled: true,
	hasPendingAsyncWork: false,
	messageCount: 0,
	todoPhases: [],
	goal: null,
};

function metaOf(state: SessionViewState): SessionMeta {
	return state.meta ?? { ...EMPTY_META };
}

export function metaFromRpcState(raw: unknown): Partial<SessionMeta> {
	if (!isRecord(raw)) return {};
	const patch: Partial<SessionMeta> = {};
	if (isRecord(raw.model)) {
		const provider = str(raw.model.provider);
		const id = str(raw.model.id);
		if (provider && id) patch.model = { provider, id, name: str(raw.model.name) };
	}
	const thinkingLevel = str(raw.thinkingLevel);
	if (thinkingLevel) patch.thinkingLevel = thinkingLevel;
	const isStreaming = bool(raw.isStreaming);
	if (isStreaming !== undefined) patch.isStreaming = isStreaming;
	const isCompacting = bool(raw.isCompacting);
	if (isCompacting !== undefined) patch.isCompacting = isCompacting;
	const isSettled = bool(raw.isSettled);
	if (isSettled !== undefined) patch.isSettled = isSettled;
	const pending = bool(raw.hasPendingAsyncWork);
	if (pending !== undefined) patch.hasPendingAsyncWork = pending;
	const sessionFile = str(raw.sessionFile);
	if (sessionFile) patch.sessionFile = sessionFile;
	const sessionName = str(raw.sessionName);
	if (sessionName) patch.sessionName = sessionName;
	const messageCount = num(raw.messageCount);
	if (messageCount !== undefined) patch.messageCount = messageCount;
	// OMP entrega percentual JÁ em 0–100 (ex.: 3.2 significa 3.2%).
	if (isRecord(raw.contextUsage)) {
		const percent = num(raw.contextUsage.percent);
		if (percent !== undefined) patch.contextPercent = percent;
		const tokens = num(raw.contextUsage.tokens);
		if (tokens !== undefined) patch.contextTokens = tokens;
		const window = num(raw.contextUsage.contextWindow);
		if (window !== undefined) patch.contextWindow = window;
	}
	if (Array.isArray(raw.todoPhases)) {
		patch.todoPhases = raw.todoPhases
			.filter(isRecord)
			.map((phase) => ({
				name: str(phase.name) ?? "Tarefas",
				tasks: arrayOf<Unknown>(phase.tasks)
					.filter(isRecord)
					.map((task) => ({ content: str(task.content) ?? "", status: str(task.status) ?? "pending" })),
			}));
	}
	patch.goal = raw.goal ?? null;
	if (raw.usageLimit !== undefined) patch.usageLimit = raw.usageLimit;
	return patch;
}

function queueFromRpcState(raw: unknown): SessionViewState["queue"] | undefined {
	if (!isRecord(raw)) return undefined;
	const steering = arrayOf<unknown>(raw.steering).filter((item): item is string => typeof item === "string");
	const followUp = arrayOf<unknown>(raw.followUp).filter((item): item is string => typeof item === "string");
	const liveSteered = num(raw.liveSteered) ?? 0;
	return { steering, followUp, liveSteered };
}

function commandsFromFrame(raw: unknown): SlashCommandInfo[] {
	return arrayOf<Unknown>(raw)
		.filter(isRecord)
		.map((command) => ({
			name: str(command.name) ?? "",
			aliases: Array.isArray(command.aliases)
				? command.aliases.filter((item): item is string => typeof item === "string")
				: undefined,
			description: str(command.description),
			inputHint: isRecord(command.input) ? str(command.input.hint) : undefined,
			subcommands: Array.isArray(command.subcommands)
				? command.subcommands.filter(isRecord).map((sub) => ({
						name: str(sub.name) ?? "",
						description: str(sub.description),
						usage: str(sub.usage),
					}))
				: undefined,
			source: str(command.source),
		}))
		.filter((command) => command.name.length > 0);
}

// ---------------------------------------------------------------------------
// Agentes
// ---------------------------------------------------------------------------

function agentIdentity(payload: Unknown): string {
	const id = str(payload.id);
	if (id) return `id:${id}`;
	const sessionFile = str(payload.sessionFile);
	if (sessionFile) return `file:${sessionFile}`;
	const parent = str(payload.parentToolCallId);
	const index = num(payload.index);
	return `parent:${parent ?? "?"}:${index ?? 0}`;
}

function sameAgent(left: AgentRow, right: AgentRow): boolean {
	if (left.key === right.key) return true;
	if (left.id && right.id && left.id === right.id) return true;
	if (left.sessionFile && right.sessionFile && left.sessionFile === right.sessionFile) return true;
	return (
		left.parentToolCallId !== undefined &&
		right.parentToolCallId !== undefined &&
		left.parentToolCallId === right.parentToolCallId &&
		left.index === right.index
	);
}

function statusFromLifecycle(value: unknown): AgentRow["status"] {
	switch (value) {
		case "started":
			return "running";
		case "completed":
		case "failed":
		case "aborted":
		case "pending":
		case "running":
			return value;
		default:
			return "unknown";
	}
}

function mergeAgent(agents: AgentRow[], incoming: AgentRow): AgentRow[] {
	const index = agents.findIndex((agent) => sameAgent(agent, incoming));
	const previous = index >= 0 ? agents[index] : undefined;
	const merged: AgentRow = {
		...previous,
		...incoming,
		key: previous?.key ?? incoming.key,
		// Um evento sem estado ("unknown") não apaga o último estado conhecido do runner.
		status: incoming.status === "unknown" && previous ? previous.status : incoming.status,
		// Modelo efetivo nunca é inferido do pai: só o que o OMP informar.
		effectiveModel: incoming.effectiveModel ?? previous?.effectiveModel,
		configuredModel: incoming.configuredModel ?? previous?.configuredModel,
		finalized: incoming.finalized || previous?.finalized === true,
	};
	const next = agents.slice();
	if (index >= 0) next[index] = merged;
	else next.push(merged);
	return next.sort((a, b) => (a.index ?? 9999) - (b.index ?? 9999));
}

function agentFromLifecycle(payload: Unknown): AgentRow {
	const status = statusFromLifecycle(payload.status);
	const index = num(payload.index);
	const id = str(payload.id);
	const sessionFile = str(payload.sessionFile);
	return {
		key: agentIdentity(payload),
		id,
		index,
		agent: str(payload.agent) ?? "agente",
		description: str(payload.description),
		task: str(payload.task),
		status,
		sessionFile,
		parentToolCallId: str(payload.parentToolCallId),
		lastUpdate: Date.now(),
		finalized: status !== "running" && status !== "pending",
	};
}

function agentFromProgress(payload: Unknown): AgentRow {
	const progress = isRecord(payload.progress) ? payload.progress : payload;
	const status = statusFromLifecycle(progress.status ?? payload.status);
	const index = num(payload.index) ?? num(progress.index);
	const id = str(progress.id) ?? str(payload.id);
	const sessionFile =
		str(payload.sessionFile) ??
		str(progress.sessionFile) ??
		str(isRecord(progress.progress) ? progress.progress.sessionFile : undefined);
	const modelOverride = progress.modelOverride;
	const configuredModel =
		typeof modelOverride === "string"
			? modelOverride
			: Array.isArray(modelOverride)
				? modelOverride.filter((item): item is string => typeof item === "string").join(", ")
				: str(progress.modelRole);
	return {
		key: agentIdentity({ ...payload, id, index }),
		id,
		index,
		agent: str(payload.agent) ?? str(progress.agent) ?? "agente",
		description: str(progress.description) ?? str(payload.description),
		task: str(payload.task) ?? str(progress.task),
		status,
		sessionFile,
		parentToolCallId: str(payload.parentToolCallId),
		effectiveModel: str(progress.resolvedModel),
		configuredModel: configuredModel || undefined,
		lastUpdate: Date.now(),
		finalized: status !== "running" && status !== "pending",
	};
}

// ---------------------------------------------------------------------------
// Diálogos
// ---------------------------------------------------------------------------

function dialogFromRequest(frame: Unknown): PendingDialog | null {
	const id = str(frame.id);
	const method = str(frame.method);
	if (!id || !method) return null;
	const base = { id, receivedAt: Date.now(), timeout: num(frame.timeout) };
	switch (method) {
		case "select":
			return {
				...base,
				method,
				title: str(frame.title),
				options: arrayOf<unknown>(frame.options).filter((item): item is string => typeof item === "string"),
				optionDetails: Array.isArray(frame.optionDetails)
					? frame.optionDetails.filter(isRecord).map((detail) => ({ description: str(detail.description) }))
					: undefined,
			};
		case "confirm":
			return { ...base, method, title: str(frame.title), message: str(frame.message) };
		case "input":
			return {
				...base,
				method,
				title: str(frame.title),
				placeholder: str(frame.placeholder),
				secret: bool(frame.secret),
			};
		case "editor":
			return { ...base, method, title: str(frame.title), prefill: str(frame.prefill) };
		case "ask":
			return {
				...base,
				method,
				questions: arrayOf<Unknown>(frame.questions)
					.filter(isRecord)
					.map((question) => ({
						id: str(question.id) ?? "",
						question: str(question.question) ?? "",
						header: str(question.header),
						options: arrayOf<Unknown>(question.options)
							.filter(isRecord)
							.map((option) => ({
								label: str(option.label) ?? "",
								description: str(option.description),
								preview: str(option.preview),
							})),
						multi: bool(question.multi),
						recommended: num(question.recommended),
					})),
			};
		default:
			return null;
	}
}

// ---------------------------------------------------------------------------
// Estado inicial
// ---------------------------------------------------------------------------

export function createSessionState(
	workspaceIdOrInit: string | { workspaceId: string; sessionId: string; generation?: number },
	maybeSessionId?: string,
): SessionViewState {
	const workspaceId = typeof workspaceIdOrInit === "string" ? workspaceIdOrInit : workspaceIdOrInit.workspaceId;
	const sessionId =
		typeof workspaceIdOrInit === "string" ? (maybeSessionId ?? "") : (workspaceIdOrInit.sessionId ?? "");
	return {
		workspaceId,
		sessionId,
		generation: typeof workspaceIdOrInit === "string" ? 0 : (workspaceIdOrInit.generation ?? 0),
		sequence: 0,
		status: "starting",
		messages: [],
		tools: {},
		queue: { steering: [], followUp: [], liveSteered: 0 },
		meta: null,
		commands: [],
		thinkingLevels: [],
		agents: [],
		pendingDialogs: [],
		prompts: {},
		stats: null,
		notices: [],
	};
}

/** Há lacuna quando o próximo evento esperado não é o recebido (mesma geração/sessão). */
export function isGap(state: SessionViewState, event: DesktopEvent): boolean {
	if (event.workspaceId !== state.workspaceId) return false;
	if (event.sessionId && event.sessionId !== state.sessionId) return false;
	if (event.generation !== state.generation) return false;
	return event.sequence > state.sequence + 1;
}

function belongs(state: SessionViewState, event: DesktopEvent): boolean {
	if (event.workspaceId !== state.workspaceId) return false;
	if (state.sessionId && event.sessionId && event.sessionId !== state.sessionId) return false;
	if (event.generation !== state.generation) {
		// Um snapshot substitui o estado inteiro e pode trocar a geração (novo processo).
		if (event.name !== "desktop_snapshot") return false;
	}
	if (event.sequence <= state.sequence) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function applyMeta(state: SessionViewState, frame: Unknown): SessionViewState {
	const patch = metaFromRpcState(frame);
	const meta: SessionMeta = { ...(state.meta ?? EMPTY_META), ...patch };
	const queue = queueFromRpcState(frame.queuedMessages) ?? state.queue;
	let status = state.status;
	if (patch.isStreaming === true) status = "busy";
	else if (patch.isSettled === true && (state.status === "starting" || state.status === "ready")) {
		status = "settled";
	}
	return { ...state, meta, queue, status };
}

function applyMessageStart(state: SessionViewState, frame: Unknown): SessionViewState {
	const messageId = str(frame.messageId);
	const raw = frame.message;
	const role = isRecord(raw) ? str(raw.role) : undefined;
	const chat = chatMessageFromRaw(raw, {
		generation: state.generation,
		messageId,
		key: liveKey(state.generation, messageId, `pending:${role ?? "message"}`),
		streaming: true,
	});
	// `message_start` repetido para a mesma chave substitui o esqueleto.
	return { ...state, messages: upsertMessage(state.messages, chat) };
}

function applyMessageUpdate(state: SessionViewState, frame: Unknown): SessionViewState {
	const messageId = str(frame.messageId);
	const key = liveKey(state.generation, messageId, "pending:assistant");
	const existing = state.messages.find((message) => message.key === key);
	const rawMessage = isRecord(frame.message) ? frame.message : undefined;
	const fullContent = rawMessage ? rawMessage.content : undefined;
	let content: ContentBlock[];
	if (Array.isArray(fullContent)) {
		// Snapshot completo é cumulativo: substituir (nunca concatenar deltas).
		content = contentBlocksFromRaw(fullContent);
	} else {
		content = applyAssistantDelta(existing?.content ?? [], frame.assistantMessageEvent);
	}
	const base: ChatMessage = existing ?? {
		key,
		messageId,
		generation: state.generation,
		role: "assistant",
		content: [],
		streaming: true,
	};
	const message: ChatMessage = {
		...base,
		content,
		streaming: true,
		model: (rawMessage ? str(rawMessage.model) : undefined) ?? base.model,
		provider: (rawMessage ? str(rawMessage.provider) : undefined) ?? base.provider,
		stopReason: (rawMessage ? str(rawMessage.stopReason) : undefined) ?? base.stopReason,
		errorMessage: (rawMessage ? str(rawMessage.errorMessage) : undefined) ?? base.errorMessage,
		usage: (rawMessage ? mapUsage(rawMessage.usage) : undefined) ?? base.usage,
	};
	return { ...state, messages: upsertMessage(state.messages, message) };
}

function applyAssistantDelta(content: ContentBlock[], rawEvent: unknown): ContentBlock[] {
	if (!isRecord(rawEvent)) return content;
	const type = str(rawEvent.type) ?? "";
	const contentIndex = num(rawEvent.contentIndex);
	const blockRaw = isRecord(rawEvent.block) ? rawEvent.block : undefined;
	const delta = str(rawEvent.delta) ?? "";
	const next = content.slice();
	const ensureIndex = () => {
		const index = contentIndex ?? 0;
		while (next.length <= index) next.push({ type: "text", text: "" });
		return index;
	};
	switch (type) {
		case "start": {
			const message = isRecord(rawEvent.message) ? rawEvent.message : undefined;
			if (message && Array.isArray(message.content)) return contentBlocksFromRaw(message.content);
			return next;
		}
		case "text_start": {
			const index = ensureIndex();
			next[index] = { type: "text", text: "" };
			return next;
		}
		case "text_delta": {
			const index = ensureIndex();
			const block = next[index];
			const current = block.type === "text" ? block.text : "";
			next[index] = { type: "text", text: current + delta };
			return next;
		}
		case "text_end": {
			const index = ensureIndex();
			const block = next[index];
			const text = blockRaw ? str(blockRaw.text) : undefined;
			if (text !== undefined) next[index] = { type: "text", text };
			else if (block.type !== "text") next[index] = { type: "text", text: "" };
			return next;
		}
		case "thinking_start": {
			const index = ensureIndex();
			next[index] = { type: "thinking", thinking: "" };
			return next;
		}
		case "thinking_delta": {
			const index = ensureIndex();
			const block = next[index];
			const current = block.type === "thinking" ? block.thinking : "";
			next[index] = { type: "thinking", thinking: current + delta };
			return next;
		}
		case "thinking_end": {
			const index = ensureIndex();
			const block = next[index];
			const thinking = blockRaw ? str(blockRaw.thinking) : undefined;
			if (thinking !== undefined) next[index] = { type: "thinking", thinking };
			else if (block.type !== "thinking") next[index] = { type: "thinking", thinking: "" };
			return next;
		}
		case "toolcall_start": {
			const index = ensureIndex();
			const block = blockRaw ?? {};
			next[index] = {
				type: "toolCall",
				id: str(block.id) ?? "",
				name: str(block.name) ?? "",
				arguments: block.arguments ?? {},
				intent: str(block.intent),
			};
			return next;
		}
		case "toolcall_delta":
			// Deltas de JSON parcial não são decodificados: `toolcall_end` traz o bloco inteiro.
			return next;
		case "toolcall_end": {
			const block = isRecord(rawEvent.toolCall)
				? rawEvent.toolCall
				: blockRaw
					? blockRaw
					: undefined;
			if (!block) return next;
			const index = contentIndex ?? next.findIndex((item) => item.type === "toolCall" && item.id === str(block.id));
			const target = index >= 0 ? index : next.length;
			while (next.length < target) next.push({ type: "text", text: "" });
			next[target] = {
				type: "toolCall",
				id: str(block.id) ?? "",
				name: str(block.name) ?? "",
				arguments: block.arguments ?? {},
				intent: str(block.intent),
			};
			return next;
		}
		case "image_end": {
			const block = isRecord(rawEvent.content) ? rawEvent.content : blockRaw;
			if (!block) return next;
			const index = contentIndex ?? next.length;
			while (next.length < index) next.push({ type: "text", text: "" });
			const image = mapImageBlock(block);
			next[index] = image ?? { type: "unknown" };
			return next;
		}
		default:
			return next;
	}
}

function applyMessageEnd(state: SessionViewState, frame: Unknown): SessionViewState {
	const messageId = str(frame.messageId);
	const raw = frame.message;
	const role = isRecord(raw) ? str(raw.role) : undefined;
	const key = liveKey(state.generation, messageId, `pending:${role ?? "message"}`);
	const existing = state.messages.find((message) => message.key === key);
	const chat = chatMessageFromRaw(raw, {
		generation: state.generation,
		messageId,
		key,
		streaming: false,
	});
	// Atributos que a mensagem final não repete (ex.: key) permanecem.
	const merged: ChatMessage = existing ? { ...existing, ...chat, role: chat.role } : chat;
	const messages = upsertMessage(state.messages, merged);
	let tools = state.tools;
	if (merged.role === "toolResult" && merged.toolCallId) {
		const current = tools[merged.toolCallId];
		const resultText = textOf(merged.content);
		tools = {
			...tools,
			[merged.toolCallId]: {
				toolCallId: merged.toolCallId,
				name: merged.toolName ?? current?.name ?? "ferramenta",
				arguments: current?.arguments,
				intent: current?.intent,
				status: merged.isError ? "error" : "done",
				partialText: current?.partialText,
				resultText: resultText.length > 0 ? resultText : current?.resultText,
				resultTruncated: current?.resultTruncated,
				details: current?.details,
			},
		};
	}
	return { ...state, messages, tools };
}

function textOf(content: ContentBlock[]): string {
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function applyToolEvent(state: SessionViewState, frame: Unknown): SessionViewState {
	const toolCallId = str(frame.toolCallId);
	if (!toolCallId) return state;
	const toolName = str(frame.toolName) ?? state.tools[toolCallId]?.name ?? "ferramenta";
	const current: ToolExecution = state.tools[toolCallId] ?? {
		toolCallId,
		name: toolName,
		status: "running",
	};
	const type = str(frame.type);
	if (type === "tool_execution_start") {
		return {
			...state,
			tools: {
				...state.tools,
				[toolCallId]: {
					toolCallId,
					name: toolName,
					arguments: frame.args,
					intent: str(frame.intent),
					status: "running",
				},
			},
		};
	}
	if (type === "tool_execution_update") {
		const partial = frame.partialResult;
		const partialText =
			isRecord(partial) && Array.isArray(partial.content)
				? textOf(contentBlocksFromRaw(partial.content))
				: typeof partial === "string"
					? partial
					: current.partialText;
		return {
			...state,
			tools: {
				...state.tools,
				[toolCallId]: {
					...current,
					arguments: frame.args ?? current.arguments,
					status: "running",
					partialText,
					details: isRecord(partial) ? (partial.details ?? current.details) : current.details,
				},
			},
		};
	}
	if (type === "tool_stream_update") {
		return {
			...state,
			tools: {
				...state.tools,
				[toolCallId]: {
					...current,
					arguments: current.arguments,
					status: "running",
					details: frame.update ?? current.details,
				},
			},
		};
	}
	if (type === "tool_execution_end") {
		const result = frame.result;
		const resultText =
			isRecord(result) && Array.isArray(result.content)
				? textOf(contentBlocksFromRaw(result.content))
				: typeof result === "string"
					? result
					: current.resultText;
		const isError = bool(frame.isError) === true || (isRecord(result) && result.isError === true);
		return {
			...state,
			tools: {
				...state.tools,
				[toolCallId]: {
					...current,
					status: isError ? "error" : "done",
					resultText,
					details: isRecord(result) ? (result.details ?? current.details) : current.details,
				},
			},
		};
	}
	return state;
}

function mergeToolFromMessage(state: SessionViewState, message: ChatMessage): SessionViewState {
	if (message.role !== "assistant") return state;
	let tools = state.tools;
	for (const block of message.content) {
		if (block.type !== "toolCall" || !block.id) continue;
		const current = tools[block.id];
		tools = {
			...tools,
			[block.id]: {
				toolCallId: block.id,
				name: block.name,
				arguments: block.arguments,
				intent: block.intent,
				status: current?.status ?? "running",
				partialText: current?.partialText,
				resultText: current?.resultText,
				details: current?.details,
			},
		};
	}
	return tools === state.tools ? state : { ...state, tools };
}

function applyExtensionUiRequest(state: SessionViewState, frame: Unknown): SessionViewState {
	const method = str(frame.method);
	if (method === "cancel") {
		const targetId = str(frame.targetId);
		if (!targetId) return state;
		return { ...state, pendingDialogs: state.pendingDialogs.filter((dialog) => dialog.id !== targetId) };
	}
	if (method === "notify") {
		const level = str(frame.notifyType);
		return withNotice(
			state,
			level === "warning" || level === "error" ? level : "info",
			str(frame.message) ?? "",
		);
	}
	if (method === "open_url") {
		const url = str(frame.url);
		if (!url) return state;
		const instructions = str(frame.instructions);
		const text = instructions ? `Abrir link: ${url} — ${instructions}` : `Abrir link: ${url}`;
		return withNotice(state, "info", text);
	}
	const dialog = dialogFromRequest(frame);
	if (!dialog) return state;
	if (state.pendingDialogs.some((item) => item.id === dialog.id)) return state;
	return { ...state, pendingDialogs: [...state.pendingDialogs, dialog] };
}

function applyPromptResult(state: SessionViewState, frame: Unknown): SessionViewState {
	const id = str(frame.id);
	if (!id) return state;
	const statusRaw = str(frame.status);
	const status: SessionViewState["prompts"][string]["status"] =
		statusRaw === "completed" || statusRaw === "aborted" || statusRaw === "error" ? statusRaw : "acked";
	const previous = state.prompts[id];
	const prompts = {
		...state.prompts,
		[id]: {
			id,
			status,
			error: isRecord(frame.error) ? str(frame.error.message) : str(frame.error),
		},
	};
	let next: SessionViewState = { ...state, prompts };
	const settled = bool(frame.sessionSettled);
	if (settled === true) {
		next = {
			...next,
			status: "settled",
			meta: { ...metaOf(next), isSettled: true, isStreaming: false, hasPendingAsyncWork: false },
		};
	}
	if (status === "error" && prompts[id]?.error) {
		next = withNotice(next, "error", prompts[id].error ?? "A solicitação terminou com erro.");
	}
	if (previous?.status === "completed" && status === "completed") return next;
	return next;
}

function applyQueue(state: SessionViewState, frame: Unknown): SessionViewState {
	const steering = arrayOf<unknown>(frame.steering).filter((item): item is string => typeof item === "string");
	const followUp = arrayOf<unknown>(frame.followUp).filter((item): item is string => typeof item === "string");
	const liveSteered = num(frame.liveSteered) ?? 0;
	return { ...state, queue: { steering, followUp, liveSteered } };
}

function applySubagentFrame(state: SessionViewState, frame: Unknown): SessionViewState {
	const type = str(frame.type);
	const payload = isRecord(frame.payload) ? frame.payload : undefined;
	if (!payload) return state;
	if (type === "subagent_lifecycle") {
		return { ...state, agents: mergeAgent(state.agents, agentFromLifecycle(payload)) };
	}
	if (type === "subagent_progress") {
		return { ...state, agents: mergeAgent(state.agents, agentFromProgress(payload)) };
	}
	if (type === "subagent_event") {
		const id = str(payload.id);
		if (!id) return state;
		const agents = state.agents.map((agent) =>
			agent.id === id ? { ...agent, lastUpdate: Date.now() } : agent,
		);
		return { ...state, agents };
	}
	return state;
}

function applyDesktopEvent(state: SessionViewState, event: DesktopEvent): SessionViewState {
	switch (event.name) {
		case "desktop_snapshot": {
			const snapshot = event.data as SessionSnapshot | undefined;
			if (!snapshot || !isRecord(snapshot.state)) return state;
			const base = snapshot.state as SessionViewState;
			return {
				...base,
				workspaceId: state.workspaceId,
				sessionId: base.sessionId || state.sessionId,
				generation: event.generation,
				sequence: event.sequence,
			};
		}
		case "desktop_history": {
			const data = isRecord(event.data) ? event.data : {};
			const messages = arrayOf<ChatMessage>(data.messages);
			const streaming = state.messages.filter((message) => message.streaming && message.key.startsWith("live:"));
			return {
				...state,
				messages: [...messages, ...streaming],
				tools: isRecord(data.tools) ? (data.tools as Record<string, ToolExecution>) : state.tools,
				sequence: event.sequence,
			};
		}
		case "desktop_state":
			return {
				...applyMeta(state, isRecord(event.data) ? event.data : {}),
				sequence: event.sequence,
			};
		case "desktop_commands": {
			const data = isRecord(event.data) ? event.data : {};
			return {
				...state,
				commands: commandsFromFrame(data.commands),
				sequence: event.sequence,
			};
		}
		case "desktop_thinking_levels": {
			const data = isRecord(event.data) ? event.data : {};
			return {
				...state,
				thinkingLevels: arrayOf<unknown>(data.levels).filter((item): item is string => typeof item === "string"),
				sequence: event.sequence,
			};
		}
		case "desktop_agents": {
			const data = isRecord(event.data) ? event.data : {};
			const incoming = arrayOf<AgentRow>(data.agents);
			let agents = state.agents;
			for (const agent of incoming) agents = mergeAgent(agents, agent);
			return { ...state, agents, sequence: event.sequence };
		}
		case "desktop_stats": {
			const data = isRecord(event.data) ? event.data : {};
			const costUsd = num(data.cost) ?? num(data.costUsd);
			const tokens = isRecord(data.tokens)
				? {
						input: num(data.tokens.input),
						output: num(data.tokens.output),
						cacheRead: num(data.tokens.cacheRead),
						cacheWrite: num(data.tokens.cacheWrite),
						total: num(data.tokens.total),
					}
				: undefined;
			const stats: SessionStats = {
				costUsd,
				tokens,
				raw: isRecord(data.raw) ? data.raw : undefined,
			};
			return { ...state, stats, sequence: event.sequence };
		}
		case "desktop_prompt": {
			const data = isRecord(event.data) ? event.data : {};
			const promptId = str(data.promptId);
			if (!promptId) return state;
			const statusRaw = str(data.status);
			const status: SessionViewState["prompts"][string]["status"] =
				statusRaw === "sent" ||
				statusRaw === "acked" ||
				statusRaw === "completed" ||
				statusRaw === "aborted" ||
				statusRaw === "error" ||
				statusRaw === "interrupted"
					? statusRaw
					: "sent";
			const error = str(data.error);
			const next: SessionViewState = {
				...state,
				prompts: {
					...state.prompts,
					[promptId]: { id: promptId, status, error },
				},
				sequence: event.sequence,
			};
			return error ? withNotice(next, "error", error) : next;
		}
		case "desktop_status": {
			const data = isRecord(event.data) ? event.data : {};
			const status = str(data.status) as SessionStatus | undefined;
			const allowed: SessionStatus[] = [
				"starting",
				"ready",
				"busy",
				"settled",
				"interrupted",
				"closed",
				"error",
			];
			const next: SessionViewState = {
				...state,
				status: status && allowed.includes(status) ? status : state.status,
				error: str(data.error) ?? (status === "error" ? state.error : undefined),
				sequence: event.sequence,
			};
			// Processo encerrado/caído: um diálogo pendente não tem mais quem o
			// responda. Limpar evita aprovar às cegas ao reconectar.
			if (next.status === "interrupted" || next.status === "closed" || next.status === "error") {
				next.pendingDialogs = [];
			}
			return next;
		}
		case "desktop_dialog_closed": {
			const data = isRecord(event.data) ? event.data : {};
			const id = str(data.id);
			return {
				...state,
				pendingDialogs: id ? state.pendingDialogs.filter((dialog) => dialog.id !== id) : state.pendingDialogs,
				sequence: event.sequence,
			};
		}
		case "desktop_notice": {
			const data = isRecord(event.data) ? event.data : {};
			const level = str(data.level);
			return withNotice(
				state,
				level === "warning" || level === "error" ? level : "info",
				str(data.text) ?? "",
			);
		}
		default:
			return state;
	}
}

export function applyEvent(state: SessionViewState, event: DesktopEvent): SessionViewState {
	if (!event || typeof event !== "object") return state;
	if (!belongs(state, event)) return state;
	const base = { ...state, generation: event.generation, sequence: event.sequence };
	switch (event.name) {
		case "session.status": {
			const data = isRecord(event.data) ? event.data : {};
			const status = str(data.status) as SessionStatus | undefined;
			const next: SessionViewState = {
				...base,
				status: status ?? base.status,
				error: str(data.error) ?? (status === "error" ? base.error : undefined),
			};
			if (next.status === "interrupted" || next.status === "closed" || next.status === "error") {
				next.pendingDialogs = [];
			}
			return next;
		}
		case "frame":
			return applyFrame(base, isRecord(event.data) ? event.data : {});
		default:
			if (event.name.startsWith("desktop_")) return applyDesktopEvent(base, event);
			return state;
	}
}

function applyFrame(state: SessionViewState, frame: Unknown): SessionViewState {
	const type = str(frame.type) ?? "";
	switch (type) {
		case "message_start":
			return applyMessageStart(state, frame);
		case "message_update":
			return applyMessageUpdate(state, frame);
		case "message_end": {
			const next = applyMessageEnd(state, frame);
			const ended = next.messages.find((message) => message.key === liveKey(state.generation, str(frame.messageId), `pending:${isRecord(frame.message) ? (str(frame.message.role) ?? "message") : "message"}`));
			return ended ? mergeToolFromMessage(next, ended) : next;
		}
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
		case "tool_stream_update":
			return applyToolEvent(state, frame);
		case "available_commands_update":
			return { ...state, commands: commandsFromFrame(frame.commands) };
		case "queue_update":
			return applyQueue(state, frame);
		case "agent_start": {
			return {
				...state,
				status: "busy",
				meta: { ...metaOf(state), isStreaming: true, isSettled: false },
			};
		}
		case "agent_end": {
			// Fim de turno não é ociosidade: só `session_settled`/prompt_result decide.
			const terminal = bool(frame.isTerminal);
			const meta = metaOf(state);
			return {
				...state,
				meta: {
					...meta,
					isStreaming: false,
					isSettled: false,
					hasPendingAsyncWork: terminal === false ? true : meta.hasPendingAsyncWork,
				},
			};
		}
		case "session_settled":
			return {
				...state,
				status: "settled",
				meta: { ...metaOf(state), isSettled: true, isStreaming: false, hasPendingAsyncWork: false },
			};
		case "prompt_result":
			return applyPromptResult(state, frame);
		case "extension_ui_request":
			return applyExtensionUiRequest(state, frame);
		case "todo_reminder": {
			const tasks = arrayOf<Unknown>(frame.todos)
				.filter(isRecord)
				.map((task) => ({ content: str(task.content) ?? "", status: str(task.status) ?? "pending" }));
			const phases: TodoPhaseView[] = [{ name: "Tarefas", tasks }];
			return { ...state, meta: { ...metaOf(state), todoPhases: phases } };
		}
		case "todo_auto_clear":
			return { ...state, meta: { ...metaOf(state), todoPhases: [] } };
		case "goal_updated":
			return {
				...state,
				meta: { ...metaOf(state), goal: frame.goal ?? frame.state ?? null },
			};
		case "thinking_level_changed": {
			const meta = metaOf(state);
			return {
				...state,
				meta: { ...meta, thinkingLevel: str(frame.thinkingLevel) ?? meta.thinkingLevel },
			};
		}
		case "notice": {
			const level = str(frame.level);
			return withNotice(
				state,
				level === "warning" || level === "error" ? level : "info",
				str(frame.message) ?? "",
			);
		}
		case "auto_retry_start":
			return withNotice(
				state,
				"warning",
				`Tentando novamente (${num(frame.attempt) ?? 1}/${num(frame.maxAttempts) ?? "?"}): ${
					str(frame.errorMessage) ?? "falha temporária"
				}`,
			);
		case "auto_retry_end":
			return bool(frame.success) === true
				? withNotice(state, "info", "A nova tentativa funcionou.")
				: withNotice(state, "error", str(frame.finalError) ?? "As novas tentativas falharam.");
		case "retry_fallback_applied":
			return withNotice(
				state,
				"warning",
				`Modelo alternativo em uso: ${str(frame.from) ?? "?"} → ${str(frame.to) ?? "?"}.`,
			);
		case "rpc_frame_error":
			return withNotice(
				state,
				"error",
				`Um evento grande demais não pôde ser recebido: ${str(frame.error) ?? "limite de transporte"}.`,
			);
		case "extension_error":
			return withNotice(
				state,
				"warning",
				`Uma extensão falhou (${str(frame.event) ?? "evento"}): ${str(frame.error) ?? "erro"}.`,
			);
		case "subagent_lifecycle":
		case "subagent_progress":
		case "subagent_event":
			return applySubagentFrame(state, frame);
		case "compaction_end":
		case "auto_compaction_end":
			return withNotice(state, "info", "Compactação concluída.");
		case "auto_compaction_start":
			return { ...state, meta: { ...metaOf(state), isCompacting: true } };
		default:
			return state;
	}
}
