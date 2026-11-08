import { describe, expect, test } from "bun:test";
import { capValue, jsonBytes, MAX_EVENT_BYTES, OMITTED_MARKER } from "../../src/host/limits";

const BUDGET = 64 * 1024;
const HUGE_TEXT = "x".repeat(5 * 1024 * 1024);

describe("limites de transporte", () => {
	test("orçamento padrão é 8 MiB e bem abaixo do limite físico de 64 MiB", () => {
		expect(MAX_EVENT_BYTES).toBe(8 * 1024 * 1024);
		expect(MAX_EVENT_BYTES).toBeLessThan(64 * 1024 * 1024);
	});

	test("capValue preserva payload pequeno por referência", () => {
		const payload = { entries: [{ id: "e1", message: { role: "user", content: "oi" } }] };
		expect(capValue(payload, BUDGET)).toBe(payload);
	});

	test("capValue limita respostas arbitrárias e mantém a marca", () => {
		const payload = {
			entries: Array.from({ length: 50 }, (_, index) => ({
				id: `e${index}`,
				message: { role: "toolResult", content: HUGE_TEXT },
			})),
		};
		const capped = capValue(payload, BUDGET);
		expect(jsonBytes(capped)).toBeLessThanOrEqual(BUDGET);
		expect(JSON.stringify(capped)).toContain(OMITTED_MARKER.slice(0, 20));
	});

	test("imagem dentro de resposta arbitrária é omitida em vez de cortada", () => {
		const capped = capValue(
			{ messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "A".repeat(2_000_000) }] }] },
			BUDGET,
		);
		const text = JSON.stringify(capped);
		expect(text).toContain('"omitted":true');
		expect(text.length).toBeLessThan(2_000_000);
	});
});
