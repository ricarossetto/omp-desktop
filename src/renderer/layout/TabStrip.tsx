import { useState } from "react";
import { Icon } from "../components/Icon";
import { useT } from "../i18n";
import { useActions, useStore } from "../store/context";
import { fallbackSessionTitle, sessionHasActiveWork } from "../store/state";
import "./tab-strip.css";

const TAB_COLORS = ["#7698fd", "#f26cb2", "#49c970", "#f6c251", "#8271f8", "#00c5df"];

/** Cor estável por projeto, como os chips de aba do OpenCode. */
function workspaceColor(id: string): string {
	let hash = 0;
	for (let index = 0; index < id.length; index += 1) {
		hash = (hash * 31 + id.charCodeAt(index)) | 0;
	}
	return TAB_COLORS[Math.abs(hash) % TAB_COLORS.length] ?? TAB_COLORS[0];
}

/**
 * Barra de abas horizontal: uma aba por sessão aberta, com reordenação por
 * arrasto, indicador de trabalho, fechar com confirmação e nova sessão.
 * No layout vertical as abas ficam na barra lateral (aqui não renderiza).
 */
export function TabStrip() {
	const t = useT();
	const actions = useActions();
	const tabs = useStore((state) => state.tabs);
	const records = useStore((state) => state.sessionRecords);
	const states = useStore((state) => state.sessionStates);
	const activeSessionId = useStore((state) => state.activeSessionId);
	const activeWorkspaceId = useStore((state) => state.activeWorkspaceId);
	const workspaces = useStore((state) => state.workspaces);
	const tabLayout = useStore((state) => state.tabLayout);
	const [dragId, setDragId] = useState<string | null>(null);

	if (tabLayout === "vertical" || tabs.length === 0) return null;

	const workspaceName = (id: string): string =>
		workspaces.find((workspace) => workspace.workspaceId === id)?.name ?? "";

	return (
		<div className="tab-strip" role="tablist" aria-label={t("tab.listLabel")}>
			<div className="tab-strip__scroll">
				{tabs.map((sessionId, index) => {
					const record = records[sessionId];
					if (!record) return null;
					const view = states[sessionId];
					const busy = view ? sessionHasActiveWork(view) : false;
					const active = sessionId === activeSessionId;
					const title =
						record.title?.trim() ||
						fallbackSessionTitle(record.sessionPath, sessionId);
					return (
						<div
							key={sessionId}
							role="presentation"
							className={`tab-strip__item${active ? " is-active" : ""}${
								dragId === sessionId ? " is-dragging" : ""
							}`}
							draggable
							onDragStart={(event) => {
								setDragId(sessionId);
								event.dataTransfer.effectAllowed = "move";
								event.dataTransfer.setData("text/plain", sessionId);
							}}
							onDragEnd={() => setDragId(null)}
							onDragOver={(event) => {
								event.preventDefault();
								event.dataTransfer.dropEffect = "move";
							}}
							onDrop={(event) => {
								event.preventDefault();
								const source =
									event.dataTransfer.getData("text/plain") || dragId;
								if (source) actions.moveTab(source, index);
								setDragId(null);
							}}
						>
							<button
								type="button"
								id={`omp-tab-${sessionId}`}
								role="tab"
								aria-selected={active}
								aria-controls="omp-conversation-panel"
								className="tab-strip__main"
								title={`${workspaceName(record.workspaceId)} · ${title}`}
								onClick={() => actions.activateSession(sessionId)}
							>
								<span
									className="tab-strip__dot"
									style={{ background: workspaceColor(record.workspaceId) }}
									aria-hidden="true"
								/>
								<span className="tab-strip__title truncate">{title}</span>
								{busy ? (
									<span className="tab-strip__busy" title={t("tab.busy")} />
								) : null}
							</button>
							<button
								type="button"
								className="tab-strip__close"
								aria-label={t("tab.close", { title })}
								title={t("tab.close", { title })}
								onClick={(event) => {
									event.stopPropagation();
									actions.requestCloseSession(sessionId);
								}}
							>
								<Icon name="close" className="icon--sm" />
							</button>
						</div>
					);
				})}
			</div>
			<button
				type="button"
				className="tab-strip__new"
				aria-label={t("tab.new")}
				title={t("tab.new")}
				disabled={!activeWorkspaceId}
				onClick={() => {
					if (activeWorkspaceId) void actions.createSession(activeWorkspaceId);
				}}
			>
				<Icon name="plus" className="icon--sm" />
			</button>
		</div>
	);
}
