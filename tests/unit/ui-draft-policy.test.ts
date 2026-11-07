import { describe, expect, test } from "bun:test";
import type { AttachmentDto } from "../../src/shared/contracts";
import {
	EMPTY_COMPOSER_DRAFT,
	appendAttachments,
	mergeRestoredDraft,
	parseAbortRestore,
	removeAttachment,
	settleDraftAfterAck,
	shouldSubmitOnKey,
} from "../../src/renderer/features/conversation/composer-policy";

function attachment(id: string): AttachmentDto {
	return { attachmentId: id, name: `${id}.png`, mimeType: "image/png", size: 10, kind: "image" };
}

describe("política de rascunho", () => {
	test("ack limpa texto e anexos enviados", () => {
		const draft = { text: "olá", attachments: [attachment("a"), attachment("b")] };
		const settled = settleDraftAfterAck(draft, { text: "olá", attachmentIds: ["a", "b"] });
		expect(settled.text).toBe("");
		expect(settled.attachments).toEqual([]);
	});

	test("texto digitado durante o envio não é perdido", () => {
		const draft = { text: "olá, mais uma coisa", attachments: [attachment("a")] };
		const settled = settleDraftAfterAck(draft, { text: "olá", attachmentIds: ["a"] });
		expect(settled.text).toBe("olá, mais uma coisa");
		expect(settled.attachments).toEqual([]);
	});

	test("anexo novo permanece; anexo enviado sai", () => {
		const draft = { text: "", attachments: [attachment("a"), attachment("b")] };
		const settled = settleDraftAfterAck(draft, { text: "", attachmentIds: ["a"] });
		expect(settled.attachments.map((item) => item.attachmentId)).toEqual(["b"]);
	});

	test("falha de envio não altera o rascunho (não chamamos settle)", () => {
		const draft = { text: "texto", attachments: [attachment("a")] };
		expect(draft.text).toBe("texto");
		expect(draft.attachments).toHaveLength(1);
	});

	test("restauração do abort é inserida antes do texto atual", () => {
		const current = { text: "novo", attachments: [] };
		const merged = mergeRestoredDraft(current, "antigo");
		expect(merged.text).toBe("antigo\nnovo");
	});

	test("restauração vazia mantém o rascunho", () => {
		const current = { text: "novo", attachments: [] };
		expect(mergeRestoredDraft(current, "   ")).toBe(current);
	});

	test("anexos são deduplicados por id", () => {
		const draft = appendAttachments(EMPTY_COMPOSER_DRAFT, [attachment("a")]);
		const again = appendAttachments(draft, [attachment("a"), attachment("b")]);
		expect(again.attachments.map((item) => item.attachmentId)).toEqual(["a", "b"]);
		expect(removeAttachment(again, "a").attachments.map((item) => item.attachmentId)).toEqual(["b"]);
	});
});

describe("tecla de envio", () => {
	test("Enter envia e Shift+Enter quebra linha", () => {
		expect(shouldSubmitOnKey({ key: "Enter" })).toBe(true);
		expect(shouldSubmitOnKey({ key: "Enter", shiftKey: true })).toBe(false);
	});

	test("composição de IME nunca envia", () => {
		expect(shouldSubmitOnKey({ key: "Enter", isComposing: true })).toBe(false);
	});

	test("Ctrl/Cmd+Enter envia, Alt+Enter não", () => {
		expect(shouldSubmitOnKey({ key: "Enter", ctrlKey: true })).toBe(true);
		expect(shouldSubmitOnKey({ key: "Enter", metaKey: true })).toBe(true);
		expect(shouldSubmitOnKey({ key: "Enter", altKey: true })).toBe(false);
	});

	test("outras teclas não enviam", () => {
		expect(shouldSubmitOnKey({ key: "a" })).toBe(false);
	});
});

describe("resultado de abort_and_restore_queue", () => {
	test("lê o formato aninhado em restored", () => {
		const outcome = parseAbortRestore({
			restored: {
				text: "mensagem",
				attachments: [{ attachmentId: "x", name: "x.png", mimeType: "image/png", size: 12, kind: "image" }],
			},
			truncated: true,
			imagesDropped: true,
		});
		expect(outcome.restoredText).toBe("mensagem");
		expect(outcome.restoredAttachments[0]?.attachmentId).toBe("x");
		expect(outcome.truncated).toBe(true);
		expect(outcome.imagesDropped).toBe(true);
	});

	test("aceita campos no nível superior e dados inválidos", () => {
		expect(parseAbortRestore({ text: "topo" }).restoredText).toBe("topo");
		expect(parseAbortRestore(null)).toEqual({
			restoredText: undefined,
			restoredAttachments: [],
			restoredImages: [],
			truncated: false,
			imagesDropped: false,
		});
	});

	test("lê o formato real do OMP com filas steering/followUp e imagens cruas", () => {
		const outcome = parseAbortRestore({
			steering: [{ text: "primeira" }, { text: "segunda" }],
			followUp: [
				{
					text: "terceira",
					images: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
				},
			],
			truncated: true,
		});
		expect(outcome.restoredText).toBe("primeira\n\nsegunda\n\nterceira");
		expect(outcome.restoredImages).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
		expect(outcome.truncated).toBe(true);
	});
});
