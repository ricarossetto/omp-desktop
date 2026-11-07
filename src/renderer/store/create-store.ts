import type {
	AttachmentDto,
	DependencyRuntimeSnapshot,
	DesktopEvent,
	RpcCommandInput,
	RuntimeStatus,
	SessionListItem,
	UiResponse,
	WorkspaceDto,
} from "@shared/contracts";
import type { SessionSnapshot, SessionViewState } from "@shared/session-types";
import { applyEvent, createSessionState } from "@shared/session-state";
import { invoke, subscribe } from "../api";
import {
	EMPTY_COMPOSER_DRAFT,
	appendAttachments,
	mergeRestoredDraft,
	parseAbortRestore,
	removeAttachment,
	settleDraftAfterAck,
	type ComposerDraft,
	type RestoredImage,
} from "../features/conversation/composer-policy";
import { clearDialogsForLostSession, unsupportedDialogMethod } from "./dialog-state";
import { errorDetail } from "../features/errors/error-messages";
import { installErrorKey } from "../features/diagnostics/install-errors";
import { classifySessionEvent } from "./event-disposition";
import {
	parseEditorText,
	parsePromoted,
	parseQueueImages,
	queueImagesDropped,
	removableIndexOf,
} from "./queue-policy";
import { detectLocale, isLocale, type Locale } from "../i18n";
import type { MessageKey } from "../i18n/pt-BR";
import { translate } from "../i18n/translate";
import type { MessageParams } from "../i18n/types";
import { normalizeStats } from "./stats";
import {
	DEFAULT_LAYOUT,
	INITIAL_APP_STATE,
	activeWorkspace,
	clampLayout,
	fallbackSessionTitle,
	type AppNotice,
	type AppState,
	type LayoutState,
	type PaletteMode,
	type PersistedTab,
	type SessionRecord,
	type SettingsTab,
	type ThemeMode,
} from "./state";

export interface AppActions {
	start(): () => void;
	refreshRuntime(): Promise<void>;
	retryRuntime(): Promise<void>;
	selectOmp(): Promise<void>;
	installOmp(): Promise<void>;
	/** Mescla um snapshot de Git/Node vindo da seção de ferramentas opcionais. */
	applyDependencies(snapshot: DependencyRuntimeSnapshot): void;
	loadWorkspaces(): Promise<void>;
	pickWorkspace(): Promise<void>;
	removeWorkspace(workspaceId: string): Promise<void>;
	relocateWorkspace(workspaceId: string): Promise<void>;
	openWorkspace(workspaceId: string): Promise<void>;

	loadSessions(workspaceId: string): Promise<SessionListItem[]>;
	createSession(workspaceId?: string): Promise<boolean>;
	openSession(workspaceId: string, sessionPath: string): Promise<boolean>;
	activateSession(sessionId: string): void;
	closeSession(sessionId: string): Promise<boolean>;
	refreshSnapshot(sessionId: string): Promise<void>;
	requestStats(sessionId: string): Promise<void>;

	sendPrompt(
		sessionId: string,
		text: string,
		attachmentIds: string[],
		behavior?: "steer" | "followUp",
	): Promise<boolean>;
	abortAndRestore(sessionId: string): Promise<void>;
	removeQueued(sessionId: string, message: string, queue: "steering" | "followUp"): Promise<void>;
	promoteQueued(sessionId: string, message: string): Promise<void>;
	respondDialog(sessionId: string, response: UiResponse): Promise<boolean>;
	exportHtml(sessionId: string): Promise<void>;
	navigateTree(sessionId: string, entryId: string): Promise<boolean>;
	forkSession(sessionId: string, entryId?: string): Promise<boolean>;

	setDraft(sessionId: string, text: string): void;
	insertIntoComposer(sessionId: string, text: string): void;
	pickAttachments(sessionId: string): Promise<void>;
	importAttachment(sessionId: string, file: File): Promise<void>;
	removeDraftAttachment(sessionId: string, attachmentId: string): Promise<void>;
	setUnreadSessions(ids: string[]): void;
	restoreInterrupted(sessionId: string): void;

	setLayout(partial: Partial<LayoutState>): void;
	setTheme(theme: ThemeMode): void;
	toggleTerminal(): void;
	setRightTab(tab: LayoutState["rightTab"]): void;
	toggleRightPanel(): void;
	showRightPanel(tab: LayoutState["rightTab"]): void;
	openSettings(tab?: SettingsTab): void;
	closeSettings(): void;
	setModelPickerOpen(open: boolean): void;
	setPaletteOpen(open: boolean, mode?: PaletteMode): void;
	setLocale(locale: Locale): void;
	notify(level: AppNotice["level"], text: string): void;
	dismissNotice(id: string): void;
	openExternal(url: string): Promise<void>;
	openWorkspaceFile(path: string): Promise<void>;
}

export interface AppStore {
	getState(): AppState;
	subscribe(listener: () => void): () => void;
	actions: AppActions;
}

interface InstallOptions {
	activate: boolean;
	quiet?: boolean;
	/** Título vindo da listagem autorizada, quando o snapshot não traz nome. */
	title?: string;
}

const SHELL_VERSION = 1;

/** Buffer de eventos que chegam antes de o renderer conhecer a sessão. */
const EARLY_BUFFER_LIMIT = 200;
const EARLY_BUFFER_TTL_MS = 10_000;

/** Mesmo limite do main/host: o prompt inteiro precisa caber em um frame do OMP. */
export const MAX_ATTACHMENT_BYTES = 600 * 1024;

export function attachmentLimitExceeded(size: number): boolean {
	return size > MAX_ATTACHMENT_BYTES;
}

function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function extensionForMime(mimeType: string): string {
	if (mimeType.includes("jpeg")) return "jpg";
	if (mimeType.includes("webp")) return "webp";
	if (mimeType.includes("gif")) return "gif";
	return "png";
}

function isPersistedTab(value: unknown): value is PersistedTab {
	if (!value || typeof value !== "object") return false;
	const tab = value as Record<string, unknown>;
	return typeof tab.workspaceId === "string" && tab.workspaceId.length > 0;
}

function unwrapAttachmentList(value: unknown): AttachmentDto[] {
	if (Array.isArray(value)) return value.filter((item): item is AttachmentDto => !!item && typeof item === "object");
	if (value && typeof value === "object" && "attachments" in value && Array.isArray(value.attachments)) {
		return value.attachments as AttachmentDto[];
	}
	return [];
}

function unwrapAttachment(value: unknown): AttachmentDto | null {
	if (!value || typeof value !== "object") return null;
	if ("attachmentId" in value && typeof value.attachmentId === "string") {
		return value as AttachmentDto;
	}
	if ("attachment" in value && value.attachment && typeof value.attachment === "object") {
		return value.attachment as AttachmentDto;
	}
	return null;
}

