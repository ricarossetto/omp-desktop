import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UiResponse } from "@shared/contracts";
import type { PendingDialog } from "@shared/session-types";
import { Icon } from "../../components/Icon";
import { Modal } from "../../components/Modal";
import { useI18n, useT, type Translate } from "../../i18n";
import { useActions, useStore } from "../../store/context";
import { isLostSessionStatus } from "../../store/dialog-state";
import {
	buildCancelResponse,
	buildDialogResponse,
	buildSelectResponse,
	dialogDeadline,
	dialogSecondsLeft,
	isAskComplete,
	type AskAnswerDraft,
	type AskAnswers,
} from "./dialog-responses";
import "./dialogs.css";

function dialogTitle(dialog: PendingDialog, t: Translate): string {
	if (dialog.title) return dialog.title;
	switch (dialog.method) {
		case "select":
			return t("dialog.selectTitle");
		case "confirm":
			return t("dialog.confirmTitle");
		case "input":
			return t("dialog.inputTitle");
		case "editor":
			return t("dialog.editorTitle");
		case "ask":
			return t("dialog.askTitle");
	}
}

interface DialogViewProps {
	dialog: PendingDialog;
	sessionId: string;
	queued: number;
}

function DialogView({ dialog, sessionId, queued }: DialogViewProps) {
	const t = useT();
	const { locale } = useI18n();
	const actions = useActions();
	const responded = useRef(false);
	/** Uma única tentativa automática de cancelamento por diálogo (sem retry por segundo). */
	const timeoutAttempted = useRef(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [value, setValue] = useState(dialog.prefill ?? "");
	const [selected, setSelected] = useState<string | null>(null);
	const [answers, setAnswers] = useState<AskAnswers>({});
	const [now, setNow] = useState(() => Date.now());
	const [revealSecret, setRevealSecret] = useState(false);

	const deadline = dialogDeadline(dialog);
	const secondsLeft = dialogSecondsLeft(dialog, now);

	const send = useCallback(
		async (response: UiResponse | { error: string }, timedOut = false) => {
			// `responded` bloqueia duplo clique enquanto o envio está em andamento;
			// uma entrega recusada libera o diálogo para nova tentativa.
			if (!response || "error" in response || responded.current) return;
			responded.current = true;
			setSubmitting(true);
			setError(null);
			try {
				if (await actions.respondDialog(sessionId, response)) return;
			} catch {
				// A ação já converte falhas em `false`; o catch só evita travar a UI.
			}
			responded.current = false;
			setSubmitting(false);
			setError(
				timedOut
					? dialog.method === "ask"
						? t("dialog.timeoutAsk")
						: t("dialog.timeoutOther")
					: t("dialog.deliveryFailed"),
			);
		},
		[actions, dialog.method, sessionId, t],
	);

	const cancel = useCallback(
		(timedOut = false) => {
			void send(buildCancelResponse(dialog.id, timedOut), timedOut);
		},
		[dialog.id, send],
	);

	useEffect(() => {
		if (deadline === null) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [deadline]);

	useEffect(() => {
		if (deadline === null || now < deadline) return;
		// Depois de uma tentativa automática falhar, não reenvia a cada segundo:
		// o usuário vê o aviso e decide responder, cancelar ou esperar o OMP.
		if (timeoutAttempted.current || responded.current) return;
		timeoutAttempted.current = true;
		cancel(true);
	}, [now, deadline, cancel]);

	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			if (!responded.current) cancel(false);
		};
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [cancel]);

	const submit = () => {
		if (dialog.method === "select" && selected === null) {
			setError(t("dialog.selectRequired"));
			return;
		}
		const response =
			dialog.method === "select"
				? buildSelectResponse(dialog.id, selected ?? "")
				: buildDialogResponse(dialog, { value, confirmed: true, answers }, locale);
		if ("error" in response) {
			setError(response.error);
			return;
		}
		void send(response);
	};

	const updateAnswer = (questionId: string, patch: Partial<AskAnswerDraft>) => {
		setAnswers((current) => {
			const previous = current[questionId] ?? { selectedOptions: [], customInput: "" };
			return { ...current, [questionId]: { ...previous, ...patch } };
		});
	};

	const askComplete = useMemo(() => {
		if (dialog.method !== "ask") return true;
		return isAskComplete(dialog.questions ?? [], answers);
	}, [dialog.method, dialog.questions, answers]);

	const footer = (
		<>
			<span className="modal__hint">
				{queued > 0 ? `${t("dialog.queuedMore", { count: queued })} ` : ""}
				{secondsLeft !== null
					? dialog.method === "ask"
						? t("dialog.expiresAsk", { seconds: secondsLeft })
						: t("dialog.expiresOther", { seconds: secondsLeft })
					: t("dialog.noAutoAction")}
			</span>
			<button type="button" className="btn" onClick={() => cancel(false)} disabled={submitting} data-autofocus>
				{t("common.cancel")}
			</button>
			{dialog.method === "confirm" ? (
				<button
					type="button"
					className="btn btn--primary"
					disabled={submitting}
					onClick={() => void send(buildDialogResponse(dialog, { confirmed: true }, locale))}
				>
					{t("common.confirm")}
				</button>
			) : (
				<button
					type="button"
					className="btn btn--primary"
					disabled={submitting || (dialog.method === "ask" && !askComplete)}
					onClick={submit}
				>
					{submitting ? t("dialog.sending") : dialog.method === "ask" ? t("dialog.answer") : t("dialog.send")}
				</button>
			)}
		</>
	);

	return (
		<Modal
			title={dialogTitle(dialog, t)}
			subtitle={dialog.method === "ask" ? t("dialog.questionsSubtitle") : undefined}
			onClose={submitting ? undefined : () => cancel(false)}
			overlayClassName="overlay--dialog"
			footer={footer}
		>
			<div className="dialog">
				{error ? (
					<div className="banner banner--error" role="alert">
						<Icon name="error" />
						<div className="banner__body">{error}</div>
					</div>
				) : null}

				{dialog.message ? <p className="dialog__message">{dialog.message}</p> : null}

				{dialog.method === "select" ? (
					<div className="dialog__options" role="radiogroup" aria-label={dialogTitle(dialog, t)}>
						{(dialog.options ?? []).map((option, index) => (
							<label
								key={`${option}:${index}`}
								className={`dialog__option${selected === option ? " dialog__option--selected" : ""}`}
							>
								<input
									type="radio"
									name={`dialog-${dialog.id}`}
									value={option}
									checked={selected === option}
									onChange={() => setSelected(option)}
									data-autofocus={index === 0}
								/>
								<span className="dialog__option-text">
									<span className="dialog__option-label">{option}</span>
									{dialog.optionDetails?.[index]?.description ? (
										<span className="dialog__option-detail">{dialog.optionDetails[index].description}</span>
									) : null}
								</span>
							</label>
						))}
					</div>
				) : null}

				{dialog.method === "input" ? (
					<div className="field">
						<label htmlFor={`dialog-input-${dialog.id}`}>{dialog.title ?? t("dialog.value")}</label>
						<div className="dialog__secret">
							<input
								id={`dialog-input-${dialog.id}`}
								className="input"
								type={dialog.secret && !revealSecret ? "password" : "text"}
								value={value}
								placeholder={dialog.placeholder}
								onChange={(event) => setValue(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										submit();
									}
								}}
								data-autofocus
							/>
							{dialog.secret ? (
								<button
									type="button"
									className="btn btn--sm"
									onClick={() => setRevealSecret((current) => !current)}
								>
									{revealSecret ? t("dialog.hide") : t("dialog.show")}
								</button>
							) : null}
						</div>
						{dialog.placeholder ? <span className="muted text-xs">{dialog.placeholder}</span> : null}
					</div>
				) : null}

				{dialog.method === "editor" ? (
					<div className="field">
						<label htmlFor={`dialog-editor-${dialog.id}`}>{dialog.title ?? t("dialog.content")}</label>
						<textarea
							id={`dialog-editor-${dialog.id}`}
							className="textarea dialog__editor"
							value={value}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
									event.preventDefault();
									submit();
								}
							}}
							data-autofocus
						/>
						<span className="muted text-xs">{t("dialog.editorHint")}</span>
					</div>
				) : null}

				{dialog.method === "ask" ? (
					<div className="dialog__questions">
						{(dialog.questions ?? []).map((question, questionIndex) => {
							const draft = answers[question.id] ?? { selectedOptions: [], customInput: "" };
							const isMulti = question.multi === true;
							return (
								<fieldset className="dialog__question" key={question.id}>
									<legend>
										{question.header ? <span className="dialog__question-header">{question.header}</span> : null}
										{question.question}
									</legend>
									<div className="dialog__options">
										{question.options.map((option, index) => {
											const checked = draft.selectedOptions.includes(option.label);
											return (
												<label
													key={`${option.label}:${index}`}
													className={`dialog__option${checked ? " dialog__option--selected" : ""}`}
												>
													<input
														type={isMulti ? "checkbox" : "radio"}
														name={`ask-${dialog.id}-${question.id}`}
														checked={checked}
														data-autofocus={questionIndex === 0 && index === 0}
														onChange={() => {
															if (isMulti) {
																updateAnswer(question.id, {
																	selectedOptions: checked
																		? draft.selectedOptions.filter((label) => label !== option.label)
																		: [...draft.selectedOptions, option.label],
																});
															} else {
																updateAnswer(question.id, {
																	selectedOptions: [option.label],
																	customInput: "",
																});
															}
														}}
													/>
													<span className="dialog__option-text">
														<span className="dialog__option-label">
															{option.label}
															{question.recommended === index ? (
																<span className="badge badge--accent">{t("dialog.recommended")}</span>
															) : null}
														</span>
														{option.description ? (
															<span className="dialog__option-detail">{option.description}</span>
														) : null}
														{option.preview ? <pre className="dialog__preview">{option.preview}</pre> : null}
													</span>
												</label>
											);
										})}
									</div>
									<label className="field dialog__custom">
										<span className="field-label">{t("dialog.customAnswer")}</span>
										<input
											className="input"
											type="text"
											value={draft.customInput}
											placeholder={t("dialog.customPlaceholder")}
											onChange={(event) => {
												const customInput = event.target.value;
												updateAnswer(question.id, {
													customInput,
													selectedOptions:
														!isMulti && customInput.length > 0 ? [] : draft.selectedOptions,
												});
											}}
										/>
									</label>
								</fieldset>
							);
						})}
					</div>
				) : null}

				{dialog.method === "confirm" ? (
					<div className="dialog__details">
						<p className="muted">{t("dialog.confirmBody")}</p>
					</div>
				) : null}
			</div>
		</Modal>
	);
}

/** Mostra o diálogo mais antigo da sessão ativa; os demais aguardam na fila do host. */
export function DialogHost() {
	const sessionId = useStore((state) => state.activeSessionId);
	const view = useStore((state) => (state.activeSessionId ? state.sessionStates[state.activeSessionId] : null));
	const pendingCount = view?.pendingDialogs.length ?? 0;

	if (!sessionId || !view || pendingCount === 0) return null;
	// Defesa extra: o store já limpa os pendentes ao perder a sessão.
	if (isLostSessionStatus(view.status)) return null;
	const dialog = view.pendingDialogs[0];
	return <DialogView key={dialog.id} dialog={dialog} sessionId={sessionId} queued={pendingCount - 1} />;
}
