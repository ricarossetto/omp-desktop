import { useState } from "react";
import type { WorkspaceDto } from "@shared/contracts";
import { Banner } from "../../components/Banners";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { formatRelative } from "../../format";
import { useI18n, useT } from "../../i18n";
import { useActions, useStore } from "../../store/context";
import { activeWorkspace } from "../../store/state";
import { BrandMark } from "../../layout/TitleBar";
import "./workspaces.css";

export function StartScreen() {
	const t = useT();
	const { locale } = useI18n();
	const actions = useActions();
	const workspaces = useStore((state) => state.workspaces);
	const loaded = useStore((state) => state.workspacesLoaded);
	const error = useStore((state) => state.workspacesError);
	const runtime = useStore((state) => state.runtime);
	const current = useStore((state) => activeWorkspace(state));
	const [removeTarget, setRemoveTarget] = useState<WorkspaceDto | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [removing, setRemoving] = useState(false);

	const relocate = async (workspace: WorkspaceDto) => {
		setBusyId(workspace.workspaceId);
		await actions.relocateWorkspace(workspace.workspaceId);
		setBusyId(null);
	};

	const remove = async () => {
		if (!removeTarget) return;
		setRemoving(true);
		await actions.removeWorkspace(removeTarget.workspaceId);
		setRemoving(false);
		setRemoveTarget(null);
	};

	return (
		<div className="start">
			<div className="start__inner">
				<header className="start-hero">
					<BrandMark size={48} />
					<div>
						<h1>{t("start.heroTitle")}</h1>
						<p>{t("start.heroSubtitle")}</p>
					</div>
				</header>

				{current && !current.available ? (
					<Banner level="warning" title={t("start.unavailableTitle")}>
						{t("start.unavailableBody", { path: current.path })}
					</Banner>
				) : null}
				{error ? (
					<Banner level="error" title={t("start.listErrorTitle")}>
						{error}
					</Banner>
				) : null}

				<button type="button" className="start-card start-card--primary" onClick={() => void actions.pickWorkspace()}>
					<span className="start-card__icon">
						<Icon name="folder-open" size={20} />
					</span>
					<span className="start-card__title">{t("start.openFolder")}</span>
					<span className="start-card__desc">{t("start.openFolderDesc")}</span>
					<kbd className="start-card__key">Ctrl+Shift+P</kbd>
				</button>

				<div className="start-cols">
					<section className="start-box" aria-labelledby="start-recent-title">
						<div className="start-box__head">
							<h2 id="start-recent-title">{t("start.recentTitle")}</h2>
							<button type="button" className="btn btn--sm btn--ghost" onClick={() => void actions.loadWorkspaces()}>
								<Icon name="refresh" className="icon--sm" /> {t("common.refresh")}
							</button>
						</div>
						{!loaded ? (
							<div className="start__list">
								<div className="skeleton" style={{ height: 36 }} />
								<div className="skeleton" style={{ height: 36 }} />
							</div>
						) : workspaces.length === 0 && !error ? (
							<p className="start-box__empty">{t("start.empty")}</p>
						) : (
							<ul className="start-recents">
								{workspaces.map((workspace) => (
									<li key={workspace.workspaceId} className={workspace.available ? undefined : "is-unavailable"}>
										<button
											type="button"
											className="start-recents__main"
											disabled={!workspace.available || busyId === workspace.workspaceId}
											title={workspace.path}
											onClick={() => void actions.openWorkspace(workspace.workspaceId)}
										>
											<Icon name="folder" className="icon--sm" />
											<span className="start-recents__name">{workspace.name}</span>
											<span className="start-recents__meta">
												{workspace.available
													? formatRelative(workspace.lastOpenedAt, locale)
													: t("common.unavailable")}
											</span>
										</button>
										{!workspace.available ? (
											<button
												type="button"
												className="btn btn--sm"
												disabled={busyId === workspace.workspaceId}
												onClick={() => void relocate(workspace)}
											>
												{t("sidebar.relocate")}
											</button>
										) : null}
										<button
											type="button"
											className="icon-btn start-recents__remove"
											aria-label={t("start.removeAria", { name: workspace.name })}
											title={t("start.removeTitle")}
											onClick={() => setRemoveTarget(workspace)}
										>
											<Icon name="close" className="icon--sm" />
										</button>
									</li>
								))}
							</ul>
						)}
					</section>

					<section className="start-box" aria-labelledby="start-env-title">
						<div className="start-box__head">
							<h2 id="start-env-title">{t("start.checksTitle")}</h2>
						</div>
						<ul className="start-checks">
							<li>
								<span className={runtime?.ompPath ? "is-ok" : "is-warn"}>
									<Icon name={runtime?.ompPath ? "check" : "warning"} className="icon--sm" />
								</span>
								<span>
									OMP {runtime?.ompVersion ? <span className="muted">{runtime.ompVersion}</span> : null}
								</span>
							</li>
							<li>
								<span className={runtime?.gitVersion ? "is-ok" : "is-warn"}>
									<Icon name={runtime?.gitVersion ? "check" : "warning"} className="icon--sm" />
								</span>
								<span>{runtime?.gitVersion ? "Git" : t("start.gitMissing")}</span>
							</li>
							<li>
								<span className={workspaces.length > 0 ? "is-ok" : "is-todo"}>
									<Icon name={workspaces.length > 0 ? "check" : "plus"} className="icon--sm" />
								</span>
								<span>{t("start.openFirst")}</span>
							</li>
						</ul>
					</section>
				</div>

				<div className="start-shortcuts">
					<span>
						{t("palette.title")} <kbd>Ctrl+K</kbd>
					</span>
					<span>
						{t("start.modelShortcut")} <kbd>Ctrl+M</kbd>
					</span>
					<span>
						{t("terminal.title")} <kbd>Ctrl+`</kbd>
					</span>
					<span>
						{t("start.sidebarShortcut")} <kbd>Ctrl+B</kbd>
					</span>
				</div>
			</div>

			{removeTarget ? (
				<ConfirmDialog
					title={t("start.removeConfirmTitle")}
					confirmLabel={t("start.removeConfirm")}
					busy={removing}
					onCancel={() => setRemoveTarget(null)}
					onConfirm={() => void remove()}
				>
					<p>{t("start.removeConfirmBody", { path: removeTarget.path })}</p>
				</ConfirmDialog>
			) : null}
		</div>
	);
}
