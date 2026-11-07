import { useEffect, useState, type KeyboardEvent } from "react";
import type { GitStatusResult } from "@shared/contracts";
import type { SessionViewState } from "@shared/session-types";
import { invoke } from "../api";
import { Icon } from "../components/Icon";
import { EmptyState } from "../components/Banners";
import { useT } from "../i18n";
import { useActions, useStore } from "../store/context";
import { AgentsPanel } from "../features/agents/AgentsPanel";
import { ChangesPanel } from "../features/changes/ChangesPanel";
import { cycleTab } from "./layout-policy";

const RIGHT_TABS = ["agents", "changes"] as const;
type RightTab = (typeof RIGHT_TABS)[number];

export function RightPanel({ drawer = false, onClose }: { drawer?: boolean; onClose?: () => void }) {
	const t = useT();
	const actions = useActions();
	const tab = useStore((state) => state.layout.rightTab);
	const workspaceId = useStore((state) => state.activeWorkspaceId);
	const view = useStore((state) =>
		state.activeSessionId ? (state.sessionStates[state.activeSessionId] ?? null) : null,
	);
	const agentCount = useStore((state) => {
		const current: SessionViewState | null = state.activeSessionId
			? (state.sessionStates[state.activeSessionId] ?? null)
			: null;
		return current ? current.agents.length : 0;
	});
	const [changedFiles, setChangedFiles] = useState<number | null>(null);
	useEffect(() => {
		if (!workspaceId) {
			setChangedFiles(null);
			return;
		}
		let cancelled = false;
		const load = () =>
			invoke<GitStatusResult>({ op: "git.status", workspaceId })
				.then((result) => {
					if (!cancelled) setChangedFiles(result.isRepo ? result.files.length : null);
				})
				.catch(() => {
					if (!cancelled) setChangedFiles(null);
				});
		void load();
		const timer = setInterval(() => void load(), 15000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [workspaceId, tab]);

	const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement | null;
		if (target?.getAttribute("role") !== "tab") return;
		const next = cycleTab<RightTab>(RIGHT_TABS, tab, event.key);
		if (!next) return;
		event.preventDefault();
		actions.setRightTab(next);
		document.getElementById(`right-panel-tab-${next}`)?.focus();
	};

	return (
		<aside className={`right-panel${drawer ? " right-panel--drawer" : ""}`} aria-label={t("shell.rightPanelLabel")}>
			<div className="right-panel__tabs" role="tablist" aria-label={t("shell.panels")} onKeyDown={onTabKeyDown}>
				<button
					id="right-panel-tab-agents"
					type="button"
					role="tab"
					aria-selected={tab === "agents"}
					aria-controls="right-panel-panel-agents"
					tabIndex={tab === "agents" ? 0 : -1}
					className={`right-panel__tab${tab === "agents" ? " right-panel__tab--active" : ""}`}
					onClick={() => actions.setRightTab("agents")}
				>
					{t("shell.agentsTab")}
					{agentCount > 0 ? <span className="right-panel__count">{agentCount}</span> : null}
				</button>
				<button
					id="right-panel-tab-changes"
					type="button"
					role="tab"
					aria-selected={tab === "changes"}
					aria-controls="right-panel-panel-changes"
					tabIndex={tab === "changes" ? 0 : -1}
					className={`right-panel__tab${tab === "changes" ? " right-panel__tab--active" : ""}`}
					onClick={() => actions.setRightTab("changes")}
				>
					{t("shell.changesTab")}
					{changedFiles ? <span className="right-panel__count">{changedFiles}</span> : null}
				</button>
				{drawer && onClose ? (
					<button type="button" className="icon-btn" aria-label={t("shell.closePanel")} onClick={onClose}>
						<Icon name="close" />
					</button>
				) : null}
			</div>
			<div
				id={`right-panel-panel-${tab}`}
				className="right-panel__body"
				role="tabpanel"
				aria-labelledby={`right-panel-tab-${tab}`}
			>
				{tab === "agents" ? (
					view ? (
						<AgentsPanel state={view} />
					) : (
						<EmptyState icon="agent" title={t("shell.noActiveSession")}>
							<p>{t("shell.noActiveSessionHint")}</p>
						</EmptyState>
					)
				) : workspaceId ? (
					<ChangesPanel workspaceId={workspaceId} />
				) : (
					<EmptyState icon="git" title={t("shell.noProject")} />
				)}
			</div>
		</aside>
	);
}
