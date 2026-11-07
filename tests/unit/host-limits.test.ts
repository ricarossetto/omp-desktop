import { describe, expect, test } from "bun:test";
import {
	capValue,
	compactHistory,
	compactMessage,
	compactSnapshot,
	jsonBytes,
	MAX_EVENT_BYTES,
	OMITTED_MARKER,
} from "../../src/host/limits";
import { createSessionState } from "../../src/shared/session-state";
import type { ChatMessage, ContentBlock, ToolExecution } from "../../src/shared/session-types";

const BUDGET = 64 * 1024;
const HUGE_TEXT = "x".repeat(5 * 1024 * 1024);

function message(blocks: ContentBlock[], key = "entry:e1"): ChatMessage {
	return { key, role: "assistant", content: blocks, streaming: false };
}

function toolResultMessage(text: string): ChatMessage {
	return {
		key: "entry:e2",
		role: "toolResult",
		content: [{ type: "text", text }],
		toolCallId: "t1",
		toolName: "read",
		streaming: false,
	};
}

function imageMessage(data: string): ChatMessage {
	return message([{ type: "image", mimeType: "image/png", data }], "entry:e3");
}

describe("limites de transporte", () => {
	test("orçamento padrão é 8 MiB e bem abaixo do limite físico de 64 MiB", () => {
		expect(MAX_EVENT_BYTES).toBe(8 * 1024 * 1024);
		expect(MAX_EVENT_BYTES).toBeLessThan(64 * 1024 * 1024);
	});

	test("resultado de ferramenta gigante é truncado com marca explícita e sem mutar o original", () => {
		const original = toolResultMessage(HUGE_TEXT);
		const tool: ToolExecution = {
			toolCallId: "t1",
			name: "read",
			status: "done",
			resultText: HUGE_TEXT,
		};
		const history = compactHistory([original, message([{ type: "text", text: "ok" }])], { t1: tool }, BUDGET);
		expect(jsonBytes({ messages: history.messages, tools: history.tools })).toBeLessThanOrEqual(BUDGET);
		expect(history.truncated).toBe(true);
		const text = history.messages[0].content[0];
		expect(text.type).toBe("text");
		if (text.type === "text") {
			expect(text.text).toContain("conteúdo omitido por tamanho");
			expect(text.text.length).toBeLessThan(HUGE_TEXT.length);
		}
		expect(history.tools.t1.resultTruncated).toBe(true);
		expect(history.tools.t1.resultText?.length ?? 0).toBeLessThan(HUGE_TEXT.length);
		// O dado persistido que o OMP mantém não é alterado por esta projeção.
		expect(original.content[0]).toEqual({ type: "text", text: HUGE_TEXT });
		expect(tool.resultText).toBe(HUGE_TEXT);
	});

	test("imagem enorme vira bloco omitido (nunca base64 cortado)", () => {
		const history = compactHistory([imageMessage("A".repeat(2 * 1024 * 1024))], {}, BUDGET);
		const block = history.messages[0].content[0];
		expect(block.type).toBe("image");
		if (block.type === "image") {
			expect(block.omitted).toBe(true);
			expect(block.data).toBeUndefined();
			expect(block.mimeType).toBe("image/png");
		}
	});

	test("histórico enorme cabe no orçamento e sinaliza mensagens descartadas", () => {
		const messages: ChatMessage[] = [];
		for (let index = 0; index < 4000; index++) {
			messages.push(toolResultMessage(`linha ${index} `.repeat(200)));
		}
		const history = compactHistory(messages, {}, BUDGET);
		const size = jsonBytes({ messages: history.messages, tools: history.tools });
		expect(size).toBeLessThanOrEqual(BUDGET);
		expect(history.messages.length).toBeGreaterThan(0);
		if (history.dropped === 0) {
			expect(history.truncated).toBe(true);
			expect(history.messages[0].content[0]).toMatchObject({ type: "text" });
		} else {
			// Descarta as mais antigas: a última mensagem (mais recente) permanece.
			expect(history.messages.at(-1)?.key).toBe(messages.at(-1)?.key);
		}
	});

	test("com orçamento mínimo o histórico mantém só as mensagens recentes e nunca estoura", () => {
		const messages: ChatMessage[] = Array.from({ length: 200 }, (_, index) =>
			toolResultMessage(`resultado ${index}`),
		);
		const history = compactHistory(messages, {}, 2048);
		expect(jsonBytes({ messages: history.messages, tools: history.tools })).toBeLessThanOrEqual(2048);
		expect(history.dropped).toBeGreaterThan(0);
		expect(history.messages.at(-1)?.key).toBe(messages.at(-1)?.key);
	});

	test("compactMessage preserva conteúdo pequeno sem alterar", () => {
		const small = toolResultMessage("ok");
		const compacted = compactMessage(small, 1024);
		expect(compacted.changed).toBe(false);
		expect(compacted.message).toBe(small);
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
		expect(JSON.stringify(capped)).toContain("conteúdo omitido por tamanho");
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

	test("compactSnapshot limita meta/estatísticas e não estoura o orçamento", () => {
		const state = createSessionState({ workspaceId: "ws", sessionId: "sess", generation: 1 });
		state.messages = [imageMessage("A".repeat(2 * 1024 * 1024))];
		state.meta = {
			isStreaming: false,
			isCompacting: false,
			isSettled: true,
			hasPendingAsyncWork: false,
			messageCount: 1,
			todoPhases: [],
			goal: HUGE_TEXT,
		};
		const snapshot = compactSnapshot({ state, sessionPath: "s.jsonl" }, BUDGET);
		expect(jsonBytes(snapshot)).toBeLessThanOrEqual(BUDGET);
		expect(snapshot.sessionPath).toBe("s.jsonl");
	});

	test("nenhuma linha chega perto de 64 MiB mesmo com entrada de 30 MiB", () => {
		const big = "Ω".repeat(10 * 1024 * 1024); // ~30 MiB em UTF-8
		const history = compactHistory([toolResultMessage(big), imageMessage("B".repeat(9 * 1024 * 1024))], {}, MAX_EVENT_BYTES);
		const size = jsonBytes({ messages: history.messages, tools: history.tools });
		expect(size).toBeLessThanOrEqual(MAX_EVENT_BYTES);
		expect(size).toBeLessThan(64 * 1024 * 1024);
		expect(JSON.stringify(history)).toContain(OMITTED_MARKER.slice(0, 20));
	});
});
