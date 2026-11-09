import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { RpcCommandInput } from "@shared/contracts";
import type { AgentRow, SessionViewState } from "@shared/session-types";
import { invoke } from "../../api";
import { useI18n, useT, type MessageKey } from "../../i18n";
import { StatusIcon } from "./StatusIcon";
import {
	AGENT_STATUS_ICONS,
	agentStatusLabel,
	formatDurationSeconds,
	formatValue,
	goalStatusLabel,
	mergeTranscript,
	parseTranscriptPage,
	readGoal,
	todoCounts,
	todoStatusIcon,
	todoStatusLabel,
	type GoalView,
	type TranscriptItem,
} from "./transcript";
import { errorText, formatDateTime, unwrapRpcData } from "./ui-utils";
import "./agents.css";

type Notice = { level: "success" | "warning" | "error" | "info"; text: string };

interface TranscriptState {
	items: TranscriptItem[];
	nextByte?: number;
	sessionFile?: string;
	loading: boolean;
	error?: string;
}

const ROLE_KEYS: Record<TranscriptItem["role"], MessageKey> = {
	user: "agents.roleUser",
	assistant: "agents.roleAssistant",
	toolResult: "agents.roleToolResult",
	system: "agents.roleSystem",
	other: "agents.roleOther",
};

function isLiveStatus(status: AgentRow["status"]): boolean {
	return status === "running" || status === "pending";
}

function TranscriptView({ items }: { items: TranscriptItem[] }) {
	const t = useT();
	const { locale } = useI18n();
	return (
		<>
			{items.map(item => (
				<article key={item.key} className={`omp-transcript-item omp-role-${item.role}`}>
					<header className="omp-transcript-role">
						<span>{t(ROLE_KEYS[item.role])}</span>
						{item.timestamp ? (
							<time dateTime={new Date(item.timestamp).toISOString()}>
								{formatDateTime(item.timestamp, locale)}
							</time>
						) : null}
					</header>
					{item.parts.map((part, index) => {
						if (part.kind === "text") {
							return (
								<p key={index} className="omp-transcript-text">
									{part.text}
								</p>
							);
						}
						if (part.kind === "thinking") {
							return (
								<details key={index} className="omp-transcript-thinking">
									<summary>{t("message.thinking")}</summary>
									<pre>{part.text}</pre>
								</details>
							);
						}
						if (part.kind === "toolCall") {
							return (
								<div key={index} className="omp-transcript-tool">
									<span className="omp-transcript-tool-name">
										<StatusIcon kind="info" /> {part.name}
									</span>
									{part.arguments !== undefined ? (
										<details>
											<summary>{t("tool.arguments")}</summary>
											<pre>{formatValue(part.arguments)}</pre>
										</details>
									) : null}
								</div>
							);
						}
						if (part.kind === "toolResult") {
							return (
								<div
									key={index}
									className={`omp-transcript-result${part.isError ? " is-error" : ""}`}
								>
									<span className="omp-transcript-tool-name">
										<StatusIcon kind={part.isError ? "error" : "success"} />
										{part.toolName
											? t("agents.toolResultNamed", { tool: part.toolName })
											: t("agents.toolResult")}
									</span>
									<pre>{part.text || t("agents.noOutput")}</pre>
								</div>
							);
						}
						return (
							<p key={index} className="omp-muted">
								[{part.label}]
							</p>
						);
					})}
				</article>
			))}
		</>
	);
}

