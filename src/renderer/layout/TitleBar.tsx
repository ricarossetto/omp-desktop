import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { useActions, useStore } from "../store/context";
import { activeWorkspace, fallbackSessionTitle } from "../store/state";
import { isEditableTarget } from "./layout-policy";
import { useMediaQuery } from "./use-media-query";

/**
 * Barra de título própria (janela com `titleBarStyle: "hidden"`).
 * Toda a faixa arrasta a janela; só os botões ficam fora da área de arrasto.
 * Minimizar, maximizar e fechar são desenhados pelo Windows à direita (overlay).
 */
export function BrandMark({ size = 18 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="brand-logo">
			<path d="M19.88 10.61A8 8 0 1 1 13.39 4.12" fill="none" stroke="var(--text)" strokeWidth="3.2" />
			<rect x="16.2" y="2.2" width="5" height="7.2" rx="0.6" fill="var(--accent)" />
		</svg>
	);
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function Glyph({ name }: { name: "side" | "back" | "fwd" | "search" | "sun" | "moon" | "term" | "panel" }) {
	switch (name) {
		case "side":
			return (
				<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
					<rect x="2" y="3" width="12" height="10" rx="1" {...stroke} />
					<path d="M6 3v10" {...stroke} />
				</svg>
			);
		case "back":
			return (
				<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
					<path d="M9 3L5 7l4 4" {...stroke} strokeWidth={1.4} />
				</svg>
			);
		case "fwd":
			return (
				<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
					<path d="M5 3l4 4-4 4" {...stroke} strokeWidth={1.4} />
				</svg>
			);
		case "search":
			return (
				<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
					<circle cx="6" cy="6" r="4" {...stroke} />
					<path d="M9 9l3.5 3.5" {...stroke} />
				</svg>
			);
		case "sun":
			return (
				<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
					<circle cx="8" cy="8" r="3" {...stroke} />
					<path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" {...stroke} />
				</svg>
			);
		case "moon":
			return (
				<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
					<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" {...stroke} />
				</svg>
			);
		case "term":
			return (
				<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
					<rect x="2" y="3" width="12" height="10" rx="1" {...stroke} />
					<path d="M2 10h12" {...stroke} />
				</svg>
			);
		default:
			return (
				<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
					<rect x="2" y="3" width="12" height="10" rx="1" {...stroke} />
					<path d="M10 3v10" {...stroke} />
				</svg>
			);
	}
}

function isDarkNow(theme: string): boolean {
	if (theme === "dark" || theme === "aurora" || theme === "phosphor") return true;
	if (theme === "light" || theme === "daylight") return false;
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Histórico de sessões visitadas, para Voltar e Avançar. */
function useSessionHistory(activeSessionId: string | null, tabs: string[]) {
	const [history, setHistory] = useState<{ list: string[]; index: number }>({ list: [], index: -1 });
	const navigating = useRef(false);

	useEffect(() => {
		if (!activeSessionId) return;
		if (navigating.current) {
			navigating.current = false;
			return;
		}
		setHistory((current) => {
			if (current.list[current.index] === activeSessionId) return current;
			const list = [...current.list.slice(0, current.index + 1), activeSessionId].slice(-50);
			return { list, index: list.length - 1 };
		});
	}, [activeSessionId]);

	// Sessões fechadas saem do histórico.
	useEffect(() => {
		setHistory((current) => {
			const list = current.list.filter((id) => tabs.includes(id));
			if (list.length === current.list.length) return current;
			const active = activeSessionId ? list.lastIndexOf(activeSessionId) : -1;
			return { list, index: active >= 0 ? active : list.length - 1 };
		});
	}, [tabs, activeSessionId]);

	const go = (delta: -1 | 1): string | null => {
		const nextIndex = history.index + delta;
		const target = history.list[nextIndex];
		if (!target) return null;
		navigating.current = true;
		setHistory({ list: history.list, index: nextIndex });
		return target;
	};

	return {
		canBack: history.index > 0,
		canForward: history.index >= 0 && history.index < history.list.length - 1,
		go,
	};
}

export function TitleBar() {
	const t = useT();
	const actions = useActions();
	const theme = useStore((state) => state.theme);
	const workspace = useStore((state) => activeWorkspace(state));
	const activeSessionId = useStore((state) => state.activeSessionId);
	const tabs = useStore((state) => state.tabs);
	const layout = useStore((state) => state.layout);
	const restoringTabs = useStore((state) => state.restoringTabs);
	const sessionTitle = useStore((state) => {
		const id = state.activeSessionId;
		if (!id) return null;
		const record = state.sessionRecords[id];
		const listed = state.activeWorkspaceId
			? (state.sessionsByWorkspace[state.activeWorkspaceId] ?? []).find((entry) => entry.openSessionId === id)?.title
			: undefined;
		return listed?.trim() || record?.title?.trim() || fallbackSessionTitle(record?.sessionPath, id);
	});
	const narrow = useMediaQuery("(max-width: 1000px)");
	const inShell = Boolean(workspace?.available);
	const dark = isDarkNow(theme);
	const history = useSessionHistory(activeSessionId, tabs);

	const navigate = (delta: -1 | 1) => {
		const target = history.go(delta);
		if (target) actions.activateSession(target);
	};

	// Alt+←/→ percorre o mesmo histórico dos botões Voltar/Avançar.
	useEffect(() => {
		if (!inShell) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			if (event.defaultPrevented || isEditableTarget(event.target)) return;
			event.preventDefault();
			const target = history.go(event.key === "ArrowLeft" ? -1 : 1);
			if (target) actions.activateSession(target);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [actions, history, inShell]);

	const rightPressed = narrow ? false : layout.rightOpen;

	return (
		<div className="titlebar" role="banner">
			<div className="titlebar__left">
				<span className="titlebar__brand">
					<BrandMark />
					<span className="titlebar__name">
						OMP<span className="titlebar__name-sub">desktop</span>
					</span>
				</span>
				{inShell ? (
					<>
						<button
							type="button"
							className="icon-btn titlebar__btn"
							aria-label={t("shell.toggleSidebar")}
							aria-pressed={layout.sidebarOpen}
							title={t("shell.toggleSidebarTitle")}
							onClick={() => actions.setLayout({ sidebarOpen: !layout.sidebarOpen })}
						>
							<Glyph name="side" />
						</button>
						<button
							type="button"
							className="icon-btn titlebar__btn"
							aria-label={t("shell.back")}
							title={t("shell.backTitle")}
							disabled={!history.canBack}
							onClick={() => navigate(-1)}
						>
							<Glyph name="back" />
						</button>
						<button
							type="button"
							className="icon-btn titlebar__btn"
							aria-label={t("shell.forward")}
							title={t("shell.forwardTitle")}
							disabled={!history.canForward}
							onClick={() => navigate(1)}
						>
							<Glyph name="fwd" />
						</button>
					</>
				) : null}
			</div>

			<div className="titlebar__title" title={workspace?.path}>
				{workspace ? (
					<>
						<span className="titlebar__project truncate" title={workspace.path}>{workspace.name}</span>
						{sessionTitle ? (
							<>
								<span className="titlebar__sep" aria-hidden="true">
									/
								</span>
								<span className="titlebar__session truncate" title={sessionTitle}>{sessionTitle}</span>
							</>
						) : null}
					</>
				) : (
					<span className="titlebar__session">OMP</span>
				)}
				{restoringTabs ? <span className="titlebar__note">{t("shell.restoringTabs")}</span> : null}
			</div>

			<div className="titlebar__actions">
				<button
					type="button"
					className="icon-btn titlebar__btn"
					aria-label={t("palette.title")}
					title={t("palette.openTitle")}
					onClick={() => actions.setPaletteOpen(true)}
				>
					<Glyph name="search" />
				</button>
				<button
					type="button"
					className="icon-btn titlebar__btn"
					aria-label={t("shell.toggleTheme")}
					title={dark ? t("shell.useLightTheme") : t("shell.useDarkTheme")}
					onClick={() => actions.setTheme(dark ? "light" : "dark")}
				>
					<Glyph name={dark ? "sun" : "moon"} />
				</button>
				{inShell ? (
					<>
						<button
							type="button"
							className={`icon-btn titlebar__btn${layout.terminalOpen ? " icon-btn--active" : ""}`}
							aria-label={t("shell.toggleTerminal")}
							aria-pressed={layout.terminalOpen}
							title={t("shell.terminalTitle")}
							onClick={() => actions.toggleTerminal()}
						>
							<Glyph name="term" />
						</button>
						<button
							type="button"
							className={`icon-btn titlebar__btn${rightPressed ? " icon-btn--active" : ""}`}
							aria-label={t("shell.toggleRightPanel")}
							aria-pressed={rightPressed}
							title={t("shell.rightPanelTitle")}
							onClick={() => (narrow ? actions.showRightPanel(layout.rightTab) : actions.toggleRightPanel())}
						>
							<Glyph name="panel" />
						</button>
					</>
				) : null}
			</div>
		</div>
	);
}
