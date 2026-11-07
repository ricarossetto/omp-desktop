import { useEffect, useMemo, useRef, useState } from "react";
import type { GitStatusResult, SessionListItem, WorkspaceDto } from "@shared/contracts";
import { invoke } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Icon } from "../components/Icon";
import { useT } from "../i18n";
import { useActions, useStore } from "../store/context";
import { fallbackSessionTitle, sessionHasActiveWork, type AppState } from "../store/state";

const EMPTY_SESSIONS: SessionListItem[] = [];

/** Assinatura curta das sessões abertas: `id:b` trabalhando, `id:dN` com N aprovações. */
function workspaceSignature(state: AppState): string {
	return state.tabs
		.map((sessionId) => {
			const view = state.sessionStates[sessionId];
			if (!view) return "";
			const busy =
				view.meta?.isStreaming === true ||
				(view.meta ? !view.meta.isSettled : false) ||
				view.meta?.hasPendingAsyncWork === true;
			const dialogs = view.pendingDialogs.length;
			if (!busy && dialogs === 0) return "";
			return `${sessionId}:${busy ? "b" : ""}${dialogs > 0 ? `d${dialogs}` : ""}`;
		})
		.filter(Boolean)
		.join("|");
}

/* Ícones da navegação: 16px, traço 1,4, pontas arredondadas (mesma regra do mock). */
function NavIcon({ name }: { name: "plus" | "search" | "skills" | "gear" | "sidebar" }) {
	const common = { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": true as const };
	const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
	if (name === "plus") return <svg {...common}><path d="M8 3v10M3 8h10" {...stroke} /></svg>;
	if (name === "search")
		return (
			<svg {...common}>
				<circle cx="7" cy="7" r="4.25" {...stroke} />
				<path d="M10.2 10.2L13 13" {...stroke} />
			</svg>
		);
	if (name === "skills")
		return (
			<svg {...common}>
				<rect x="2.75" y="2.75" width="4.5" height="4.5" rx="1" {...stroke} />
				<rect x="8.75" y="2.75" width="4.5" height="4.5" rx="1" {...stroke} />
				<rect x="2.75" y="8.75" width="4.5" height="4.5" rx="1" {...stroke} />
				<path d="M11 9v4M9 11h4" {...stroke} />
			</svg>
		);
	if (name === "sidebar")
		return (
			<svg {...common}>
				<rect x="2" y="3" width="12" height="10" rx="1" {...stroke} />
				<path d="M6 3v10" {...stroke} />
			</svg>
		);
	return (
		<svg {...common}>
			<path
				d="M6.9 1.8h2.2l.3 1.6 1.2.5 1.3-.9 1.6 1.6-.9 1.3.5 1.2 1.6.3v2.2l-1.6.3-.5 1.2.9 1.3-1.6 1.6-1.3-.9-1.2.5-.3 1.6H6.9l-.3-1.6-1.2-.5-1.3.9-1.6-1.6.9-1.3-.5-1.2-1.6-.3V6.9l1.6-.3.5-1.2-.9-1.3 1.6-1.6 1.3.9 1.2-.5z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.3"
				strokeLinejoin="round"
			/>
			<circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
		</svg>
	);
}

function FolderIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
			<path d="M1.5 3.5h4l1 1.5h6v6.5h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
		</svg>
	);
}

function BranchIcon() {
	return (
		<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
			<circle cx="2.5" cy="2" r="1.3" fill="none" stroke="currentColor" />
			<circle cx="2.5" cy="8" r="1.3" fill="none" stroke="currentColor" />
			<circle cx="7.5" cy="3.5" r="1.3" fill="none" stroke="currentColor" />
			<path d="M2.5 3.3v3.4M7.5 4.8c0 2-5 1-5 2" fill="none" stroke="currentColor" />
		</svg>
	);
}

interface Row {
	key: string;
	title: string;
	item?: SessionListItem;
	sessionId?: string;
}