function GoalSection({
	goal,
	disabled,
	busy,
	onRun,
}: {
	goal: GoalView | null;
	disabled: boolean;
	busy: boolean;
	onRun: (
		op: "create" | "pause" | "resume" | "drop",
		options?: { objective?: string; tokenBudget?: number },
	) => Promise<boolean>;
}) {
	const t = useT();
	const { locale } = useI18n();
	const [objective, setObjective] = useState("");
	const [budget, setBudget] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const [confirmDrop, setConfirmDrop] = useState(false);

	const submitCreate = async (event: FormEvent) => {
		event.preventDefault();
		const trimmed = objective.trim();
		if (!trimmed) {
			setLocalError(t("agents.objectiveRequired"));
			return;
		}
		let tokenBudget: number | undefined;
		if (budget.trim()) {
			const parsed = Number(budget);
			if (!Number.isSafeInteger(parsed) || parsed <= 0) {
				setLocalError(t("agents.budgetInvalid"));
				return;
			}
			tokenBudget = parsed;
		}
		setLocalError(null);
		const created = await onRun("create", { objective: trimmed, tokenBudget });
		if (created) {
			setObjective("");
			setBudget("");
		}
	};

	const canCreate = !goal || goal.status === "complete" || goal.status === "dropped";

	return (
		<section className="omp-flat-section" aria-labelledby="omp-goal-title">
			<header className="omp-flat-head">
				<h3 id="omp-goal-title">{t("agents.goalTitle")}</h3>
			</header>

			{goal ? (
				<div className="omp-goal-card">
					<p className="omp-goal-objective">{goal.objective}</p>
					<p className="omp-goal-status">
						<StatusIcon
							kind={
								goal.status === "complete"
									? "success"
									: goal.status === "dropped"
										? "aborted"
										: goal.status === "paused"
											? "pending"
											: goal.status === "budget-limited"
												? "warning"
												: "running"
							}
						/>
						<span>{goalStatusLabel(goal.status, locale)}</span>
					</p>
					<dl className="omp-goal-facts">
						<div>
							<dt>{t("agents.tokens")}</dt>
							<dd>
								{goal.tokensUsed !== undefined
									? goal.tokenBudget !== undefined
										? `${goal.tokensUsed} / ${goal.tokenBudget}`
										: String(goal.tokensUsed)
									: t("common.unavailable")}
							</dd>
						</div>
						<div>
							<dt>{t("agents.time")}</dt>
							<dd>{formatDurationSeconds(goal.timeUsedSeconds, locale) ?? t("common.unavailable")}</dd>
						</div>
					</dl>
					<div className="omp-row omp-row-wrap">
						{goal.status === "active" ? (
							<button
								type="button"
								className="omp-button"
								disabled={disabled || busy}
								onClick={() => void onRun("pause")}
							>
								{t("agents.pause")}
							</button>
						) : null}
						{goal.status === "paused" || goal.status === "budget-limited" ? (
							<button
								type="button"
								className="omp-button omp-button-primary"
								disabled={disabled || busy}
								onClick={() => void onRun("resume")}
							>
								{t("agents.resume")}
							</button>
						) : null}
						{goal.status !== "dropped" && goal.status !== "complete" ? (
							confirmDrop ? (
								<div className="omp-inline-confirm" role="group" aria-label={t("agents.confirmDropLabel")}>
									<span>{t("agents.dropConfirm")}</span>
									<button
										type="button"
										className="omp-button omp-button-danger"
										disabled={busy}
										onClick={() => {
											setConfirmDrop(false);
											void onRun("drop");
										}}
									>
										{t("agents.drop")}
									</button>
									<button type="button" className="omp-button" onClick={() => setConfirmDrop(false)}>
										{t("agents.keep")}
									</button>
								</div>
							) : (
								<button
									type="button"
									className="omp-button"
									disabled={disabled || busy}
									onClick={() => setConfirmDrop(true)}
								>
									{t("agents.drop")}
								</button>
							)
						) : null}
					</div>
				</div>
			) : (
				<p className="omp-muted omp-flat-empty">{t("agents.noGoal")}</p>
			)}

			{canCreate ? (
				<details className="omp-goal-new">
				<summary>{t("agents.defineGoal")}</summary>
				<form className="omp-goal-form" onSubmit={submitCreate}>
					<label className="omp-field">
						<span>{t("agents.newGoal")}</span>
						<textarea
							value={objective}
							onChange={event => setObjective(event.target.value)}
							rows={3}
							placeholder={t("agents.goalPlaceholder")}
							disabled={disabled || busy}
						/>
					</label>
					<label className="omp-field">
						<span>{t("agents.tokenBudget")}</span>
						<input
							type="number"
							min={1}
							step={1}
							inputMode="numeric"
							value={budget}
							onChange={event => setBudget(event.target.value)}
							placeholder={t("agents.noLimit")}
							disabled={disabled || busy}
						/>
					</label>
					{localError ? (
						<p className="omp-message omp-message-error" role="alert">
							<StatusIcon kind="error" /> {localError}
						</p>
					) : null}
					<button type="submit" className="omp-button omp-button-primary" disabled={disabled || busy}>
						{t("agents.createGoal")}
					</button>
					<p className="omp-hint">{t("agents.goalHint")}</p>
				</form>
				</details>
			) : null}
		</section>
	);
}