export function createAppStore(): AppStore {
	let state: AppState = INITIAL_APP_STATE;
	const listeners = new Set<() => void>();
	const buffers = new Map<string, DesktopEvent[]>();
	/**
	 * Eventos que chegaram antes de o renderer conhecer a sessão (avisos de
	 * inicialização, primeiro evento após open/create). Sem isso eles eram
	 * descartados e o primeiro snapshot parecia vir de outra geração.
	 */
	const earlyBuffers = new Map<string, { at: number; events: DesktopEvent[] }>();
	const resyncInFlight = new Set<string>();
	const lastStatsAt = new Map<string, number>();
	/** Incrementado quando o host reinicia: snapshots em voo não valem mais. */
	let sessionEpoch = 0;
	/** O host avisou `starting-host`; ao voltar a `ready` as abas reabrem do zero. */
	let hostRestartPending = false;

	let unsubscribeEvents: (() => void) | null = null;
	let started = false;
	let persistTimer: ReturnType<typeof setTimeout> | null = null;
	let persistedTabs: PersistedTab[] = [];
	let persistedActiveSessionId: string | null = null;
	/** Workspaces cujas abas já foram restauradas nesta execução; só eles são autoritativos. */
	const hydratedWorkspaces = new Set<string>();

	const set = (updater: (current: AppState) => AppState): void => {
		const next = updater(state);
		if (next === state) return;
		state = next;
		for (const listener of listeners) listener();
	};

	const patch = (partial: Partial<AppState>): void => {
		set((current) => ({ ...current, ...partial }));
	};

	/** Traduz no idioma atual do store; o locale pode mudar em tempo de execução. */
	const t = (key: MessageKey, params?: MessageParams): string => translate(state.locale, key, params);
	/** Detalhe técnico do host; "Indisponível" quando o erro não traz mensagem. */
	const detailOf = (error: unknown): string => errorDetail(error) ?? t("common.unavailable");

	let noticeSeq = 0;
	const notify = (level: AppNotice["level"], text: string): void => {
		const id = `notice-${Date.now()}-${++noticeSeq}`;
		set((current) => ({ ...current, notices: [...current.notices, { id, level, text }] }));
		setTimeout(() => actions.dismissNotice(id), level === "error" ? 10_000 : 7_000);
	};

	const dismissNotice = (id: string): void => {
		set((current) =>
			current.notices.some((notice) => notice.id === id)
				? { ...current, notices: current.notices.filter((notice) => notice.id !== id) }
				: current,
		);
	};

	const updateSessionState = (sessionId: string, updater: (view: SessionViewState) => SessionViewState): void => {
		set((current) => {
			const view = current.sessionStates[sessionId];
			if (!view) return current;
			const next = updater(view);
			if (next === view) return current;
			return { ...current, sessionStates: { ...current.sessionStates, [sessionId]: next } };
		});
	};

	const serializeTabs = (current: AppState): PersistedTab[] => {
		const open = current.tabs.flatMap((sessionId) => {
			const record = current.sessionRecords[sessionId];
			if (!record) return [];
			return [
				{
					workspaceId: record.workspaceId,
					sessionId: record.sessionId,
					sessionPath: record.sessionPath,
					title: record.title,
				},
			];
		});
		// Workspaces ainda não restaurados mantêm as abas persistidas anteriores.
		const hidden = persistedTabs.filter((tab) => !hydratedWorkspaces.has(tab.workspaceId));
		return [...open, ...hidden];
	};

	let flushOnHide: (() => void) | null = null;
	let uiBase: Record<string, unknown> = {};
	const persistNow = async (): Promise<void> => {
		const shell = {
			version: SHELL_VERSION,
			layout: state.layout,
			theme: state.theme,
			activeWorkspaceId: state.activeWorkspaceId,
			tabs: serializeTabs(state),
			unreadSessions: state.unreadSessions,
			locale: state.locale,
			activeSessionId:
				state.activeSessionId ??
				(state.activeWorkspaceId && !hydratedWorkspaces.has(state.activeWorkspaceId)
					? persistedActiveSessionId
					: null),
		};
		try {
			// Uma única chamada: assim o descarte da janela ainda entrega a gravação ao main.
			uiBase = { ...uiBase, shell };
			await invoke({ op: "ui.setState", state: uiBase });
		} catch {
			// A persistência de layout não pode interromper o uso do app.
		}
	};

	const schedulePersist = (): void => {
		clearTimeout(persistTimer ?? undefined);
		persistTimer = setTimeout(() => {
			persistTimer = null;
			void persistNow();
		}, 350);
	};

	const recordFor = (sessionId: string): SessionRecord | null => state.sessionRecords[sessionId] ?? null;

	const requestStats = async (sessionId: string): Promise<void> => {
		const record = recordFor(sessionId);
		if (!record) return;
		const now = Date.now();
		const last = lastStatsAt.get(sessionId) ?? 0;
		if (now - last < 800) return;
		lastStatsAt.set(sessionId, now);
		try {
			const result = await invoke<unknown>({
				op: "session.rpc",
				workspaceId: record.workspaceId,
				sessionId,
				command: { type: "get_session_stats" },
			});
			const stats = normalizeStats(result);
			if (!stats) return;
			updateSessionState(sessionId, (view) => ({ ...view, stats }));
		} catch {
			// Estatísticas são complementares; uma falha não vira erro de sessão.
		}
	};

	/**
	 * Aplica uma lista de eventos sobre um estado base, na ordem de sequência.
	 * Devolve o resto a partir da primeira lacuna para quem chamou decidir se
	 * re-bufferiza. Eventos de geração anterior não pertencem ao processo vivo.
	 */
	const drainInto = (
		base: SessionViewState,
		events: readonly DesktopEvent[],
	): { view: SessionViewState; retry: boolean; rest: DesktopEvent[] } => {
		const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
		let view = base;
		for (let index = 0; index < ordered.length; index++) {
			const event = ordered[index];
			if (
				event.generation !== base.generation &&
				event.name !== "session.status" &&
				event.name !== "desktop_snapshot"
			) {
				continue;
			}
			const disposition = classifySessionEvent(view, event);
			if (disposition === "ignore") continue;
			if (disposition === "resync") return { view, retry: true, rest: ordered.slice(index) };
			view = applyEvent(view, event);
		}
		return { view, retry: false, rest: [] };
	};

	const drainBuffered = (sessionId: string, base: SessionViewState): { view: SessionViewState; retry: boolean } => {
		const buffered = buffers.get(sessionId) ?? [];
		buffers.delete(sessionId);
		const drained = drainInto(base, buffered);
		if (drained.retry && drained.rest.length > 0) buffers.set(sessionId, drained.rest);
		return { view: drained.view, retry: drained.retry };
	};

	const pruneEarlyBuffers = (now: number): void => {
		for (const [sessionId, entry] of earlyBuffers) {
			if (now - entry.at > EARLY_BUFFER_TTL_MS) earlyBuffers.delete(sessionId);
		}
	};

	const bufferEarlyEvent = (sessionId: string, event: DesktopEvent): void => {
		const now = Date.now();
		pruneEarlyBuffers(now);
		const entry = earlyBuffers.get(sessionId);
		if (!entry) {
			earlyBuffers.set(sessionId, { at: now, events: [event] });
			return;
		}
		entry.events.push(event);
		if (entry.events.length > EARLY_BUFFER_LIMIT) {
			entry.events.splice(0, entry.events.length - EARLY_BUFFER_LIMIT);
		}
	};

	/**
	 * Aplica os eventos guardados antes do snapshot. Os que o snapshot já cobre
	 * são ignorados por `classifySessionEvent`; uma lacuna volta para o buffer de
	 * ressincronização em vez de aplicar fora de ordem.
	 */
	const drainEarlyEvents = (
		sessionId: string,
		base: SessionViewState,
	): { view: SessionViewState; retry: boolean } => {
		const entry = earlyBuffers.get(sessionId);
		if (!entry) return { view: base, retry: false };
		earlyBuffers.delete(sessionId);
		if (Date.now() - entry.at > EARLY_BUFFER_TTL_MS) return { view: base, retry: false };
		const drained = drainInto(base, entry.events);
		if (drained.retry && drained.rest.length > 0) {
			const pending = buffers.get(sessionId) ?? [];
			buffers.set(sessionId, [...drained.rest, ...pending]);
		}
		return { view: drained.view, retry: drained.retry };
	};

	const installSnapshot = (workspaceId: string, snapshot: SessionSnapshot, options: InstallOptions): void => {
		if (!snapshot || !snapshot.state) return;
		const baseView = clearDialogsForLostSession(snapshot.state);
		const sessionId = baseView.sessionId;
		// Avisos/eventos que chegaram antes deste snapshot entram agora, na ordem,
		// ignorando o que a sequência do snapshot já cobre.
		const early = drainEarlyEvents(sessionId, baseView);
		const view = early.view;
		hydratedWorkspaces.add(workspaceId);
		const record: SessionRecord = {
			sessionId,
			workspaceId: view.workspaceId || workspaceId,
			sessionPath: snapshot.sessionPath,
			title: view.meta?.sessionName ?? options.title,
		};
		set((current) => {
			const previousRecord = current.sessionRecords[sessionId];
			const tabs = current.tabs.includes(sessionId) ? current.tabs : [...current.tabs, sessionId];
			const canReceiveFocus = current.activeWorkspaceId === null || current.activeWorkspaceId === record.workspaceId;
			const activeSessionId = options.activate && canReceiveFocus ? sessionId : current.activeSessionId;
			return {
				...current,
				sessionRecords: {
					...current.sessionRecords,
					[sessionId]: {
						...record,
						title:
							record.title ??
							previousRecord?.title ??
							fallbackSessionTitle(record.sessionPath ?? previousRecord?.sessionPath, sessionId),
						sessionPath: record.sessionPath ?? previousRecord?.sessionPath,
					},
				},
				sessionStates: { ...current.sessionStates, [sessionId]: view },
				tabs,
				activeSessionId,
				resyncing: { ...current.resyncing, [sessionId]: false },
			};
		});
		schedulePersist();
		void requestStats(sessionId);
		if (early.retry) void refreshSnapshot(sessionId);
	};

	const refreshSnapshot = async (sessionId: string, attempt = 0): Promise<void> => {
		if (resyncInFlight.has(sessionId)) return;
		const record = recordFor(sessionId);
		if (!record) return;
		const epoch = sessionEpoch;
		resyncInFlight.add(sessionId);
		set((current) => ({ ...current, resyncing: { ...current.resyncing, [sessionId]: true } }));
		let retry = false;
		try {
			const snapshot = await invoke<SessionSnapshot>({
				op: "session.snapshot",
				workspaceId: record.workspaceId,
				sessionId,
			});
			// O host reiniciou durante o pedido: este snapshot é de um processo morto.
			if (epoch !== sessionEpoch) return;
			const drained = drainBuffered(sessionId, snapshot.state);
			retry = drained.retry;
			installSnapshot(record.workspaceId, { ...snapshot, state: drained.view }, { activate: false });
		} catch (error) {
			buffers.delete(sessionId);
			if (epoch !== sessionEpoch) return;
			notify("error", t("store.resyncFailed", { detail: detailOf(error) }));
		} finally {
			resyncInFlight.delete(sessionId);
			set((current) => ({ ...current, resyncing: { ...current.resyncing, [sessionId]: false } }));
		}
		if (retry && attempt < 2) {
			void refreshSnapshot(sessionId, attempt + 1);
		} else if (retry) {
			notify("warning", t("store.outOfOrder"));
		}
	};

	const discardOpenSessions = (): void => {
		// As abas continuam persistidas: ao voltar a `ready` elas reabrem do zero,
		// sem reenviar nenhum prompt.
		persistedTabs = serializeTabs(state);
		if (state.activeSessionId) persistedActiveSessionId = state.activeSessionId;
		// Sem sessões abertas o workspace volta ao estado "não hidratado" para a
		// persistência manter as abas antigas até a reabertura terminar.
		hydratedWorkspaces.clear();
		sessionEpoch += 1;
		buffers.clear();
		earlyBuffers.clear();
		resyncInFlight.clear();
		// Restaurações em voo pertencem ao host morto; a nova abertura começa limpa.
		openWorkspaceInFlight.clear();
		set((current) => ({
			...current,
			sessionRecords: {},
			sessionStates: {},
			tabs: [],
			activeSessionId: null,
			sending: {},
			resyncing: {},
			restoringTabs: false,
		}));
		schedulePersist();
	};

	const handleEvent = (event: DesktopEvent): void => {
		if (event.name === "host.status") {
			const status = event.data as RuntimeStatus | undefined;
			if (status && typeof status === "object" && typeof status.phase === "string") {
				if (status.phase === "starting-host") {
					hostRestartPending = true;
					if (state.tabs.length > 0 || Object.keys(state.sessionRecords).length > 0) {
						discardOpenSessions();
					} else {
						sessionEpoch += 1;
					}
				}
				patch({ runtime: status, runtimeError: null });
				// O main também emite status depois de adicionar o projeto inicial
				// (`--cwd`); recarregar a lista a cada status mantém esse caso.
				void loadWorkspaces();
				if (status.phase === "ready" && hostRestartPending) {
					hostRestartPending = false;
					const workspace = activeWorkspace(state);
					if (workspace?.available) void openWorkspace(workspace.workspaceId);
				}
			}
			return;
		}
		const sessionId = event.sessionId;
		if (!sessionId) return;
		const record = state.sessionRecords[sessionId];
		if (record && event.workspaceId && event.workspaceId !== record.workspaceId) return;
		// O host cancela pedidos de diálogo que não sabemos responder. Avisamos
		// mesmo durante resync ou antes do snapshot, sem duplicar o cancelamento.
		const unsupported = unsupportedDialogMethod(event.data);
		if (unsupported) {
			notify("warning", t("store.unsupportedDialog", { method: unsupported }));
		}
		if (!record) {
			// A sessão ainda não é conhecida (avisos de inicialização, primeiro
			// evento após open/create). Guarda para aplicar quando o snapshot chegar.
			bufferEarlyEvent(sessionId, event);
			return;
		}

		if (resyncInFlight.has(sessionId) || state.resyncing[sessionId]) {
			const buffer = buffers.get(sessionId) ?? [];
			buffer.push(event);
			buffers.set(sessionId, buffer);
			return;
		}

		const view = state.sessionStates[sessionId];
		if (!view) {
			const buffer = buffers.get(sessionId) ?? [];
			buffer.push(event);
			buffers.set(sessionId, buffer);
			void refreshSnapshot(sessionId);
			return;
		}
		const disposition = classifySessionEvent(view, event);
		if (disposition === "ignore") return;
		if (disposition === "resync") {
			const buffer = buffers.get(sessionId) ?? [];
			buffer.push(event);
			buffers.set(sessionId, buffer);
			void refreshSnapshot(sessionId);
			return;
		}
		const next = clearDialogsForLostSession(applyEvent(view, event));
		if (next === view) return;
		const renamed = Boolean(
			next.meta?.sessionName && next.meta.sessionName !== state.sessionRecords[sessionId]?.title,
		);
		set((current) => ({
			...current,
			sessionStates: { ...current.sessionStates, [sessionId]: next },
			sessionRecords: renamed
				? {
						...current.sessionRecords,
						[sessionId]: {
							...current.sessionRecords[sessionId],
							title: next.meta?.sessionName,
						},
					}
				: current.sessionRecords,
		}));
		if (renamed) schedulePersist();
		if (event.name === "desktop_snapshot") {
			const snapshot = event.data as SessionSnapshot | undefined;
			if (snapshot?.sessionPath) {
				set((current) => ({
					...current,
					sessionRecords: {
						...current.sessionRecords,
						[sessionId]: { ...current.sessionRecords[sessionId], sessionPath: snapshot.sessionPath },
					},
				}));
			}
			schedulePersist();
		}
		const becameSettled = next.meta?.isSettled === true && view.meta?.isSettled !== true;
		if (becameSettled || event.name === "desktop_snapshot") void requestStats(sessionId);
		if (becameSettled) void loadSessions(record.workspaceId);
	};

	const loadWorkspaces = async (): Promise<void> => {
		try {
			const workspaces = await invoke<WorkspaceDto[]>({ op: "workspace.list" });
			const list = Array.isArray(workspaces) ? workspaces : [];
			patch({ workspaces: list, workspacesLoaded: true, workspacesError: null });
			if (state.activeWorkspaceId && !list.some((item) => item.workspaceId === state.activeWorkspaceId)) {
				patch({ activeWorkspaceId: null });
				schedulePersist();
			}
		} catch (error) {
			patch({
				workspaces: [],
				workspacesLoaded: true,
				workspacesError: detailOf(error),
			});
		}
	};

	const loadSessions = async (workspaceId: string): Promise<SessionListItem[]> => {
		set((current) => ({
			...current,
			sessionsLoading: { ...current.sessionsLoading, [workspaceId]: true },
			sessionsError: { ...current.sessionsError, [workspaceId]: null },
		}));
		try {
			const items = await invoke<SessionListItem[]>({ op: "session.list", workspaceId });
			const list = Array.isArray(items) ? items : [];
			set((current) => {
				const records = { ...current.sessionRecords };
				for (const item of list) {
					if (!item.openSessionId) continue;
					const record = records[item.openSessionId];
					if (record) {
						records[item.openSessionId] = {
							...record,
							title: record.title ?? item.title,
							sessionPath: record.sessionPath ?? item.path,
						};
					}
				}
				return {
					...current,
					sessionsByWorkspace: { ...current.sessionsByWorkspace, [workspaceId]: list },
					sessionsLoading: { ...current.sessionsLoading, [workspaceId]: false },
					sessionRecords: records,
				};
			});
			return list;
		} catch (error) {
			set((current) => ({
				...current,
				sessionsByWorkspace: { ...current.sessionsByWorkspace, [workspaceId]: current.sessionsByWorkspace[workspaceId] ?? [] },
				sessionsLoading: { ...current.sessionsLoading, [workspaceId]: false },
				sessionsError: { ...current.sessionsError, [workspaceId]: detailOf(error) },
			}));
			return [];
		}
	};

	const openSessionInternal = async (
		workspaceId: string,
		sessionPath: string,
		options: InstallOptions,
	): Promise<boolean> => {
		try {
			const snapshot = await invoke<SessionSnapshot>({
				op: "session.open",
				workspaceId,
				sessionPath,
			});
			const listedTitle = state.sessionsByWorkspace[workspaceId]?.find((item) => item.path === sessionPath)?.title;
			installSnapshot(workspaceId, snapshot, { ...options, title: listedTitle ?? options.title });
			void loadSessions(workspaceId);
			return true;
		} catch (error) {
			const detail = detailOf(error);
			if (options.quiet) notify("warning", t("store.reopenFailed", { detail }));
			else notify("error", t("store.openSessionFailed", { detail }));
			return false;
		}
	};

	const restoreTabsForWorkspace = async (workspaceId: string): Promise<void> => {
		const wanted = persistedTabs.filter((tab) => tab.workspaceId === workspaceId);
		if (wanted.length === 0) return;
		const epoch = sessionEpoch;
		patch({ restoringTabs: true });
		try {
			const list = state.sessionsByWorkspace[workspaceId] ?? (await loadSessions(workspaceId));
			if (epoch !== sessionEpoch) return;
			for (const tab of wanted) {
				if (epoch !== sessionEpoch) return;
				const alreadyOpen =
					(tab.sessionId && state.sessionRecords[tab.sessionId]) ||
					(tab.sessionPath &&
						Object.values(state.sessionRecords).some(
							(record) => record.workspaceId === workspaceId && record.sessionPath === tab.sessionPath,
						));
				if (alreadyOpen) continue;

				const item = tab.sessionPath ? list.find((entry) => entry.path === tab.sessionPath) : undefined;
				const liveSessionId = item?.openSessionId ?? tab.sessionId;
				if (liveSessionId) {
					try {
						const snapshot = await invoke<SessionSnapshot>({
							op: "session.snapshot",
							workspaceId,
							sessionId: liveSessionId,
						});
						if (epoch !== sessionEpoch) return;
						installSnapshot(workspaceId, snapshot, {
							activate: false,
							quiet: true,
							title: tab.title ?? item?.title,
						});
						continue;
					} catch {
						// Processo vivo não respondeu; cai para abrir pelo caminho persistido.
					}
				}
				if (tab.sessionPath) {
					await openSessionInternal(workspaceId, tab.sessionPath, {
						activate: false,
						quiet: true,
						title: tab.title,
					});
					if (epoch !== sessionEpoch) return;
				}
			}

			const activeIsOpen = state.activeSessionId && state.sessionRecords[state.activeSessionId];
			if (!activeIsOpen) {
				const preferredTab = persistedActiveSessionId
					? persistedTabs.find((tab) => tab.sessionId === persistedActiveSessionId)
					: undefined;
				const preferred = preferredTab
					? state.tabs.find((sessionId) => {
							const record = state.sessionRecords[sessionId];
							return (
								record?.workspaceId === workspaceId &&
								(preferredTab.sessionPath
									? record.sessionPath === preferredTab.sessionPath
									: sessionId === persistedActiveSessionId)
							);
						})
					: undefined;
				const restored = state.tabs.find((sessionId) => state.sessionRecords[sessionId]?.workspaceId === workspaceId);
				const nextActive = preferred ?? restored ?? null;
				if (nextActive) {
					patch({ activeSessionId: nextActive });
					schedulePersist();
				}
			}
		} finally {
			if (epoch === sessionEpoch) patch({ restoringTabs: false });
		}
	};

	const applyPersistedShell = (raw: Record<string, unknown> | null): void => {
		const shell = raw && typeof raw === "object" && raw.shell && typeof raw.shell === "object"
			? (raw.shell as Record<string, unknown>)
			: null;
		if (!shell) return;
		const layout = clampLayout({ ...DEFAULT_LAYOUT, ...((shell.layout ?? {}) as Record<string, unknown>) });
		const theme: ThemeMode =
			shell.theme === "dark" || shell.theme === "light" ? shell.theme : "system";
		persistedTabs = Array.isArray(shell.tabs) ? shell.tabs.filter(isPersistedTab) : [];
		patch({
			locale: isLocale(shell.locale) ? shell.locale : detectLocale(typeof navigator === "undefined" ? undefined : navigator.language),
			unreadSessions: Array.isArray(shell.unreadSessions) ? shell.unreadSessions.filter((id) => typeof id === "string") : [] });
		persistedActiveSessionId = typeof shell.activeSessionId === "string" ? shell.activeSessionId : null;
		patch({
			layout,
			theme,
			activeWorkspaceId: typeof shell.activeWorkspaceId === "string" ? shell.activeWorkspaceId : null,
		});
	};

	const openWorkspaceInFlight = new Map<string, Promise<void>>();
	const openWorkspace = (workspaceId: string): Promise<void> => {
		// Abertura concorrente (boot + clique) reutiliza a mesma restauração de abas.
		const running = openWorkspaceInFlight.get(workspaceId);
		if (running) return running;
		const promise = openWorkspaceOnce(workspaceId).finally(() => {
			// Um reinício do host pode substituir a promessa; só remove a própria.
			if (openWorkspaceInFlight.get(workspaceId) === promise) openWorkspaceInFlight.delete(workspaceId);
		});
		openWorkspaceInFlight.set(workspaceId, promise);
		return promise;
	};

	const openWorkspaceOnce = async (workspaceId: string): Promise<void> => {
		const workspace = state.workspaces.find((item) => item.workspaceId === workspaceId);
		if (!workspace) {
			notify("error", t("store.workspaceMissing"));
			return;
		}
		if (!workspace.available) {
			notify("warning", t("store.workspaceUnavailable"));
			return;
		}
		const epoch = sessionEpoch;
		patch({ activeWorkspaceId: workspaceId });
		schedulePersist();
		await loadSessions(workspaceId);
		await restoreTabsForWorkspace(workspaceId);
		if (epoch !== sessionEpoch) return;
		hydratedWorkspaces.add(workspaceId);
		if (!state.activeSessionId || state.sessionRecords[state.activeSessionId]?.workspaceId !== workspaceId) {
			const first = state.tabs.find((sessionId) => state.sessionRecords[sessionId]?.workspaceId === workspaceId);
			patch({ activeSessionId: first ?? null });
			schedulePersist();
		}
	};

	/**
	 * Reimporta imagens devolvidas pelo OMP (fila/abort) como anexos do
	 * rascunho. Falhas são contadas, nunca silenciadas.
	 */
	const importRestoredImages = async (
		workspaceId: string,
		images: readonly RestoredImage[],
	): Promise<{ attachments: AttachmentDto[]; failures: number }> => {
		const attachments: AttachmentDto[] = [];
		let failures = 0;
		for (const [index, image] of images.entries()) {
			try {
				const attachment = unwrapAttachment(
					await invoke<unknown>({
						op: "attachment.import",
						workspaceId,
						name: `imagem-restaurada-${index + 1}.${extensionForMime(image.mimeType)}`,
						mimeType: image.mimeType,
						bytes: base64ToBytes(image.data),
					}),
				);
				if (attachment) attachments.push(attachment);
			} catch {
				failures += 1;
			}
		}
		return { attachments, failures };
	};

	const actions: AppActions = {
		start() {
			if (started) return () => undefined;
			started = true;
			unsubscribeEvents = subscribe(handleEvent);
			flushOnHide = () => {
				if (persistTimer === null) return;
				clearTimeout(persistTimer);
				persistTimer = null;
				void persistNow();
			};
			if (typeof window.addEventListener === "function") window.addEventListener("pagehide", flushOnHide);
			void (async () => {
				try {
					const persisted = await invoke<Record<string, unknown>>({ op: "ui.getState" });
					uiBase = persisted && typeof persisted === "object" ? persisted : {};
					applyPersistedShell(persisted && typeof persisted === "object" ? persisted : null);
				} catch {
					// Sem estado persistido, usa os padrões.
				}
				await actions.refreshRuntime();
				await actions.loadWorkspaces();
				patch({ boot: "ready" });
				const current = activeWorkspace(state);
				if (state.runtime?.phase === "ready" && current?.available) {
					void openWorkspace(current.workspaceId);
				}
			})().catch((error: unknown) => {
				patch({ boot: "ready" });
				notify("error", t("store.startFailed", { detail: detailOf(error) }));
			});
			return () => {
				if (flushOnHide && typeof window.removeEventListener === "function") window.removeEventListener("pagehide", flushOnHide);
				flushOnHide = null;
				unsubscribeEvents?.();
				unsubscribeEvents = null;
				started = false;
				clearTimeout(persistTimer ?? undefined);
				persistTimer = null;
			};
		},

		async refreshRuntime() {
			try {
				const status = await invoke<RuntimeStatus>({ op: "runtime.status" });
				patch({ runtime: status, runtimeError: null });
			} catch (error) {
				patch({ runtime: null, runtimeError: detailOf(error) });
			}
		},

		async retryRuntime() {
			await actions.refreshRuntime();
			if (state.runtime?.phase === "ready") {
				await actions.loadWorkspaces();
				const workspace = activeWorkspace(state);
				if (workspace?.available) await openWorkspace(workspace.workspaceId);
			}
		},

		async selectOmp() {
			try {
				const status = await invoke<RuntimeStatus>({ op: "runtime.selectOmp" });
				if (status && typeof status === "object" && typeof status.phase === "string") {
					patch({ runtime: status, runtimeError: null });
				} else {
					await actions.refreshRuntime();
				}
				await actions.loadWorkspaces();
				const workspace = activeWorkspace(state);
				if (state.runtime?.phase === "ready" && workspace?.available) {
					await openWorkspace(workspace.workspaceId);
				}
			} catch (error) {
				notify("error", t("store.selectOmpFailed", { detail: detailOf(error) }));
			}
		},

		async installOmp() {
			try {
				const status = await invoke<RuntimeStatus>({ op: "runtime.installOmp" });
				if (status && typeof status === "object" && typeof status.phase === "string") {
					patch({ runtime: status, runtimeError: null });
					if (status.install?.state === "error") {
						notify(
							"error",
							t(installErrorKey(status.install.code), { message: status.install.message }),
						);
					}
				} else {
					await actions.refreshRuntime();
				}
				await actions.loadWorkspaces();
				const workspace = activeWorkspace(state);
				if (state.runtime?.phase === "ready" && workspace?.available) {
					await openWorkspace(workspace.workspaceId);
				}
			} catch (error) {
				notify("error", t("store.installOmpFailed", { detail: detailOf(error) }));
			}
		},

		applyDependencies(snapshot) {
			set((current) => {
				if (!current.runtime) return current;
				return { ...current, runtime: { ...current.runtime, dependencies: snapshot } };
			});
		},

		loadWorkspaces,

		async pickWorkspace() {
			try {
				const picked = await invoke<WorkspaceDto | null>({ op: "workspace.pick" });
				if (!picked) return;
				await actions.loadWorkspaces();
				await openWorkspace(picked.workspaceId);
			} catch (error) {
				notify("error", t("store.pickWorkspaceFailed", { detail: detailOf(error) }));
			}
		},

		async removeWorkspace(workspaceId: string) {
			try {
				await invoke({ op: "workspace.removeRecent", workspaceId });
				await actions.loadWorkspaces();
				if (state.activeWorkspaceId === workspaceId) {
					patch({ activeWorkspaceId: null, activeSessionId: null });
					schedulePersist();
				}
			} catch (error) {
				notify("error", t("store.removeWorkspaceFailed", { detail: detailOf(error) }));
			}
		},

		async relocateWorkspace(workspaceId: string) {
			try {
				const relocated = await invoke<WorkspaceDto | null>({ op: "workspace.relocate", workspaceId });
				if (!relocated) return;
				await actions.loadWorkspaces();
				if (relocated.available) await openWorkspace(relocated.workspaceId);
			} catch (error) {
				notify("error", t("store.relocateWorkspaceFailed", { detail: detailOf(error) }));
			}
		},

		async openWorkspace(workspaceId: string) {
			await openWorkspace(workspaceId);
		},

		loadSessions,

		async createSession(workspaceId?: string) {
			const target = workspaceId ?? state.activeWorkspaceId;
			if (!target) {
				notify("warning", t("store.noWorkspaceForSession"));
				return false;
			}
			try {
				const snapshot = await invoke<SessionSnapshot>({ op: "session.create", workspaceId: target });
				installSnapshot(target, snapshot, { activate: true });
				void loadSessions(target);
				return true;
			} catch (error) {
				notify("error", t("store.createSessionFailed", { detail: detailOf(error) }));
				return false;
			}
		},

		async openSession(workspaceId: string, sessionPath: string) {
			return openSessionInternal(workspaceId, sessionPath, { activate: true });
		},

		activateSession(sessionId: string) {
			if (!state.sessionRecords[sessionId]) return;
			patch({ activeSessionId: sessionId });
			schedulePersist();
			void requestStats(sessionId);
		},

		async closeSession(sessionId: string) {
			const record = recordFor(sessionId);
			if (!record) return false;
			try {
				await invoke({ op: "session.close", workspaceId: record.workspaceId, sessionId });
			} catch (error) {
				notify("error", t("store.closeSessionFailed", { detail: detailOf(error) }));
				return false;
			}
			set((current) => {
				const tabs = current.tabs.filter((id) => id !== sessionId);
				const nextActive =
					current.activeSessionId === sessionId
						? (tabs.find((id) => current.sessionRecords[id]?.workspaceId === record.workspaceId) ?? null)
						: current.activeSessionId;
				const records = { ...current.sessionRecords };
				delete records[sessionId];
				const states = { ...current.sessionStates };
				delete states[sessionId];
				const drafts = { ...current.drafts };
				delete drafts[sessionId];
				const sending = { ...current.sending };
				delete sending[sessionId];
				return {
					...current,
					tabs,
					activeSessionId: nextActive,
					sessionRecords: records,
					sessionStates: states,
					drafts,
					sending,
				};
			});
			buffers.delete(sessionId);
			earlyBuffers.delete(sessionId);
			schedulePersist();
			void loadSessions(record.workspaceId);
			return true;
		},

		refreshSnapshot,

		requestStats,

		async sendPrompt(sessionId, text, attachmentIds, behavior) {
			const record = recordFor(sessionId);
			if (!record) return false;
			if (state.sending[sessionId]) return false;
			const trimmed = text.trim();
			if (!trimmed && attachmentIds.length === 0) return false;

			const command: RpcCommandInput =
				behavior === "steer"
					? { type: "steer", message: text, ...(attachmentIds.length ? { attachmentIds } : {}) }
					: behavior === "followUp"
						? { type: "follow_up", message: text, ...(attachmentIds.length ? { attachmentIds } : {}) }
						: { type: "prompt", message: text, ...(attachmentIds.length ? { attachmentIds } : {}) };

			set((current) => ({ ...current, sending: { ...current.sending, [sessionId]: true } }));
			try {
				await invoke({
					op: "session.rpc",
					workspaceId: record.workspaceId,
					sessionId,
					command,
				});
				set((current) => {
					const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
					const settled = settleDraftAfterAck(draft, { text, attachmentIds });
					return { ...current, drafts: { ...current.drafts, [sessionId]: settled } };
				});
				return true;
			} catch (error) {
				notify("error", t("store.promptRejected", { detail: detailOf(error) }));
				return false;
			} finally {
				set((current) => ({ ...current, sending: { ...current.sending, [sessionId]: false } }));
			}
		},

		async abortAndRestore(sessionId) {
			const record = recordFor(sessionId);
			if (!record) return;
			try {
				const result = await invoke<unknown>({
					op: "session.rpc",
					workspaceId: record.workspaceId,
					sessionId,
					command: { type: "abort_and_restore_queue" },
				});
				const outcome = parseAbortRestore(result);
				const imported = await importRestoredImages(record.workspaceId, outcome.restoredImages);
				set((current) => {
					const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
					let next: ComposerDraft = draft;
					if (outcome.restoredText) next = mergeRestoredDraft(next, outcome.restoredText);
					next = appendAttachments(next, [...outcome.restoredAttachments, ...imported.attachments]);
					return { ...current, drafts: { ...current.drafts, [sessionId]: next } };
				});
				if (imported.failures > 0) {
					notify("warning", t("store.restoredImagesFailed", { count: imported.failures }));
				}
				if (outcome.truncated) {
					notify("warning", t("store.queueTruncated"));
				}
				if (outcome.imagesDropped) {
					notify("warning", t("store.queueImagesDropped"));
				}
			} catch (error) {
				notify("error", t("store.abortFailed", { detail: detailOf(error) }));
			}
		},

		async removeQueued(sessionId, message, queue) {
			const record = recordFor(sessionId);
			if (!record) return;
			const view = state.sessionStates[sessionId];
			if (view) {
				const index = removableIndexOf(view.queue, queue, message);
				// Só bloqueia o que já foi entregue ao agente. Item ausente do
				// recorte local segue para o OMP decidir (o evento atualiza a lista).
				if (index < 0 && queue === "steering" && view.queue.steering.includes(message)) {
					notify("warning", t("store.steeringDelivered"));
					return;
				}
			}
			try {
				const result = await invoke<unknown>({
					op: "session.rpc",
					workspaceId: record.workspaceId,
					sessionId,
					command: { type: "remove_queued_message", message, queue },
				});
				if (result && typeof result === "object" && "removed" in result && result.removed === false) {
					notify("warning", t("store.queueRemoveUnconfirmed"));
					return;
				}
				// O OMP devolve as imagens da mensagem removida: sem reimportá-las
				// como anexos, a imagem sumiria junto com o texto.
				const imported = await importRestoredImages(record.workspaceId, parseQueueImages(result));
				if (imported.attachments.length > 0) {
					set((current) => {
						const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
						return {
							...current,
							drafts: {
								...current.drafts,
								[sessionId]: appendAttachments(draft, imported.attachments),
							},
						};
					});
				}
				if (imported.failures > 0) {
					notify("warning", t("store.queueRestoreImagesFailed", { count: imported.failures }));
				}
				if (queueImagesDropped(result)) {
					notify("warning", t("store.queueImagesExceeded"));
				}
				updateSessionState(sessionId, (current) => {
					const index = removableIndexOf(current.queue, queue, message);
					if (index < 0) return current;
					const list = current.queue[queue];
					return {
						...current,
						queue: { ...current.queue, [queue]: [...list.slice(0, index), ...list.slice(index + 1)] },
					};
				});
			} catch (error) {
				notify("error", t("store.removeQueuedFailed", { detail: detailOf(error) }));
			}
		},

		async promoteQueued(sessionId, message) {
			const record = recordFor(sessionId);
			if (!record) return;
			try {
				const result = await invoke<unknown>({
					op: "session.rpc",
					workspaceId: record.workspaceId,
					sessionId,
					command: { type: "promote_queued_message", message },
				});
				// `promoted: false` significa que o OMP não moveu nada: manter a fila
				// e avisar é a única leitura honesta.
				if (parsePromoted(result) === false) {
					notify("warning", t("store.promoteUnconfirmed"));
					return;
				}
				updateSessionState(sessionId, (view) => {
					const index = view.queue.followUp.indexOf(message);
					if (index < 0) return view;
					const followUp = [...view.queue.followUp.slice(0, index), ...view.queue.followUp.slice(index + 1)];
					return {
						...view,
						queue: {
							...view.queue,
							followUp,
							steering: [...view.queue.steering, message],
						},
					};
				});
			} catch (error) {
				notify("error", t("store.promoteFailed", { detail: detailOf(error) }));
			}
		},

		async respondDialog(sessionId, response) {
			const record = recordFor(sessionId);
			if (!record) {
				notify("warning", t("store.dialogSessionGone"));
				return false;
			}
			try {
				const result = await invoke<unknown>({
					op: "session.uiResponse",
					workspaceId: record.workspaceId,
					sessionId,
					response,
				});
				if (result && typeof result === "object" && "delivered" in result && result.delivered === false) {
					notify("warning", t("store.dialogNotDelivered"));
					return false;
				}
				return true;
			} catch (error) {
				notify("error", t("store.dialogResponseFailed", { detail: detailOf(error) }));
				return false;
			}
		},

		async exportHtml(sessionId) {
			const record = recordFor(sessionId);
			if (!record) return;
			try {
				const result = await invoke<{ saved?: boolean; path?: string }>({
					op: "session.exportHtml",
					workspaceId: record.workspaceId,
					sessionId,
				});
				if (result?.saved && result.path) notify("success", t("store.exported", { path: result.path }));
			} catch (error) {
				notify("error", t("store.exportFailed", { detail: detailOf(error) }));
			}
		},

		async navigateTree(sessionId, entryId) {
			const record = recordFor(sessionId);
			if (!record) return false;
			try {
				const result = await invoke<unknown>({
					op: "session.rpc",
					workspaceId: record.workspaceId,
					sessionId,
					command: { type: "navigate_tree", entryId },
				});
				if (result && typeof result === "object" && "cancelled" in result && result.cancelled === true) {
					notify("warning", t("store.navigateCancelled"));
					return false;
				}
				// Alvo era mensagem do usuário: o OMP devolve o texto para reeditar.
				const editorText = parseEditorText(result);
				await refreshSnapshot(sessionId);
				if (editorText) {
					set((current) => {
						const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
						const next =
							draft.text.trim().length === 0
								? { ...draft, text: editorText }
								: mergeRestoredDraft(draft, editorText);
						return {
							...current,
							drafts: { ...current.drafts, [sessionId]: next },
							composerFocusNonce: (current.composerFocusNonce ?? 0) + 1,
						};
					});
					notify("info", t("store.messageRestored"));
				}
				return true;
			} catch (error) {
				notify("error", t("store.navigateFailed", { detail: detailOf(error) }));
				return false;
			}
		},

		async forkSession(sessionId, entryId) {
			const record = recordFor(sessionId);
			if (!record) return false;
			try {
				const result = await invoke<unknown>({
					op: "session.rpc",
					workspaceId: record.workspaceId,
					sessionId,
					command: entryId ? { type: "fork", entryId } : { type: "fork" },
				});
				if (result && typeof result === "object" && "cancelled" in result && result.cancelled === true) {
					notify("warning", t("store.forkCancelled"));
					return false;
				}
				await refreshSnapshot(sessionId);
				return true;
			} catch (error) {
				notify("error", t("store.forkFailed", { detail: detailOf(error) }));
				return false;
			}
		},

		setDraft(sessionId, text) {
			if (!state.sessionRecords[sessionId]) return;
			set((current) => {
				const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
				if (draft.text === text) return current;
				return { ...current, drafts: { ...current.drafts, [sessionId]: { ...draft, text } } };
			});
		},

		insertIntoComposer(sessionId, text) {
			const record = state.sessionRecords[sessionId];
			if (!record) return;
			set((current) => {
				const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
				const nextText = draft.text.trim().length
					? `${draft.text.replace(/\s+$/, "")} ${text}`
					: text;
				return {
					...current,
					drafts: { ...current.drafts, [sessionId]: { ...draft, text: nextText } },
					composerFocusNonce: (current.composerFocusNonce ?? 0) + 1,
				};
			});
		},

		async pickAttachments(sessionId) {
			const record = recordFor(sessionId);
			if (!record) return;
			try {
				const result = await invoke<unknown>({ op: "attachment.pick", workspaceId: record.workspaceId });
				const list = unwrapAttachmentList(result);
				if (list.length === 0) return;
				set((current) => {
					const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
					return {
						...current,
						drafts: {
							...current.drafts,
							[sessionId]: appendAttachments(draft, list),
						},
					};
				});
			} catch (error) {
				notify("error", t("store.pickAttachmentFailed", { detail: detailOf(error) }));
			}
		},

		async importAttachment(sessionId, file) {
			const record = recordFor(sessionId);
			if (!record) return;
			if (attachmentLimitExceeded(file.size)) {
				notify("error", t("store.attachmentTooLarge", { limit: MAX_ATTACHMENT_BYTES / 1024 }));
				return;
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				const result = await invoke<unknown>({
					op: "attachment.import",
					workspaceId: record.workspaceId,
					name: file.name || "anexo",
					mimeType: file.type || "application/octet-stream",
					bytes,
				});
				const attachment = unwrapAttachment(result);
				if (!attachment) return;
				set((current) => {
					const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
					return {
						...current,
						drafts: { ...current.drafts, [sessionId]: appendAttachments(draft, [attachment]) },
					};
				});
			} catch (error) {
				notify("error", t("store.importAttachmentFailed", { detail: detailOf(error) }));
			}
		},

		async removeDraftAttachment(sessionId, attachmentId) {
			try {
				await invoke({ op: "attachment.remove", attachmentId });
				set((current) => {
					const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
					return {
						...current,
						drafts: { ...current.drafts, [sessionId]: removeAttachment(draft, attachmentId) },
					};
				});
			} catch (error) {
				notify("error", t("store.removeAttachmentFailed", { detail: detailOf(error) }));
			}
		},

		setUnreadSessions(ids: string[]) {
			patch({ unreadSessions: ids });
			schedulePersist();
		},

		restoreInterrupted(sessionId) {
			const view = state.sessionStates[sessionId];
			if (!view) return;
			for (let index = view.messages.length - 1; index >= 0; index--) {
				const message = view.messages[index];
				if (message.role !== "user") continue;
				const text = message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();
				if (!text) continue;
				set((current) => {
					const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
					return {
						...current,
						drafts: { ...current.drafts, [sessionId]: mergeRestoredDraft(draft, text) },
						composerFocusNonce: (current.composerFocusNonce ?? 0) + 1,
					};
				});
				notify("info", t("store.interruptedRestored"));
				return;
			}
			notify("warning", t("store.interruptedNotFound"));
		},

		setLayout(partial) {
			patch({ layout: clampLayout({ ...state.layout, ...partial }) });
			schedulePersist();
		},

		setTheme(theme) {
			patch({ theme });
			schedulePersist();
		},

		toggleTerminal() {
			actions.setLayout({ terminalOpen: !state.layout.terminalOpen });
		},

		setRightTab(tab) {
			actions.setLayout({ rightTab: tab });
		},

		toggleRightPanel() {
			actions.setLayout({ rightOpen: !state.layout.rightOpen });
		},

		showRightPanel(tab) {
			patch({
				layout: { ...state.layout, rightTab: tab, rightOpen: true },
				rightPanelRequest: state.rightPanelRequest + 1,
			});
			schedulePersist();
		},

		openSettings(tab) {
			patch({ settings: { open: true, initialTab: tab } });
		},

		closeSettings() {
			patch({ settings: { open: false } });
		},

		setModelPickerOpen(open) {
			patch({ modelPickerOpen: open });
		},

		setLocale(locale) {
			patch({ locale });
			schedulePersist();
		},

		setPaletteOpen(open, mode) {
			patch({ paletteOpen: open, ...(open && mode ? { paletteMode: mode } : {}) });
		},

		notify,

		dismissNotice,

		async openExternal(url) {
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				notify("warning", t("store.invalidLink"));
				return;
			}
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				notify("warning", t("store.unsafeLink"));
				return;
			}
			try {
				await invoke({ op: "runtime.openExternal", url: parsed.toString() });
			} catch (error) {
				notify("error", t("store.openLinkFailed", { detail: detailOf(error) }));
			}
		},

		async openWorkspaceFile(path) {
			const workspace = activeWorkspace(state);
			if (!workspace) return;
			try {
				await invoke({ op: "files.openExternal", workspaceId: workspace.workspaceId, path });
			} catch (error) {
				notify("error", t("store.openFileFailed", { detail: detailOf(error) }));
			}
		},
	};

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		actions,
	};
}

