import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import type { SessionViewState, SlashCommandInfo } from "@shared/session-types";
import { Icon } from "../../components/Icon";
import { formatBytes, formatModelLabel } from "../../format";
import { useI18n, useT, type MessageKey } from "../../i18n";
import { useActions, useStore } from "../../store/context";
import { isLiveSteered } from "../../store/queue-policy";
import { EMPTY_COMPOSER_DRAFT, shouldSubmitOnKey } from "./composer-policy";
import { toolSummary } from "./ToolCard";

export interface ComposerProps {
	view: SessionViewState;
}

function commandLabel(command: SlashCommandInfo): string {
	return `/${command.name}`;
}

const SHORT_THINKING: Record<string, MessageKey> = {
	off: "composer.thinkingOff",
	minimal: "composer.thinkingMinimal",
	low: "composer.thinkingLow",
	medium: "composer.thinkingMedium",
	high: "composer.thinkingHigh",
	xhigh: "composer.thinkingMax",
};

function finishedSteps(view: SessionViewState): number {
	return Object.values(view.tools).filter((tool) => tool.status !== "running").length;
}

function hasRunningTool(view: SessionViewState): boolean {
	return Object.values(view.tools).some((tool) => tool.status === "running");
}

export function Composer({ view }: ComposerProps) {
	const t = useT();
	const { locale } = useI18n();
	const actions = useActions();
	const draft = useStore((state) => state.drafts[view.sessionId] ?? EMPTY_COMPOSER_DRAFT);
	const sending = useStore((state) => state.sending[view.sessionId] === true);
	const focusNonce = useStore((state) => state.composerFocusNonce);

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const composingRef = useRef(false);
	const dragDepth = useRef(0);

	const [dragActive, setDragActive] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [busyAttachment, setBusyAttachment] = useState<string | null>(null);
	const [queueBusy, setQueueBusy] = useState<string | null>(null);
	const [slashIndex, setSlashIndex] = useState(0);
	const [slashDismissed, setSlashDismissed] = useState(false);
	/** Pausa pedida: guarda quantos passos já tinham terminado no clique. */
	const [pauseBaseline, setPauseBaseline] = useState<number | null>(null);
	const [paused, setPaused] = useState(false);
	const [plusOpen, setPlusOpen] = useState(false);
	const plusRef = useRef<HTMLDivElement>(null);
	const [workingSince, setWorkingSince] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());

	const streaming = view.meta?.isStreaming === true || view.status === "busy";
	const working =
		streaming ||
		view.status === "starting" ||
		(view.meta ? !view.meta.isSettled || view.meta.hasPendingAsyncWork : false);
	const disabled = view.status === "starting" || view.status === "closed";

	useEffect(() => {
		setPauseBaseline(null);
		setPaused(false);
	}, [view.sessionId]);

	// "Pausar depois do passo atual": quando um passo termina e nenhum outro está
	// rodando, interrompe com abort_and_restore_queue. A sessão fica salva e o
	// botão Continuar retoma com uma mensagem explícita, nunca reenviando a anterior.
	const doneSteps = finishedSteps(view);
	const toolRunning = hasRunningTool(view);
	useEffect(() => {
		if (pauseBaseline === null) return;
		if (!working) {
			setPauseBaseline(null);
			return;
		}
		if (doneSteps > pauseBaseline && !toolRunning) {
			setPauseBaseline(null);
			setPaused(true);
			void actions.abortAndRestore(view.sessionId);
		}
	}, [actions, doneSteps, pauseBaseline, toolRunning, view.sessionId, working]);

	useEffect(() => {
		if (working) setPaused(false);
		setWorkingSince(working ? Date.now() : null);
	}, [working]);

	useEffect(() => {
		if (workingSince === null) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [workingSince]);

	useEffect(() => {
		if (!plusOpen) return;
		const onDown = (event: PointerEvent) => {
			if (!plusRef.current?.contains(event.target as Node)) setPlusOpen(false);
		};
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				setPlusOpen(false);
			}
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [plusOpen]);

	const elapsedSeconds = workingSince === null ? 0 : Math.max(0, Math.floor((now - workingSince) / 1000));
	const elapsedLabel =
		elapsedSeconds < 60
			? t("composer.elapsedSeconds", { seconds: elapsedSeconds })
			: t("composer.elapsedMinutes", {
					minutes: Math.floor(elapsedSeconds / 60),
					seconds: String(elapsedSeconds % 60).padStart(2, "0"),
				});
	const runningTool = Object.values(view.tools).find((tool) => tool.status === "running");
	const runningToolLabel = runningTool ? toolSummary(runningTool) || runningTool.name : null;

	const insertPrefix = (prefix: string) => {
		setPlusOpen(false);
		const base = draft.text;
		const next = prefix === "/" && !base ? "/" : `${base}${base && !base.endsWith(" ") ? " " : ""}${prefix}`;
		actions.setDraft(view.sessionId, next);
		requestAnimationFrame(() => textareaRef.current?.focus());
	};

	const modelChip = `${view.meta?.model ? formatModelLabel(view.meta.model, locale) : t("common.modelUnknown")}${
		view.meta?.thinkingLevel
			? ` · ${SHORT_THINKING[view.meta.thinkingLevel] ? t(SHORT_THINKING[view.meta.thinkingLevel]) : view.meta.thinkingLevel}`
			: ""
	}`;

	const canSend = (draft.text.trim().length > 0 || draft.attachments.length > 0) && !sending && !disabled;

	const slashQuery = useMemo(() => {
		if (!draft.text.startsWith("/")) return null;
		const rest = draft.text.slice(1);
		if (/\s/.test(rest)) return null;
		return rest.toLowerCase();
	}, [draft.text]);

	const slashMatches = useMemo(() => {
		if (slashQuery === null) return [];
		return view.commands
			.filter(
				(command) =>
					command.name.toLowerCase().includes(slashQuery) ||
					(command.aliases ?? []).some((alias) => alias.toLowerCase().includes(slashQuery)),
			)
			.slice(0, 8);
	}, [slashQuery, view.commands]);

	const slashOpen = slashQuery !== null && slashMatches.length > 0 && !slashDismissed && !disabled;

	useEffect(() => {
		setSlashIndex(0);
		setSlashDismissed(false);
	}, [slashQuery]);

	useLayoutEffect(() => {
		const element = textareaRef.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(220, Math.max(40, element.scrollHeight))}px`;
	}, [draft.text]);

	useEffect(() => {
		if (focusNonce > 0) textareaRef.current?.focus();
	}, [focusNonce]);

	const submit = useCallback(
		async (behavior?: "steer" | "followUp") => {
			if (!canSend) return;
			const attachmentIds = draft.attachments.map((attachment) => attachment.attachmentId);
			await actions.sendPrompt(view.sessionId, draft.text, attachmentIds, behavior);
		},
		[actions, canSend, draft.attachments, draft.text, view.sessionId],
	);

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.nativeEvent.isComposing || composingRef.current) return;

		if (slashOpen) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSlashIndex((index) => (index + 1) % slashMatches.length);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setSlashIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const command = slashMatches[slashIndex];
				if (command) {
					actions.setDraft(view.sessionId, `${commandLabel(command)} `);
					setSlashDismissed(true);
				}
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setSlashDismissed(true);
				return;
			}
		}

		const submitKey = shouldSubmitOnKey({
			key: event.key,
			shiftKey: event.shiftKey,
			ctrlKey: event.ctrlKey,
			metaKey: event.metaKey,
			altKey: event.altKey,
			isComposing: composingRef.current || event.nativeEvent.isComposing,
		});
		if (!submitKey) return;
		event.preventDefault();
		void submit(streaming ? "followUp" : undefined);
	};

	const importFiles = async (files: File[]) => {
		for (const file of files) {
			await actions.importAttachment(view.sessionId, file);
		}
	};

	const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(event.clipboardData.files);
		const images = files.filter((file) => file.type.startsWith("image/"));
		if (images.length > 0) {
			event.preventDefault();
			void importFiles(images);
		}
	};

	const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		dragDepth.current += 1;
		setDragActive(true);
	};

	const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
		if (!event.dataTransfer.types.includes("Files")) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};

	const handleDragLeave = () => {
		dragDepth.current = Math.max(0, dragDepth.current - 1);
		if (dragDepth.current === 0) setDragActive(false);
	};

	const handleDrop = (event: DragEvent<HTMLDivElement>) => {
		event.preventDefault();
		dragDepth.current = 0;
		setDragActive(false);
		const files = Array.from(event.dataTransfer.files);
		if (files.length > 0) void importFiles(files);
	};

	const selectCommand = (command: SlashCommandInfo) => {
		actions.setDraft(view.sessionId, `${commandLabel(command)} `);
		setSlashDismissed(true);
		textareaRef.current?.focus();
	};

	const queueRows = [
		...view.queue.steering.map((message, index) => ({
			message,
			queue: "steering" as const,
			index,
			locked: isLiveSteered(view.queue, "steering", index),
		})),
		...view.queue.followUp.map((message, index) => ({
			message,
			queue: "followUp" as const,
			index,
			locked: false,
		})),
	];

	return (
		<div
			className="composer"
			onDragEnter={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{dragActive ? (
				<div className="composer__drop" aria-hidden="true">
					<Icon name="paperclip" /> {t("composer.dropToAttach")}
				</div>
			) : null}

			{working ? (
				<div className="runline" role="status">
					<span className="runline__state">
						<span className="ring" aria-hidden="true" /> {t("composer.workingWithTime", { elapsed: elapsedLabel })}
					</span>
					{runningToolLabel ? (
						<span className="runline__tool truncate">{t("composer.runningTool", { tool: runningToolLabel })}</span>
					) : null}
					{pauseBaseline !== null ? <span className="runline__pause">{t("composer.pauseRequested")}</span> : null}
				</div>
			) : null}

			{paused && !working ? (
				<div className="pause-banner" role="status">
					<Icon name="info" className="icon--sm" />
					<span className="pause-banner__text">{t("composer.pausedBanner")}</span>
					<button
						type="button"
						className="btn btn--sm btn--primary"
						onClick={() => {
							setPaused(false);
							void actions.sendPrompt(view.sessionId, t("composer.resumePrompt"), []);
						}}
					>
						{t("composer.continue")}
					</button>
					<button type="button" className="icon-btn" aria-label={t("composer.dismissPause")} onClick={() => setPaused(false)}>
						<Icon name="close" className="icon--sm" />
					</button>
				</div>
			) : null}

			{queueRows.length > 0 ? (
				<div className="queue" aria-label={t("composer.queueLabel")}>
					{queueRows.map((row) => {
						const key = `${row.queue}:${row.index}:${row.message}`;
						return (
							<div className="queue__row" key={key}>
								<span
									className="queue__label"
									title={row.queue === "steering" ? t("composer.steeringHint") : t("composer.followUpHint")}
								>
									{row.queue === "steering" ? t("composer.steering") : t("composer.queued")}
								</span>
								<span className="queue__text truncate" title={row.message}>
									{row.message}
								</span>
								{row.locked ? (
									<span className="muted text-xs" title={t("composer.steeredLockedHint")}>
										{t("composer.steeredLocked")}
									</span>
								) : (
									<>
										{row.queue === "followUp" ? (
											<button
												type="button"
												className="btn btn--sm"
												disabled={queueBusy === key}
												title={t("composer.sendNowHint")}
												onClick={async () => {
													setQueueBusy(key);
													await actions.promoteQueued(view.sessionId, row.message);
													setQueueBusy(null);
												}}
											>
												{t("composer.sendNow")}
											</button>
										) : null}
										<button
											type="button"
											className="btn btn--sm btn--ghost"
											disabled={queueBusy === key}
											title={t("composer.editHint")}
											onClick={async () => {
												setQueueBusy(key);
												await actions.removeQueued(view.sessionId, row.message, row.queue);
												actions.setDraft(view.sessionId, draft.text ? `${draft.text}\n${row.message}` : row.message);
												setQueueBusy(null);
												textareaRef.current?.focus();
											}}
										>
											{t("composer.edit")}
										</button>
										<button
											type="button"
											className="icon-btn queue__remove"
											disabled={queueBusy === key}
											aria-label={t("composer.removeFromQueue", { message: row.message })}
											onClick={async () => {
												setQueueBusy(key);
												await actions.removeQueued(view.sessionId, row.message, row.queue);
												setQueueBusy(null);
											}}
										>
											<Icon name="close" className="icon--sm" />
										</button>
									</>
								)}
							</div>
						);
					})}
				</div>
			) : null}

			<div
				className={`composer__box${disabled ? " composer__box--disabled" : ""}${queueRows.length > 0 ? " composer__box--queued" : ""}`}
			>
				{slashOpen ? (
					<div className="slash-menu" role="listbox" aria-label={t("composer.commandsLabel")}>
						{slashMatches.map((command, index) => (
							<button
								type="button"
								key={command.name}
								role="option"
								aria-selected={index === slashIndex}
								className={`slash-menu__item${index === slashIndex ? " slash-menu__item--active" : ""}`}
								onMouseEnter={() => setSlashIndex(index)}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => selectCommand(command)}
							>
								<span className="mono">{commandLabel(command)}</span>
								<span className="slash-menu__desc">
									{command.description ?? command.inputHint ?? t("composer.commandFallback")}
								</span>
							</button>
						))}
					</div>
				) : null}

				{draft.attachments.length > 0 ? (
					<div className="attachments" aria-label={t("composer.attachments")}>
						{draft.attachments.map((attachment) => (
							<span className="attachment-chip" key={attachment.attachmentId}>
								<Icon name={attachment.kind === "image" ? "image" : "file"} className="icon--sm" />
								<span className="attachment-chip__name mono" title={attachment.name}>
									{attachment.name}
								</span>
								<span className="attachment-chip__size">{formatBytes(attachment.size, locale)}</span>
								<button
									type="button"
									className="attachment-chip__remove"
									aria-label={t("composer.removeAttachment", { name: attachment.name })}
									disabled={sending || busyAttachment === attachment.attachmentId}
									onClick={async () => {
										setBusyAttachment(attachment.attachmentId);
										await actions.removeDraftAttachment(view.sessionId, attachment.attachmentId);
										setBusyAttachment(null);
									}}
								>
									<Icon name="close" className="icon--sm" />
								</button>
							</span>
						))}
					</div>
				) : null}

				<textarea
					ref={textareaRef}
					className="composer__input"
					value={draft.text}
					aria-label={t("composer.inputLabel")}
					placeholder={
						disabled
							? t("composer.placeholderStarting")
							: streaming
								? t("composer.placeholderStreaming")
								: t("composer.placeholderIdle")
					}
					rows={1}
					disabled={disabled}
					onChange={(event) => actions.setDraft(view.sessionId, event.target.value)}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					onCompositionStart={() => {
						composingRef.current = true;
					}}
					onCompositionEnd={() => {
						composingRef.current = false;
					}}
				/>

				<div className="composer__footer">
					<div className="composer__tools">
						<div className="plus-menu" ref={plusRef}>
							<button
								type="button"
								className={`icon-btn plus-menu__btn${plusOpen ? " icon-btn--active" : ""}`}
								aria-haspopup="menu"
								aria-expanded={plusOpen}
								aria-label={t("composer.addContext")}
								title={t("composer.addContext")}
								disabled={disabled}
								onClick={() => setPlusOpen((value) => !value)}
							>
								<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
									<path d="M7 2v10M2 7h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
								</svg>
							</button>
							{plusOpen ? (
								<div className="plus-menu__list" role="menu" aria-label={t("composer.addContext")}>
									<button
										type="button"
										role="menuitem"
										onClick={() => {
											setPlusOpen(false);
											void actions.pickAttachments(view.sessionId);
										}}
									>
										<Icon name="paperclip" className="icon--sm" />
										<span>{t("composer.attachFile")}</span>
									</button>
									<button type="button" role="menuitem" onClick={() => insertPrefix("@")}>
										<span className="plus-menu__glyph mono">@</span>
										<span>{t("composer.mentionFile")}</span>
										<span className="plus-menu__key mono">@</span>
									</button>
									<button type="button" role="menuitem" onClick={() => insertPrefix("/")}>
										<span className="plus-menu__glyph mono">/</span>
										<span>{t("composer.commandsAndSkills")}</span>
										<span className="plus-menu__key mono">/</span>
									</button>
								</div>
							) : null}
						</div>
						<button
							type="button"
							className="model-chip"
							title={t("composer.modelChipTitle")}
							disabled={disabled}
							onClick={() => actions.setModelPickerOpen(true)}
						>
							<span className="truncate">{modelChip}</span>
							<Icon name="chevron-down" className="icon--sm" />
						</button>
					</div>

					<div className="composer__actions">
						{streaming && canSend ? (
							<>
								<button
									type="button"
									className="btn btn--sm"
									title={t("composer.steerHint")}
									onClick={() => void submit("steer")}
								>
									{t("composer.steer")}
								</button>
								<button
									type="button"
									className="btn btn--sm btn--ghost"
									title={t("composer.followUpActionHint")}
									onClick={() => void submit("followUp")}
								>
									{t("composer.followUp")}
								</button>
							</>
						) : null}
						{working && !stopping ? (
							<button
								type="button"
								className={`icon-btn pause-btn${pauseBaseline !== null ? " icon-btn--active" : ""}`}
								aria-pressed={pauseBaseline !== null}
								aria-label={pauseBaseline !== null ? t("composer.cancelPause") : t("composer.pauseAfterStep")}
								title={
									pauseBaseline !== null
										? t("composer.pauseRequestedHint")
										: t("composer.pauseAfterStep")
								}
								onClick={() => setPauseBaseline((value) => (value === null ? doneSteps : null))}
							>
								<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
									<rect x="2.5" y="2" width="2.5" height="8" rx="0.5" fill="currentColor" />
									<rect x="7" y="2" width="2.5" height="8" rx="0.5" fill="currentColor" />
								</svg>
							</button>
						) : null}
						{stopping || working ? (
							<button
								type="button"
								className="icon-btn stop-btn"
								aria-label={stopping ? t("composer.stopping") : t("composer.stop")}
								title={t("composer.stopTitle")}
								disabled={stopping}
								onClick={async () => {
									setStopping(true);
									await actions.abortAndRestore(view.sessionId);
									setStopping(false);
								}}
							>
								<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
									<rect x="1.5" y="1.5" width="7" height="7" rx="1" fill="currentColor" />
								</svg>
							</button>
						) : (
							<button
								type="button"
								className="btn btn--primary send-btn"
								disabled={!canSend}
								title={t("composer.sendTitle")}
								onClick={() => void submit()}
							>
								<Icon name="send" className="icon--sm" />
								{sending ? t("composer.sending") : t("composer.send")}
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
