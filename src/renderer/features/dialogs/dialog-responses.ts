import type { UiResponse } from "@shared/contracts";
import type { PendingDialog } from "@shared/session-types";
import { translate } from "../../i18n/translate";
import type { Locale } from "../../i18n/types";

export interface AskAnswerDraft {
	selectedOptions: string[];
	customInput: string;
}

export type AskAnswers = Record<string, AskAnswerDraft>;

export function buildSelectResponse(id: string, value: string): UiResponse {
	return { type: "extension_ui_response", id, value };
}

export function buildInputResponse(id: string, value: string): UiResponse {
	return { type: "extension_ui_response", id, value };
}

export function buildConfirmResponse(id: string, confirmed: boolean): UiResponse {
	return { type: "extension_ui_response", id, confirmed };
}

/** Cancelamento nunca aprova; `timedOut` só quando o prazo do OMP expirou. */
export function buildCancelResponse(id: string, timedOut = false): UiResponse {
	return timedOut
		? { type: "extension_ui_response", id, cancelled: true, timedOut: true }
		: { type: "extension_ui_response", id, cancelled: true };
}

/**
 * Monta exatamente o formato esperado pelo OMP:
 * `{type:'extension_ui_response', id, answers:[{id, selectedOptions, customInput?}]}`.
 * A ordem acompanha as perguntas; seleções fora das opções são descartadas.
 */
export function buildAskResponse(
	id: string,
	questions: NonNullable<PendingDialog["questions"]>,
	answers: AskAnswers,
): UiResponse {
	return {
		type: "extension_ui_response",
		id,
		answers: questions.map((question) => {
			const draft = answers[question.id] ?? { selectedOptions: [], customInput: "" };
			const labels = new Set(question.options.map((option) => option.label));
			const selectedOptions = [...new Set(draft.selectedOptions.filter((label) => labels.has(label)))];
			const custom = draft.customInput.trim();
			return custom.length > 0
				? { id: question.id, selectedOptions, customInput: custom }
				: { id: question.id, selectedOptions };
		}),
	};
}

/** Toda pergunta precisa de seleção ou de resposta livre. */
export function isAskComplete(
	questions: NonNullable<PendingDialog["questions"]>,
	answers: AskAnswers,
): boolean {
	return questions.every((question) => {
		const draft = answers[question.id];
		if (!draft) return false;
		return draft.selectedOptions.length > 0 || draft.customInput.trim().length > 0;
	});
}

export function buildDialogResponse(
	dialog: PendingDialog,
	payload: { value?: string; confirmed?: boolean; answers?: AskAnswers },
	locale: Locale = "pt-BR",
): UiResponse | { error: string } {
	switch (dialog.method) {
		case "select":
			if (payload.value === undefined) return { error: translate(locale, "dialog.selectRequired") };
			return buildSelectResponse(dialog.id, payload.value);
		case "confirm":
			if (typeof payload.confirmed !== "boolean") return { error: translate(locale, "dialog.confirmRequired") };
			return buildConfirmResponse(dialog.id, payload.confirmed);
		case "input":
		case "editor":
			return buildInputResponse(dialog.id, payload.value ?? "");
		case "ask": {
			const questions = dialog.questions ?? [];
			if (questions.length === 0) return { error: translate(locale, "dialog.noQuestions") };
			const answers = payload.answers ?? {};
			if (!isAskComplete(questions, answers)) return { error: translate(locale, "dialog.answerAll") };
			return buildAskResponse(dialog.id, questions, answers);
		}
	}
}

/** Instante de expiração em ms, quando o OMP anunciou timeout. */
export function dialogDeadline(dialog: PendingDialog): number | null {
	if (typeof dialog.timeout !== "number" || !Number.isFinite(dialog.timeout) || dialog.timeout <= 0) return null;
	return dialog.receivedAt + dialog.timeout;
}

/** Segundos restantes para exibição (nunca negativo). */
export function dialogSecondsLeft(dialog: PendingDialog, now: number): number | null {
	const deadline = dialogDeadline(dialog);
	if (deadline === null) return null;
	return Math.max(0, Math.ceil((deadline - now) / 1000));
}
