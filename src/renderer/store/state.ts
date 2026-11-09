import type { Locale } from "../i18n";
import type { RuntimeStatus, WorkspaceDto, SessionListItem } from "@shared/contracts";
import { DEFAULT_APPROVAL_MODE, isApprovalMode, type ApprovalMode, type SessionViewState } from "@shared/session-types";
import type { ComposerDraft } from "../features/conversation/composer-policy";

export const THEME_MODES = [
	"system",
	"dark",
	"light",
	"aurora",
	"phosphor",
	"daylight",
] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export type DensityMode = "comfortable" | "compact";

export function isThemeMode(value: unknown): value is ThemeMode {
	return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}
export type RightTab = "agents" | "changes";
export type SettingsTab =
	| "models"
	| "accounts"
	| "general"
	| "approvals"
	| "shortcuts"
	| "about";

/** Abas na barra superior ou na barra lateral (mecânica do OpenCode). */
export type TabLayout = "horizontal" | "vertical";
/** Largura da coluna de conversa: 488 / 744 / 1000 px. */
export type TimelineWidth = "focused" | "comfortable" | "wide";
/** Preferência de movimento; `system` segue o Windows. */
export type ReduceMotion = "system" | "on" | "off";

export function normalizeTabLayout(value: unknown): TabLayout {
	return value === "vertical" ? "vertical" : "horizontal";
}

export function normalizeTimelineWidth(value: unknown): TimelineWidth {
	return value === "focused" || value === "wide" ? value : "comfortable";
}

export function normalizeReduceMotion(value: unknown): ReduceMotion {
	return value === "on" || value === "off" ? value : "system";
}

/** Padrão global + override por projeto do `--approval-mode` do OMP. */
export interface ApprovalSettings {
	default: ApprovalMode;
	projects: Record<string, ApprovalMode>;
}

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
	/** Modo com que o processo atual foi iniciado; ausente = ainda não abriu. */
	approvalMode?: ApprovalMode;
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
	/** Sessão aguardando confirmação de fechamento (aba/atalho). */
	closingSessionId: string | null;

	drafts: Record<string, ComposerDraft>;
	/** Prompts já enviados por sessão, do mais novo para o mais antigo. */
	promptHistory: Record<string, string[]>;
	/** Envio de prompt em andamento (desabilita novo envio). */
	sending: Record<string, boolean>;
	/** Sessões aguardando snapshot de ressincronização. */
	resyncing: Record<string, boolean>;

	layout: LayoutState;
	theme: ThemeMode;
	/** Cor de acento personalizada; null usa a do tema. */
	accent: string | null;
	density: DensityMode;
	/** Escala global da interface (zoom do webContents). */
	fontScale: number;
	tabLayout: TabLayout;
	timelineWidth: TimelineWidth;
	reduceMotion: ReduceMotion;
	approval: ApprovalSettings;
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
	/** Arquivo aberto no preview embutido. */
	filePreview: { workspaceId: string; path: string } | null;
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
	closingSessionId: null,
	drafts: {},
	promptHistory: {},
	sending: {},
	resyncing: {},
	layout: DEFAULT_LAYOUT,
	theme: "system",
	accent: null,
	density: "comfortable",
	fontScale: 1,
	tabLayout: "horizontal",
	timelineWidth: "comfortable",
	reduceMotion: "system",
	approval: { default: DEFAULT_APPROVAL_MODE, projects: {} },
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
	filePreview: null,
};

export const FONT_SCALES = [0.9, 1, 1.1, 1.25] as const;

export function normalizeAccent(value: unknown): string | null {
	return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

export function normalizeDensity(value: unknown): DensityMode {
	return value === "compact" ? "compact" : "comfortable";
}

export function normalizeFontScale(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0.5 && value <= 2
		? value
		: 1;
}

/** Valida o que veio do `ui-state`; valor inválido cai no padrão. */
export function normalizeApprovalSettings(value: unknown): ApprovalSettings {
	if (!value || typeof value !== "object") {
		return { default: DEFAULT_APPROVAL_MODE, projects: {} };
	}
	const record = value as Record<string, unknown>;
	const projects: Record<string, ApprovalMode> = {};
	if (record.projects && typeof record.projects === "object") {
		for (const [workspaceId, mode] of Object.entries(record.projects)) {
			if (isApprovalMode(mode)) projects[workspaceId] = mode;
		}
	}
	return {
		default: isApprovalMode(record.default) ? record.default : DEFAULT_APPROVAL_MODE,
		projects,
	};
}

/** Modo efetivo do projeto, ou o padrão global quando não há override. */
export function resolveApprovalMode(
	state: Pick<AppState, "approval">,
	workspaceId: string | null | undefined,
): ApprovalMode {
	if (workspaceId) {
		const override = state.approval.projects[workspaceId];
		if (override) return override;
	}
	return state.approval.default;
}

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