function rowsFor(workspaceId: string, sessions: SessionListItem[], state: { tabs: string[]; records: AppState["sessionRecords"] }): Row[] {
	const rows: Row[] = sessions.map((item) => ({
		key: item.path,
		title: item.title?.trim() || item.id,
		item,
		sessionId: item.openSessionId,
	}));
	const listed = new Set(rows.map((row) => row.sessionId).filter(Boolean));
	// Sessões abertas que a lista ainda não trouxe (recém-criadas) também aparecem.
	for (const sessionId of state.tabs) {
		const record = state.records[sessionId];
		if (!record || record.workspaceId !== workspaceId || listed.has(sessionId)) continue;
		rows.unshift({
			key: `open:${sessionId}`,
			title: record.title?.trim() || fallbackSessionTitle(record.sessionPath, sessionId),
			sessionId,
		});
	}
	return rows;
}

export function SidebarRail() {
	const t = useT();
	const actions = useActions();
	const workspaceId = useStore((state) => state.activeWorkspaceId);
	return (
		<nav className="rail" aria-label={t("sidebar.railLabel")}>
			<button
				type="button"
				className="icon-btn"
				aria-label={t("sidebar.expand")}
				title={t("sidebar.expandTitle")}
				onClick={() => actions.setLayout({ sidebarOpen: true })}
			>
				<NavIcon name="sidebar" />
			</button>
			<button
				type="button"
				className="icon-btn"
				aria-label={t("sidebar.newSession")}
				title={t("sidebar.newSessionTitle")}
				disabled={!workspaceId}
				onClick={() => void actions.createSession(workspaceId ?? undefined)}
			>
				<NavIcon name="plus" />
			</button>
			<button
				type="button"
				className="icon-btn"
				aria-label={t("common.search")}
				title={t("sidebar.searchTitle")}
				onClick={() => actions.setPaletteOpen(true)}
			>
				<NavIcon name="search" />
			</button>
			<span className="rail__spacer" />
			<button
				type="button"
				className="icon-btn"
				aria-label={t("sidebar.settings")}
				title={t("sidebar.settings")}
				onClick={() => actions.openSettings()}
			>
				<NavIcon name="gear" />
			</button>
		</nav>
	);
}

