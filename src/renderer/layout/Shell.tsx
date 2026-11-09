import { useEffect, useRef, useState } from "react";
import { EmptyState } from "../components/Banners";
import { Icon } from "../components/Icon";
import { useFocusTrap } from "../components/focus-trap";
import { DialogHost } from "../features/dialogs/DialogHost";
import { CommandPalette } from "../features/commands/CommandPalette";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import { ModelPicker } from "../features/settings/ModelPicker";
import { TerminalPanel } from "../features/terminal/TerminalPanel";
import { useActions, useStore } from "../store/context";
import { useT } from "../i18n";
import { activeWorkspace, sessionHasActiveWork } from "../store/state";
import { ConversationView } from "../features/conversation/ConversationView";
import { clampPanelWidths } from "./layout-policy";
import { RightPanel } from "./RightPanel";
import { Sidebar, SidebarRail } from "./Sidebar";
import { Splitter } from "./Splitter";
import { TabStrip } from "./TabStrip";
import { StatusBar } from "./StatusBar";
import { useMediaQuery } from "./use-media-query";
import "./shell.css";

function SettingsModal({
	workspaceId,
	sessionId,
	initialTab,
	onClose,
}: {
	workspaceId: string;
	sessionId?: string;
	initialTab?: "models" | "accounts" | "general" | "approvals" | "shortcuts" | "about";
	onClose: () => void;
}) {
	const view = useStore((state) => (sessionId ? (state.sessionStates[sessionId] ?? null) : null));
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref, true);

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			// Só quem declara Escape próprio (ex.: subdiálogo aninhado) consome a tecla;
			// campos de busca tratam o caso "com texto" e deixam o Esc chegar aqui.
			const target = event.target;
			if (target instanceof HTMLElement && target.closest("[data-omp-escape-local]")) {
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			onClose();
		};
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [onClose]);

	return (
		<div className="overlay overlay--settings">
			<div ref={ref} className="settings-modal" role="dialog" aria-modal="true" aria-label={t("shell.settingsDialog")}>
				<button type="button" className="icon-btn settings-modal__close" aria-label={t("shell.closeSettings")} onClick={onClose}>
					<Icon name="close" />
				</button>
				<div className="settings-modal__content">
					<SettingsScreen
						workspaceId={workspaceId}
						sessionId={sessionId}
						state={view ?? undefined}
						initialTab={initialTab}
					/>
				</div>
			</div>
		</div>
	);
}

