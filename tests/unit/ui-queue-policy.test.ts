import { describe, expect, test } from "bun:test";
import {
	isLiveSteered,
	parseEditorText,
	parsePromoted,
	parseQueueImages,
	queueImagesDropped,
	removableIndexOf,
} from "../../src/renderer/store/queue-policy";

const queue = { steering: ["entregue", "ainda-na-fila"], followUp: ["depois"], liveSteered: 1 };

describe("regras puras da fila", () => {
	test("entradas de steering já entregues ficam travadas", () => {
		expect(isLiveSteered(queue, "steering", 0)).toBe(true);
		expect(isLiveSteered(queue, "steering", 1)).toBe(false);
		expect(isLiveSteered(queue, "followUp", 0)).toBe(false);
		expect(isLiveSteered({ ...queue, liveSteered: 0 }, "steering", 0)).toBe(false);
		expect(isLiveSteered({ ...queue, liveSteered: 9 }, "steering", 1)).toBe(true);
	});

	test("a remoção pula a região já entregue e nunca remove a errada", () => {
		// "entregue" também existe na região travada; o índice removível é o 1.
		expect(removableIndexOf(queue, "steering", "ainda-na-fila")).toBe(1);
		expect(removableIndexOf(queue, "steering", "entregue")).toBe(-1);
		expect(removableIndexOf(queue, "followUp", "depois")).toBe(0);
		expect(removableIndexOf(queue, "followUp", "ausente")).toBe(-1);
	});

	test("imagens devolvidas por remove_queued_message são lidas defensivamente", () => {
		expect(
			parseQueueImages({
				removed: true,
				images: [
					{ type: "image", data: "AAAA", mimeType: "image/jpeg" },
					{ type: "image", data: "" },
					null,
					{ type: "image", data: "BBBB" },
				],
			}),
		).toEqual([
			{ mimeType: "image/jpeg", data: "AAAA" },
			{ mimeType: "image/png", data: "BBBB" },
		]);
		expect(parseQueueImages(null)).toEqual([]);
		expect(parseQueueImages({ removed: true })).toEqual([]);
		expect(parseQueueImages({ images: "nada" })).toEqual([]);
	});

	test("imagesDropped só é verdadeiro quando o OMP sinaliza", () => {
		expect(queueImagesDropped({ removed: true, imagesDropped: true })).toBe(true);
		expect(queueImagesDropped({ removed: true })).toBe(false);
		expect(queueImagesDropped(null)).toBe(false);
	});

	test("promoção só é confirmada com booleano explícito", () => {
		expect(parsePromoted({ promoted: true })).toBe(true);
		expect(parsePromoted({ promoted: false })).toBe(false);
		expect(parsePromoted({})).toBeNull();
		expect(parsePromoted(null)).toBeNull();
	});

	test("editorText do rewind só vale quando há texto", () => {
		expect(parseEditorText({ cancelled: false, editorText: "mensagem antiga" })).toBe("mensagem antiga");
		expect(parseEditorText({ cancelled: false, editorText: "   " })).toBeNull();
		expect(parseEditorText({ cancelled: false })).toBeNull();
		expect(parseEditorText(null)).toBeNull();
	});
});