export function Sidebar({ width }: { width?: number } = {}) {
	const t = useT();
	const actions = useActions();
	const workspaces = useStore((state) => state.workspaces);
	const activeWorkspaceId = useStore((state) => state.activeWorkspaceId);
	const activeSessionId = useStore((state) => state.activeSessionId);
	const layout = useStore((state) => state.layout);
	const sessionsByWorkspace = useStore((state) => state.sessionsByWorkspace);
	const sessionsLoading = useStore((state) => state.sessionsLoading);
	const sessionsError = useStore((state) => state.sessionsError);
	const tabs = useStore((state) => state.tabs);
	const records = useStore((state) => state.sessionRecords);
	const tabSignature = useStore(workspaceSignature);
	const persistedUnread = useStore((state) => state.unreadSessions);

	const { running, awaiting } = useMemo(() => {
		const busy = new Set<string>();
		const dialogs = new Set<string>();
		for (const entry of tabSignature.split("|")) {
			if (!entry) continue;
			const [sessionId, flags = ""] = entry.split(":");
			if (!sessionId) continue;
			if (flags.includes("b")) busy.add(sessionId);
			if (flags.includes("d")) dialogs.add(sessionId);
		}
		return { running: busy, awaiting: dialogs };
	}, [tabSignature]);

	// Sessão que terminou enquanto você olhava outra fica marcada como "Nova" até ser aberta.
	const previousRunning = useRef<Set<string>>(new Set());
	// "Nova" sobrevive ao reinício: carrega do estado persistido (ui.getState → state.unreadSessions).
	const [unread, setUnread] = useState<Set<string>>(() => new Set(persistedUnread));
	// Sincroniza mudanças locais para o estado persistido (e a sidebar de trilho reusa).
	useEffect(() => {
		const finished = [...previousRunning.current].filter((id) => !running.has(id) && id !== activeSessionId);
		previousRunning.current = running;
		if (finished.length === 0) return;
		setUnread((current) => new Set([...current, ...finished]));
	}, [activeSessionId, running]);
	useEffect(() => {
		void actions.setUnreadSessions([...unread]);
	}, [actions, unread]);
	useEffect(() => {
		if (!activeSessionId) return;
		setUnread((current) => {
			if (!current.has(activeSessionId)) return current;
			const next = new Set(current);
			next.delete(activeSessionId);
			return next;
		});
	}, [activeSessionId]);

	// Projetos abertos na árvore. O ativo começa aberto.
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeWorkspaceId ? [activeWorkspaceId] : []));
	useEffect(() => {
		if (!activeWorkspaceId) return;
		setExpanded((current) => (current.has(activeWorkspaceId) ? current : new Set([...current, activeWorkspaceId])));
	}, [activeWorkspaceId]);

	const toggleExpanded = (workspace: WorkspaceDto) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(workspace.workspaceId)) next.delete(workspace.workspaceId);
			else {
				next.add(workspace.workspaceId);
				if (!sessionsByWorkspace[workspace.workspaceId] && workspace.available) {
					void actions.loadSessions(workspace.workspaceId);
				}
			}
			return next;
		});
	};

	// Branch e arquivos alterados do projeto ativo.
	const [git, setGit] = useState<GitStatusResult | null>(null);
	useEffect(() => {
		if (!activeWorkspaceId) {
			setGit(null);
			return;
		}
		let cancelled = false;
		const load = () =>
			invoke<GitStatusResult>({ op: "git.status", workspaceId: activeWorkspaceId })
				.then((result) => {
					if (!cancelled) setGit(result);
				})
				.catch(() => {
					if (!cancelled) setGit(null);
				});
		void load();
		const timer = setInterval(() => void load(), 15000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [activeWorkspaceId, tabSignature]);

	const [creating, setCreating] = useState(false);
	const [openingKey, setOpeningKey] = useState<string | null>(null);
	const [closingId, setClosingId] = useState<string | null>(null);
	const [closingBusy, setClosingBusy] = useState(false);
	const closingView = useStore((state) => (closingId ? (state.sessionStates[closingId] ?? null) : null));

	const createSession = async (workspaceId?: string) => {
		if (creating) return;
		const target = workspaceId ?? activeWorkspaceId;
		if (!target) return;
		setCreating(true);
		if (target !== activeWorkspaceId) await actions.openWorkspace(target);
		await actions.createSession(target);
		setCreating(false);
	};

	const openRow = async (workspace: WorkspaceDto, row: Row) => {
		if (row.sessionId) {
			if (workspace.workspaceId !== activeWorkspaceId) await actions.openWorkspace(workspace.workspaceId);
			actions.activateSession(row.sessionId);
			return;
		}
		const item = row.item;
		if (!item) return;
		if (item.locked) {
			actions.notify("warning", t("sidebar.lockedNotice"));
			return;
		}
		setOpeningKey(row.key);
		if (workspace.workspaceId !== activeWorkspaceId) await actions.openWorkspace(workspace.workspaceId);
		await actions.openSession(workspace.workspaceId, item.path);
		setOpeningKey(null);
	};

	const confirmClose = async () => {
		if (!closingId) return;
		setClosingBusy(true);
		const ok = await actions.closeSession(closingId);
		setClosingBusy(false);
		if (ok) setClosingId(null);
	};

	return (
		<aside className="sidebar" style={{ width: width ?? layout.sidebarWidth }} aria-label={t("sidebar.label")}>
			<div className="sidebar__scroll">
				<nav className="sidebar__nav" aria-label={t("sidebar.mainActions")}>
					<button
						type="button"
						className="nav-item"
						title={t("sidebar.newSessionTitle")}
						disabled={!activeWorkspaceId || creating}
						onClick={() => void createSession()}
					>
						<NavIcon name="plus" />
						<span>{t("sidebar.newSession")}</span>
					</button>
					<button
						type="button"
						className="nav-item"
						title={t("sidebar.searchSessionsTitle")}
						onClick={() => actions.setPaletteOpen(true)}
					>
						<NavIcon name="search" />
						<span>{t("common.search")}</span>
					</button>
					<button
						type="button"
						className="nav-item"
						title={t("sidebar.skillsTitle")}
						onClick={() => actions.setPaletteOpen(true, "skills")}
					>
						<NavIcon name="skills" />
						<span>{t("sidebar.skills")}</span>
					</button>
				</nav>

				<div className="tree-head">
					<span>{t("sidebar.projects")}</span>
					<button
						type="button"
						className="icon-btn tree-head__btn"
						aria-label={t("sidebar.openProject")}
						title={t("sidebar.openProjectTitle")}
						onClick={() => void actions.pickWorkspace()}
					>
						<NavIcon name="plus" />
					</button>
				</div>

				<nav className="tree" aria-label={t("sidebar.label")}>
					{workspaces.map((workspace) => {
						const isActive = workspace.workspaceId === activeWorkspaceId;
						const isOpen = expanded.has(workspace.workspaceId);
						const sessions = sessionsByWorkspace[workspace.workspaceId] ?? EMPTY_SESSIONS;
						const rows = rowsFor(workspace.workspaceId, sessions, { tabs, records });
						const loading = sessionsLoading[workspace.workspaceId] === true;
						const error = sessionsError[workspace.workspaceId] ?? null;
						return (
							<div className="tree-proj" key={workspace.workspaceId}>
								<div className={`tree-proj__row${isActive ? " is-active" : ""}`}>
									<button
										type="button"
										className="tree-proj__chev"
										aria-expanded={isOpen}
										aria-label={isOpen ? t("sidebar.collapseProject", { name: workspace.name }) : t("sidebar.expandProject", { name: workspace.name })}
										onClick={() => toggleExpanded(workspace)}
									>
										<Icon name={isOpen ? "chevron-down" : "chevron-right"} className="icon--sm" />
									</button>
									<button
										type="button"
										className="tree-proj__name"
										title={workspace.path}
										onClick={() => {
											if (!isActive) void actions.openWorkspace(workspace.workspaceId);
											if (!isOpen) toggleExpanded(workspace);
										}}
									>
										<FolderIcon />
										<span className="truncate">{workspace.name}</span>
									</button>
									{workspace.available ? (
										<span className="tree-proj__count">{rows.length > 0 ? rows.length : ""}</span>
									) : (
										<button
											type="button"
											className="tree-proj__warn"
											title={t("sidebar.missingFolder")}
											onClick={() => void actions.relocateWorkspace(workspace.workspaceId)}
										>
											<Icon name="warning" className="icon--sm" /> {t("sidebar.relocate")}
										</button>
									)}
								</div>

								{isOpen && isActive && git?.isRepo ? (
									<div className="tree-branch mono" title={git.branch ?? (git.hasHead ? t("sidebar.detachedHead") : t("sidebar.noCommits"))}>
										<BranchIcon />
										<span className="truncate">{git.branch ?? (git.hasHead ? t("sidebar.detachedHead") : t("sidebar.noCommits"))}</span>
										{git.files.length > 0 ? (
											<span className="tree-branch__count">
												· {git.files.length === 1 ? t("sidebar.changedOne") : t("sidebar.changedMany", { count: git.files.length })}
											</span>
										) : null}
									</div>
								) : null}

								{isOpen ? (
									<div className="tree-chats">
										{loading && rows.length === 0 ? <div className="tree-note">{t("sidebar.loadingSessions")}</div> : null}
										{error ? (
											<div className="tree-note tree-note--error" role="alert">
												<Icon name="error" className="icon--sm" /> {error}
											</div>
										) : null}
										{!loading && !error && rows.length === 0 ? (
											<div className="tree-empty">
												<span>{t("sidebar.noSessions")}</span>
												<button type="button" className="btn btn--sm" onClick={() => void createSession(workspace.workspaceId)}>
													<Icon name="plus" className="icon--sm" /> {t("sidebar.createSession")}
												</button>
											</div>
										) : null}
										{rows.map((row) => {
											const current = row.sessionId !== undefined && row.sessionId === activeSessionId;
											const busy = row.sessionId ? running.has(row.sessionId) : false;
											const needsApproval = row.sessionId ? awaiting.has(row.sessionId) : false;
											const isNew = row.sessionId ? unread.has(row.sessionId) && !current : false;
											const lockedElsewhere = row.item?.locked === true && !row.sessionId;
											return (
												<div key={row.key} className={`chat${current ? " is-current" : ""}${isNew ? " is-new" : ""}`}>
													<button
														type="button"
														className="chat__main"
														data-testid="session-row"
														aria-current={current ? "true" : undefined}
														title={row.title}
														onClick={() => void openRow(workspace, row)}
													>
														<span className="chat__title truncate" title={row.title}>{row.title}</span>
														{openingKey === row.key ? (
															<span className="chat__state">{t("sidebar.opening")}</span>
														) : needsApproval ? (
															<span className="chat__state chat__state--warning">
																<Icon name="warning" className="icon--sm" /> {t("sidebar.approve")}
															</span>
														) : busy ? (
															<span className="chat__state chat__state--accent" title={t("sidebar.working")}>
																<span className="ring" aria-hidden="true" />
																{t("sidebar.working")}
															</span>
														) : isNew ? (
															<span className="chat__state chat__state--success">
																<span className="chat__dot" aria-hidden="true" /> {t("sidebar.new")}
															</span>
														) : lockedElsewhere ? (
															<span className="chat__state" title={t("sidebar.inUseTitle")}>
																<Icon name="lock" className="icon--sm" /> {t("sidebar.inUse")}
															</span>
														) : null}
													</button>
													{row.sessionId ? (
														<button
															type="button"
															className="chat__close"
															aria-label={t("sidebar.closeSessionAria", { title: row.title })}
															title={t("sidebar.closeSession")}
															onClick={() => setClosingId(row.sessionId ?? null)}
														>
															<Icon name="close" className="icon--sm" />
														</button>
													) : null}
												</div>
											);
										})}
									</div>
								) : null}
							</div>
						);
					})}
				</nav>
			</div>

			<div className="sidebar__foot">
				<button type="button" className="nav-item" title={t("sidebar.settings")} onClick={() => actions.openSettings()}>
					<NavIcon name="gear" />
					<span>{t("sidebar.settings")}</span>
				</button>
			</div>

			{closingId && sessionHasActiveWork(closingView) ? (
				<ConfirmDialog
					title={t("sidebar.closeBusyTitle")}
					confirmLabel={t("sidebar.closeSession")}
					danger
					busy={closingBusy}
					onCancel={() => setClosingId(null)}
					onConfirm={() => void confirmClose()}
				>
					<p>{t("sidebar.closeBusyBody")}</p>
				</ConfirmDialog>
			) : closingId ? (
				<ConfirmDialog
					title={t("sidebar.closeTitle")}
					confirmLabel={t("common.close")}
					busy={closingBusy}
					onCancel={() => setClosingId(null)}
					onConfirm={() => void confirmClose()}
				>
					<p>{t("sidebar.closeBody")}</p>
				</ConfirmDialog>
			) : null}
		</aside>
	);
}
