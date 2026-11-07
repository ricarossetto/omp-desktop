import { describe, expect, test } from "bun:test";
import type { PendingDialog } from "../../src/shared/session-types";
import {
	buildAskResponse,
	buildCancelResponse,
	buildConfirmResponse,
	buildDialogResponse,
	buildSelectResponse,
	dialogDeadline,
	dialogSecondsLeft,
	isAskComplete,
} from "../../src/renderer/features/dialogs/dialog-responses";

const askDialog: PendingDialog = {
	id: "ask-1",
	method: "ask",
	questions: [
		{
			id: "q1",
			question: "Quais opções?",
			options: [{ label: "A" }, { label: "B" }, { label: "C" }],
			multi: true,
		},
		{
			id: "q2",
			question: "Qual caminho?",
			options: [{ label: "X" }, { label: "Y" }],
			multi: false,
		},
	],
	receivedAt: 1_000,
	timeout: 30_000,
};

describe("respostas de diálogo", () => {
	test("select, confirm e input usam os campos exatos do protocolo", () => {
		expect(buildSelectResponse("d1", "opção")).toEqual({
			type: "extension_ui_response",
			id: "d1",
			value: "opção",
		});
		expect(buildConfirmResponse("d2", true)).toEqual({
			type: "extension_ui_response",
			id: "d2",
			confirmed: true,
		});
		expect(buildSelectResponse("d3", "")).toEqual({ type: "extension_ui_response", id: "d3", value: "" });
	});

	test("cancelar nunca aprova e timeout é explícito", () => {
		expect(buildCancelResponse("d1")).toEqual({
			type: "extension_ui_response",
			id: "d1",
			cancelled: true,
		});
		expect(buildCancelResponse("d1", true)).toEqual({
			type: "extension_ui_response",
			id: "d1",
			cancelled: true,
			timedOut: true,
		});
	});

	test("ask multi-pergunta e multi-seleção monta answers na ordem, com entrada livre", () => {
		const response = buildAskResponse("ask-1", askDialog.questions ?? [], {
			q1: { selectedOptions: ["A", "C"], customInput: "" },
			q2: { selectedOptions: [], customInput: "  caminho livre  " },
		});
		expect(response).toEqual({
			type: "extension_ui_response",
			id: "ask-1",
			answers: [
				{ id: "q1", selectedOptions: ["A", "C"] },
				{ id: "q2", selectedOptions: [], customInput: "caminho livre" },
			],
		});
	});

	test("opções desconhecidas são descartadas e seleções duplicadas removidas", () => {
		const response = buildAskResponse("ask-1", askDialog.questions ?? [], {
			q1: { selectedOptions: ["A", "A", "INJETADA"], customInput: "" },
			q2: { selectedOptions: ["Y"], customInput: "   " },
		});
		expect(response).toEqual({
			type: "extension_ui_response",
			id: "ask-1",
			answers: [
				{ id: "q1", selectedOptions: ["A"] },
				{ id: "q2", selectedOptions: ["Y"] },
			],
		});
	});

	test("pergunta sem resposta impede o envio", () => {
		expect(
			isAskComplete(askDialog.questions ?? [], {
				q1: { selectedOptions: ["A"], customInput: "" },
			}),
		).toBe(false);
		expect(
			isAskComplete(askDialog.questions ?? [], {
				q1: { selectedOptions: ["A"], customInput: "" },
				q2: { selectedOptions: [], customInput: "livre" },
			}),
		).toBe(true);
	});

	test("buildDialogResponse valida campos por método", () => {
		const select: PendingDialog = { id: "s", method: "select", options: ["A"], receivedAt: 0 };
		expect(buildDialogResponse(select, {})).toEqual({ error: "Selecione uma opção para continuar." });
		expect(buildDialogResponse(select, { value: "A" })).toEqual({
			type: "extension_ui_response",
			id: "s",
			value: "A",
		});

		const confirm: PendingDialog = { id: "c", method: "confirm", receivedAt: 0 };
		expect(buildDialogResponse(confirm, {})).toEqual({ error: "Confirme ou cancele a solicitação." });

		expect(buildDialogResponse(askDialog, { answers: {} })).toEqual({
			error: "Responda todas as perguntas para continuar.",
		});
	});

	test("timeout é milissegundos a partir de receivedAt", () => {
		expect(dialogDeadline(askDialog)).toBe(31_000);
		expect(dialogSecondsLeft(askDialog, 21_000)).toBe(10);
		expect(dialogSecondsLeft(askDialog, 40_000)).toBe(0);
		expect(dialogDeadline({ ...askDialog, timeout: undefined })).toBeNull();
		expect(dialogDeadline({ ...askDialog, timeout: 0 })).toBeNull();
	});
});
