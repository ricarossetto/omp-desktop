import type { Locale } from "../i18n";
import type { RuntimeStatus, WorkspaceDto, SessionListItem } from "@shared/contracts";
import type { SessionViewState } from "@shared/session-types";
import type { ComposerDraft } from "../features/conversation/composer-policy";

export type ThemeMode = "system" | "dark" | "light";
export type RightTab = "agents" | "changes";
export type SettingsTab = "models" | "accounts" | "general";

export interface LayoutState {
	sidebarWidth: number;
	rightWidth: number;
	terminalHeight: number;
	rightTab: RightTab;
	terminalOpen: boolean;
	/** No desktop controla a coluna; abaixo de 1000px controla o drawer. */
	rightOpen: boolean;
	/** Barra lateral expandida; recolhida vira um trilho de ícones. */
	sidebarOpen: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
	sidebarWidth: 256,
	rightWidth: 340,
	terminalHeight: 240,
	rightTab: "agents",
	terminalOpen: false,
	rightOpen: true,
	sidebarOpen: true,
};

export interface PersistedTab {
	workspaceId: string;
	sessionId?: string;
	sessionPath?: string;
	title?: string;
}

export interface SessionRecord {
	sessionId: string;
	workspaceId: string;
	sessionPath?: string;
	title?: string;
}

export interface AppNotice {
	id: string;
	level: "info" | "success" | "warning" | "error";
	text: string;
}

export interface SettingsOverlay {
	open: boolean;
	initialTab?: SettingsTab;
}

export type PaletteMode = "all" | "skills";


export interface AppState {
	runtime: RuntimeStatus | null;
	runtimeError: string | null;
	/** `loading` até a primeira leitura de ambiente/workspaces terminar. */
	boot: "loading" | "ready";

	workspaces: WorkspaceDto[];
	workspacesLoaded: boolean;
	workspacesError: string | null;
	activeWorkspaceId: string | null;

	sessionsByWorkspace: Record<string, SessionListItem[]>;
	sessionsLoading: Record<string, boolean>;
	sessionsError: Record<string, string | null>;

	sessionRecords: Record<string, SessionRecord>;
	sessionStates: Record<string, SessionViewState>;
	/** Abas abertas, na ordem exibida. */
	tabs: string[];
	activeSessionId: string | null;

	drafts: Record<string, ComposerDraft>;
	/** Envio de prompt em andamento (desabilita novo envio). */
	sending: Record<string, boolean>;
	/** Sessões aguardando snapshot de ressincronização. */
	resyncing: Record<string, boolean>;

	layout: LayoutState;
	theme: ThemeMode;
	notices: AppNotice[];

	settings: SettingsOverlay;
	modelPickerOpen: boolean;
	paletteOpen: boolean;
	/** "all" = busca geral; "skills" = só comandos de skill/MCP/extensão. */
	paletteMode: PaletteMode;
	/** Idioma da interface; persistido em shell.locale. */
	locale: Locale;
	restoringTabs: boolean;
	/** Sessões marcadas como "Nova" (terminou enquanto outra estava aberta); persistido. */
	unreadSessions: string[];
	/** Incrementado quando a paleta/restauração precisa focar o compositor. */
	composerFocusNonce: number;
	/** Incrementado quando uma ação pede para abrir o painel direito (inclusive em drawer). */
	rightPanelRequest: number;
}

export const INITIAL_APP_STATE: AppState = {
	runtime: null,
	runtimeError: null,
	boot: "loading",
	workspaces: [],
	workspacesLoaded: false,
	workspacesError: null,
	activeWorkspaceId: null,
	sessionsByWorkspace: {},
	sessionsLoading: {},
	sessionsError: {},
	sessionRecords: {},
	sessionStates: {},
	tabs: [],
	activeSessionId: null,
	drafts: {},
	sending: {},
	resyncing: {},
	layout: DEFAULT_LAYOUT,
	theme: "system",
	notices: [],
	settings: { open: false },
	modelPickerOpen: false,
	paletteOpen: false,
	paletteMode: "all",
	locale: "pt-BR",
	restoringTabs: false,
	unreadSessions: [],
	composerFocusNonce: 0,
	rightPanelRequest: 0,
};

export function activeWorkspace(state: AppState): WorkspaceDto | null {
	if (!state.activeWorkspaceId) return null;
	return state.workspaces.find((workspace) => workspace.workspaceId === state.activeWorkspaceId) ?? null;
}

/** Rótulo local quando o OMP não informa título: nome do arquivo de sessão ou id curto. */
export function fallbackSessionTitle(sessionPath: string | undefined, sessionId?: string): string {
	const base = sessionPath?.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, "").trim();
	if (base) return base;
	if (sessionId) return sessionId.slice(0, 12);
	// Sem caminho nem id: rótulo neutro (a interface não traduz isto por sessão).
	return "—";
}

/** Trabalho que não deve ser interrompido por fechar a aba sem confirmação. */
export function sessionHasActiveWork(view: SessionViewState | null): boolean {
	if (!view) return false;
	return (
		view.status === "busy" ||
		view.status === "starting" ||
		view.meta?.isStreaming === true ||
		view.meta?.isCompacting === true ||
		view.meta?.hasPendingAsyncWork === true
	);
}

export function clampLayout(layout: Partial<LayoutState> & Record<string, unknown>): LayoutState {
	const number = (value: unknown, fallback: number, min: number, max: number): number => {
		if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
		return Math.min(max, Math.max(min, Math.round(value)));
	};
	return {
		sidebarWidth: number(layout.sidebarWidth, DEFAULT_LAYOUT.sidebarWidth, 200, 380),
		rightWidth: number(layout.rightWidth, DEFAULT_LAYOUT.rightWidth, 280, 520),
		terminalHeight: number(layout.terminalHeight, DEFAULT_LAYOUT.terminalHeight, 140, 620),
		rightTab: layout.rightTab === "changes" ? "changes" : "agents",
		terminalOpen: layout.terminalOpen === true,
		rightOpen: layout.rightOpen !== false,
		sidebarOpen: layout.sidebarOpen !== false,
	};
}