export function Shell() {
	const t = useT();
	const actions = useActions();
	const narrow = useMediaQuery("(max-width: 1000px)");
	const layout = useStore((state) => state.layout);
	const workspace = useStore((state) => activeWorkspace(state));
	const activeSessionId = useStore((state) => state.activeSessionId);
	const tabs = useStore((state) => state.tabs);
	const view = useStore((state) =>
		state.activeSessionId ? (state.sessionStates[state.activeSessionId] ?? null) : null,
	);
	const restoringTabs = useStore((state) => state.restoringTabs);
	const settingsOpen = useStore((state) => state.settings.open);
	const settingsTab = useStore((state) => state.settings.initialTab);
	const modelPickerOpen = useStore((state) => state.modelPickerOpen);
	const paletteOpen = useStore((state) => state.paletteOpen);
	const pendingDialogs = useStore((state) =>
		state.activeSessionId ? (state.sessionStates[state.activeSessionId]?.pendingDialogs.length ?? 0) : 0,
	);
	const rightPanelRequest = useStore((state) => state.rightPanelRequest);
	const handledPanelRequest = useRef(0);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

	useEffect(() => {
		const onResize = () => setViewportWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const panelWidths = clampPanelWidths({
		viewportWidth,
		sidebarOpen: layout.sidebarOpen && !narrow,
		rightOpen: layout.rightOpen && !narrow,
		sidebarWidth: layout.sidebarWidth,
		rightWidth: layout.rightWidth,
	});

	useEffect(() => {
		if (narrow) setDrawerOpen(false);
	}, [narrow]);

	useEffect(() => {
		if (rightPanelRequest === 0 || handledPanelRequest.current === rightPanelRequest) return;
		handledPanelRequest.current = rightPanelRequest;
		if (narrow) setDrawerOpen(true);
	}, [narrow, rightPanelRequest]);

	const rightVisible = narrow ? drawerOpen : layout.rightOpen;

	// Em janela estreita a barra lateral é gaveta: ao entrar no modo estreito ela
	// fecha; depois disso o botão/atalho abre e fecha sob demanda.
	const wasNarrow = useRef(narrow);
	useEffect(() => {
		if (narrow && !wasNarrow.current) actions.setLayout({ sidebarOpen: false });
		wasNarrow.current = narrow;
	}, [actions, narrow]);

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.isComposing) return;
			const target = event.target instanceof HTMLElement ? event.target : null;
			const editable =
				!!target &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
			const mod = event.ctrlKey || event.metaKey;

			if (event.key === "Escape") {
				// Diálogos aninhados (ex.: seletor de modelo dentro de Configurações)
				// consomem o Esc; o shell não pode fechar o modal de baixo.
				if (event.defaultPrevented) return;
				if (target?.closest("[data-omp-escape-local]")) return;
				if (paletteOpen) {
					event.preventDefault();
					actions.setPaletteOpen(false);
					return;
				}
				if (modelPickerOpen) {
					event.preventDefault();
					actions.setModelPickerOpen(false);
					return;
				}
				if (settingsOpen) {
					event.preventDefault();
					actions.closeSettings();
					return;
				}
				if (pendingDialogs > 0) return;
				if (editable) return;
				if (narrow && drawerOpen) {
					event.preventDefault();
					setDrawerOpen(false);
					return;
				}
				if (view && sessionHasActiveWork(view)) {
					event.preventDefault();
					void actions.abortAndRestore(view.sessionId);
				}
				return;
			}

			if (
				event.altKey &&
				!mod &&
				!event.shiftKey &&
				(event.key === "ArrowUp" || event.key === "ArrowDown")
			) {
				if (tabs.length < 2) return;
				event.preventDefault();
				const index = activeSessionId ? tabs.indexOf(activeSessionId) : -1;
				const step = event.key === "ArrowDown" ? 1 : -1;
				const next = tabs[(index + step + tabs.length) % tabs.length];
				if (next) actions.activateSession(next);
				return;
			}

			if (!mod || event.altKey) return;
			const key = event.key.toLowerCase();

			if (!event.shiftKey && key === "b") {
				event.preventDefault();
				actions.setLayout({ sidebarOpen: !layout.sidebarOpen });
				return;
			}
			if (!event.shiftKey && key === "k") {
				event.preventDefault();
				actions.setPaletteOpen(!paletteOpen);
				return;
			}
			if (!event.shiftKey && key === "m") {
				event.preventDefault();
				if (activeSessionId) actions.setModelPickerOpen(!modelPickerOpen);
				return;
			}
			if (event.shiftKey && key === "p") {
				event.preventDefault();
				void actions.pickWorkspace();
				return;
			}
			if (!event.shiftKey && (key === "n" || key === "t")) {
				event.preventDefault();
				if (workspace) void actions.createSession(workspace.workspaceId);
				return;
			}
			if (!event.shiftKey && key === "w") {
				event.preventDefault();
				if (settingsOpen || paletteOpen || modelPickerOpen) return;
				if (activeSessionId) actions.requestCloseSession(activeSessionId);
				return;
			}
			if (key === ",") {
				event.preventDefault();
				actions.openSettings();
				return;
			}
			if (key === "`") {
				event.preventDefault();
				actions.toggleTerminal();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [
		actions,
		activeSessionId,
		drawerOpen,
		layout.sidebarOpen,
		modelPickerOpen,
		narrow,
		paletteOpen,
		pendingDialogs,
		settingsOpen,
		tabs,
		view,
		workspace,
	]);

	if (!workspace) {
		return (
			<div className="shell shell--empty">
				<EmptyState icon="folder" title={t("shell.noProject")}>
					<p>{t("shell.noProjectHint")}</p>
				</EmptyState>
			</div>
		);
	}

	return (
		<div className="shell">
			{narrow ? (
				<>
					{/* Em janela estreita a barra lateral vira gaveta: o trilho continua
					    visível e o botão de expandir abre a árvore sobre a conversa. */}
					<SidebarRail />
					{layout.sidebarOpen ? (
						<div className="drawer-layer drawer-layer--left">
							<button
								type="button"
								className="drawer-layer__backdrop"
								aria-label={t("shell.closeSidebar")}
								onClick={() => actions.setLayout({ sidebarOpen: false })}
							/>
							<Sidebar width={panelWidths.sidebar} />
						</div>
					) : null}
				</>
			) : layout.sidebarOpen ? (
				<>
					<Sidebar width={panelWidths.sidebar} />
					<Splitter
						orientation="vertical"
						label={t("shell.sidebarWidth")}
						value={panelWidths.sidebar}
						min={200}
						max={380}
						onChange={(value) => actions.setLayout({ sidebarWidth: value })}
					/>
				</>
			) : (
				<SidebarRail />
			)}

			<div className="shell__main">
				<TabStrip />
				<div className="shell__body">
					<main className="shell__conversation" aria-label={t("shell.conversation")}>
						{restoringTabs && !view ? (
							<div className="conversation conversation--loading" role="status">
								<span className="spinner-static" />
								{t("shell.restoringTabsBody")}
							</div>
						) : view ? (
							<ConversationView view={view} />
						) : (
							<div className="conversation conversation--no-session">
								<EmptyState
									icon="message"
									title={t("shell.noSession")}
									action={
										<button
											type="button"
											className="btn btn--primary"
											onClick={() => void actions.createSession(workspace.workspaceId)}
										>
											<Icon name="plus" className="icon--sm" /> {t("sidebar.newSession")}
										</button>
									}
								>
									<p>{t("shell.noSessionHint")}</p>
								</EmptyState>
							</div>
						)}
					</main>

					{!narrow && layout.rightOpen ? (
						<>
							<Splitter
								orientation="vertical"
								label={t("shell.rightWidth")}
								value={panelWidths.right}
								min={280}
								max={520}
								invert
								onChange={(value) => actions.setLayout({ rightWidth: value })}
							/>
							<div className="right-dock" style={{ width: panelWidths.right }}>
								<RightPanel />
							</div>
						</>
					) : null}
				</div>

				{layout.terminalOpen ? (
					<>
						<Splitter
							orientation="horizontal"
							label={t("shell.terminalHeight")}
							value={layout.terminalHeight}
							min={140}
							max={620}
							invert
							onChange={(value) => actions.setLayout({ terminalHeight: value })}
						/>
						<div className="terminal-dock" style={{ height: layout.terminalHeight }}>
							<TerminalPanel workspaceId={workspace.workspaceId} onClose={() => actions.setLayout({ terminalOpen: false })} />
						</div>
					</>
				) : null}
				<StatusBar />
			</div>

			{narrow && rightVisible ? (
				<div className="drawer-layer">
					<button
						type="button"
						className="drawer-layer__backdrop"
						aria-label={t("shell.closeRightPanel")}
						onClick={() => setDrawerOpen(false)}
					/>
					<RightPanel drawer onClose={() => setDrawerOpen(false)} />
				</div>
			) : null}

			{settingsOpen ? (
				<SettingsModal
					workspaceId={workspace.workspaceId}
					sessionId={activeSessionId ?? undefined}
					initialTab={settingsTab}
					onClose={() => actions.closeSettings()}
				/>
			) : null}

			{modelPickerOpen && activeSessionId ? (
				<ModelPicker
					workspaceId={workspace.workspaceId}
					sessionId={activeSessionId}
					state={view ?? undefined}
					onClose={() => actions.setModelPickerOpen(false)}
				/>
			) : null}

			{paletteOpen ? <CommandPalette /> : null}
			<DialogHost />
		</div>
	);
}