export function AgentsPanel({ state }: { state: SessionViewState }) {
	const t = useT();
	const { locale } = useI18n();
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	const [transcripts, setTranscripts] = useState<Record<string, TranscriptState>>({});
	const transcriptsRef = useRef(transcripts);
	const sessionRef = useRef(state.sessionId);
	const [confirmCancel, setConfirmCancel] = useState(false);
	const [steerText, setSteerText] = useState("");
	const [actionBusy, setActionBusy] = useState<null | "cancel" | "steer" | "goal">(null);
	const [notice, setNotice] = useState<Notice | null>(null);

	useEffect(() => {
		transcriptsRef.current = transcripts;
	}, [transcripts]);

	useEffect(() => {
		sessionRef.current = state.sessionId;
		setSelectedKey(null);
		setTranscripts({});
		transcriptsRef.current = {};
		setConfirmCancel(false);
		setSteerText("");
		setNotice(null);
	}, [state.sessionId]);

	const agents = state.agents ?? [];
	const todoPhases = state.meta?.todoPhases ?? [];
	const counts = useMemo(() => todoCounts(todoPhases), [todoPhases]);
	const goal = useMemo(() => readGoal(state.meta?.goal), [state.meta?.goal]);

	const selectedAgent = useMemo(
		() => (selectedKey ? (agents.find(agent => agent.key === selectedKey) ?? null) : null),
		[agents, selectedKey],
	);
	const selectedTranscript = selectedKey ? transcripts[selectedKey] : undefined;

	const loadTranscript = useCallback(
		async (agent: AgentRow, options: { replace?: boolean } = {}) => {
			const key = agent.key;
			if (!agent.id) {
				// Só o transcript selecionado fica em memória: o painel exibe um por vez.
				setTranscripts(previous => ({
					[key]: {
						items: previous[key]?.items ?? [],
						loading: false,
						error: t("agents.transcriptUnavailable"),
					},
				}));
				return;
			}
			const current = transcriptsRef.current[key];
			if (current?.loading) return;
			const fromByte = options.replace ? 0 : (current?.nextByte ?? 0);
			setTranscripts(previous => ({
				[key]: {
					...(previous[key] ?? { items: [] }),
					loading: true,
					error: undefined,
				},
			}));
			try {
				const raw = await invoke({
					op: "session.subagentTranscript",
					workspaceId: state.workspaceId,
					sessionId: state.sessionId,
					subagentId: agent.id,
					...(fromByte > 0 ? { fromByte } : {}),
				});
				if (sessionRef.current !== state.sessionId) return;
				const page = parseTranscriptPage(raw);
				setTranscripts(previous => {
					const existing = previous[key];
					const items = mergeTranscript(options.replace ? [] : (existing?.items ?? []), page, {
						replace: options.replace,
						locale,
					});
					return {
						[key]: {
							items,
							nextByte: page.nextByte,
							sessionFile: page.sessionFile ?? existing?.sessionFile,
							loading: false,
							error: undefined,
						},
					};
				});
			} catch (error) {
				if (sessionRef.current !== state.sessionId) return;
				setTranscripts(previous => ({
					[key]: {
						...(previous[key] ?? { items: [] }),
						loading: false,
						error: errorText(error, locale),
					},
				}));
			}
		},
		[state.sessionId, state.workspaceId, t, locale],
	);

	useEffect(() => {
		if (!selectedAgent) return;
		if (transcriptsRef.current[selectedAgent.key]) return;
		void loadTranscript(selectedAgent, { replace: true });
	}, [selectedAgent, loadTranscript]);

	const selectAgent = (agent: AgentRow) => {
		setSelectedKey(agent.key);
		setConfirmCancel(false);
		setSteerText("");
		setNotice(null);
		if (transcriptsRef.current[agent.key]) void loadTranscript(agent);
	};

	const runGoal = async (
		op: "create" | "pause" | "resume" | "drop",
		options: { objective?: string; tokenBudget?: number } = {},
	): Promise<boolean> => {
		setActionBusy("goal");
		setNotice(null);
		try {
			const command: RpcCommandInput = {
				type: "goal",
				op,
				...(options.objective ? { objective: options.objective } : {}),
				...(options.tokenBudget !== undefined ? { token_budget: options.tokenBudget } : {}),
			};
			await invoke({
				op: "session.rpc",
				workspaceId: state.workspaceId,
				sessionId: state.sessionId,
				command,
			});
			setNotice({
				level: "success",
				text:
					op === "create"
						? t("agents.goalCreateSent")
						: op === "pause"
							? t("agents.goalPauseSent")
							: op === "resume"
								? t("agents.goalResumeSent")
								: t("agents.goalDropSent"),
			});
			return true;
		} catch (error) {
			setNotice({ level: "error", text: t("agents.goalFailed", { error: errorText(error, locale) }) });
			return false;
		} finally {
			setActionBusy(null);
		}
	};

	const cancelSelected = async () => {
		if (!selectedAgent?.id) return;
		setActionBusy("cancel");
		setNotice(null);
		try {
			const raw = await invoke({
				op: "session.rpc",
				workspaceId: state.workspaceId,
				sessionId: state.sessionId,
				command: { type: "cancel_subagent", subagentId: selectedAgent.id },
			});
			const data = unwrapRpcData(raw);
			const cancelled =
				typeof data === "object" && data !== null && "cancelled" in data ? data.cancelled : undefined;
			setConfirmCancel(false);
			if (cancelled === false) {
				setNotice({
					level: "warning",
					text: t("agents.cancelUnconfirmed"),
				});
			} else {
				setNotice({ level: "success", text: t("agents.cancelRequested", { agent: selectedAgent.agent }) });
			}
		} catch (error) {
			setConfirmCancel(false);
			setNotice({ level: "error", text: t("agents.cancelFailed", { error: errorText(error, locale) }) });
		} finally {
			setActionBusy(null);
		}
	};

	const steerSelected = async (event: FormEvent) => {
		event.preventDefault();
		if (!selectedAgent?.id) return;
		const message = steerText.trim();
		if (!message) return;
		setActionBusy("steer");
		setNotice(null);
		try {
			await invoke({
				op: "session.rpc",
				workspaceId: state.workspaceId,
				sessionId: state.sessionId,
				command: { type: "steer_subagent", subagentId: selectedAgent.id, message },
			});
			setSteerText("");
			setNotice({ level: "success", text: t("agents.steerSent") });
		} catch (error) {
			setNotice({ level: "error", text: t("agents.steerFailed", { error: errorText(error, locale) }) });
		} finally {
			setActionBusy(null);
		}
	};

	const runnerLabel = (agent: AgentRow): string =>
		agent.status === "unknown" && agent.finalized ? t("agents.finalized") : agentStatusLabel(agent.status, locale);

	const allTasks = todoPhases.flatMap((phase) =>
		(phase.tasks ?? []).map((task, index) => ({ ...task, key: `${phase.name}-${index}-${task.content}`, phase: phase.name })),
	);

	return (
		<aside className="omp-agents-panel omp-agents-panel--flat" aria-label={t("agents.panelLabel")}>
			<div className="omp-panel-body">
				{notice ? (
					<div className={`omp-message omp-message-${notice.level}`} role="status" aria-live="polite">
						<StatusIcon
							kind={
								notice.level === "success"
									? "success"
									: notice.level === "warning"
										? "warning"
										: notice.level === "error"
											? "error"
											: "info"
							}
						/>
						<span>{notice.text}</span>
						<button type="button" className="omp-icon-button" onClick={() => setNotice(null)} aria-label={t("common.dismissNotice")}>
							×
						</button>
					</div>
				) : null}

				{state.status === "starting" ? <p className="omp-muted">{t("agents.waitingSession")}</p> : null}
				{state.error ? (
					<div className="omp-message omp-message-error" role="alert">
						<StatusIcon kind="error" />
						<span>{state.error}</span>
					</div>
				) : null}

				<GoalSection
					key={state.sessionId}
					goal={goal}
					disabled={actionBusy !== null}
					busy={actionBusy === "goal"}
					onRun={runGoal}
				/>

				<section className="omp-flat-section" aria-labelledby="omp-todos-title">
					<header className="omp-flat-head">
						<h3 id="omp-todos-title">{t("agents.tasksTitle")}</h3>
						<span className="omp-num">{counts.total > 0 ? t("agents.taskProgress", { done: counts.done, total: counts.total }) : ""}</span>
					</header>
					{allTasks.length === 0 ? (
						<p className="omp-muted omp-flat-empty">{t("agents.noTasks")}</p>
					) : (
						<ul className="omp-tasks">
							{allTasks.map((task) => (
								<li key={task.key} className={`omp-task omp-task--${task.status}`}>
									<StatusIcon kind={todoStatusIcon(task.status)} size={14} />
									<span className="omp-task__text">{task.content}</span>
									<span className="sr-only">{todoStatusLabel(task.status, locale)}</span>
								</li>
							))}
						</ul>
					)}
				</section>

				<section className="omp-flat-section" aria-labelledby="omp-runners-title">
					<header className="omp-flat-head">
						<h3 id="omp-runners-title">{t("agents.runnersTitle")}</h3>
						<span className="omp-num">{agents.length > 0 ? agents.length : ""}</span>
					</header>
					{agents.length === 0 ? (
						<p className="omp-muted omp-flat-empty">{t("agents.noRunners")}</p>
					) : (
						<ul className="omp-runners" aria-label={t("agents.runnersLabel")}>
							{agents.map((agent) => {
								const isSelected = agent.key === selectedKey;
								return (
									<li key={agent.key}>
										<article className={`omp-runner${isSelected ? " is-selected" : ""}`}>
											<button
												type="button"
												className="omp-runner__main"
												aria-expanded={isSelected}
												aria-controls={isSelected ? "omp-agent-detail" : undefined}
												onClick={() => (isSelected ? setSelectedKey(null) : selectAgent(agent))}
											>
												<span className="omp-runner__head">
													<span className={`omp-runner__state omp-state-${agent.status}`}>
														{agent.status === "running" ? (
															<span className="ring" aria-hidden="true" />
														) : (
															<StatusIcon kind={AGENT_STATUS_ICONS[agent.status]} size={14} />
														)}
														{runnerLabel(agent)}
													</span>
													<span className="omp-runner__name">{agent.agent}</span>
													{typeof agent.index === "number" ? <span className="omp-runner__index">#{agent.index + 1}</span> : null}
												</span>
												{agent.description || agent.task ? (
													<span className="omp-runner__desc">{agent.description ?? agent.task}</span>
												) : null}
												<dl className="omp-runner__models">
													<dt>{t("agents.effectiveModel")}</dt>
													<dd className={agent.effectiveModel ? "mono" : "omp-muted"} title={agent.effectiveModel ?? t("common.modelUnknown")}>
														{agent.effectiveModel ?? t("common.modelUnknown")}
													</dd>
													<dt>{t("agents.configuredModel")}</dt>
													<dd className={agent.configuredModel ? "mono" : "omp-muted"} title={agent.configuredModel ?? t("common.notInformed")}>
														{agent.configuredModel ?? t("common.notInformed")}
													</dd>
												</dl>
											</button>
										</article>
									</li>
								);
							})}
						</ul>
					)}
				</section>

				{selectedKey && !selectedAgent ? (
					<p className="omp-message omp-message-warning" role="status">
						<StatusIcon kind="warning" /> {t("agents.runnerGone")}
					</p>
				) : null}

				{selectedAgent || (selectedKey && selectedTranscript) ? (
					<section id="omp-agent-detail" className="omp-agent-detail" aria-label={t("agents.runnerDetail")}>
						{selectedAgent ? (
							<>
								<header className="omp-agent-detail-head">
									<div>
										<h3>{selectedAgent.agent}</h3>
										<p className="omp-muted">{runnerLabel(selectedAgent)}</p>
									</div>
									<button
										type="button"
										className="omp-button omp-button-small"
										onClick={() => void loadTranscript(selectedAgent)}
										disabled={Boolean(selectedTranscript?.loading)}
									>
										{selectedTranscript?.loading ? t("agents.refreshing") : t("agents.refreshTranscript")}
									</button>
								</header>

								<div className="omp-row omp-row-wrap omp-agent-actions">
									{isLiveStatus(selectedAgent.status) ? (
										confirmCancel ? (
											<div className="omp-inline-confirm" role="group" aria-label={t("agents.confirmCancelLabel")}>
												<span>{t("agents.cancelOnly", { agent: selectedAgent.agent })}</span>
												<button
													type="button"
													className="omp-button omp-button-danger"
													onClick={() => void cancelSelected()}
													disabled={actionBusy === "cancel"}
												>
													{actionBusy === "cancel" ? t("agents.cancelling") : t("agents.confirmCancel")}
												</button>
												<button
													type="button"
													className="omp-button"
													onClick={() => setConfirmCancel(false)}
													disabled={actionBusy === "cancel"}
												>
													{t("agents.back")}
												</button>
											</div>
										) : (
											<button
												type="button"
												className="omp-button omp-button-danger"
												onClick={() => setConfirmCancel(true)}
												disabled={!selectedAgent.id || actionBusy !== null}
											>
												{t("agents.cancelRunner")}
											</button>
										)
									) : null}
									{selectedAgent.sessionFile ? (
										<span className="omp-muted omp-agent-file" title={selectedAgent.sessionFile}>
											{selectedAgent.sessionFile}
										</span>
									) : null}
								</div>

								{isLiveStatus(selectedAgent.status) ? (
									<form className="omp-steer-form" onSubmit={steerSelected}>
										<label className="omp-field">
											<span>{t("agents.steerLabel")}</span>
											<textarea
												rows={2}
												value={steerText}
												onChange={(event) => setSteerText(event.target.value)}
												placeholder={t("agents.steerPlaceholder")}
												disabled={actionBusy !== null || !selectedAgent.id}
											/>
										</label>
										<button
											type="submit"
											className="omp-button"
											disabled={actionBusy !== null || !selectedAgent.id || !steerText.trim()}
										>
											{actionBusy === "steer" ? t("agents.sending") : t("agents.sendSteering")}
										</button>
									</form>
								) : null}
							</>
						) : (
							<header className="omp-agent-detail-head">
								<h3>{t("agents.transcriptLoaded")}</h3>
							</header>
						)}

						<div className="omp-agent-transcript" role="log" aria-label={t("agents.transcriptLabel")}>
							{selectedTranscript?.loading && selectedTranscript.items.length === 0 ? (
								<p className="omp-muted">{t("agents.loadingTranscript")}</p>
							) : null}
							{selectedTranscript?.error ? (
								<div className="omp-message omp-message-error" role="alert">
									<StatusIcon kind="error" />
									<span>{selectedTranscript.error}</span>
									{selectedAgent?.id ? (
										<button
											type="button"
											className="omp-button omp-button-small"
											onClick={() => void loadTranscript(selectedAgent, { replace: true })}
										>
											{t("common.retry")}
										</button>
									) : null}
								</div>
							) : null}
							{selectedTranscript && selectedTranscript.items.length > 0 ? (
								<TranscriptView items={selectedTranscript.items} />
							) : null}
							{selectedTranscript &&
							!selectedTranscript.loading &&
							!selectedTranscript.error &&
							selectedTranscript.items.length === 0 ? (
								<p className="omp-muted">{t("agents.emptyTranscript")}</p>
							) : null}
						</div>
					</section>
				) : null}
			</div>
		</aside>
	);
}

export default AgentsPanel;
