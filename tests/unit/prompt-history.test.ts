import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "../../src/shared/session-types";
import {
	caretOnFirstLine,
	caretOnLastLine,
	mergeOlderPrompts,
	promptsFromMessages,
	recordPrompt,
} from "../../src/renderer/features/conversation/prompt-history";

function message(role: ChatMessage["role"], text: string): ChatMessage {
	return {
		key: `${role}:${text}`,
		role,
		content: [{ type: "text", text }],
		streaming: false,
	};
}

describe("prompt history", () => {
	test("recordPrompt coloca o mais novo no topo e não duplica", () => {
		expect(recordPrompt([], "a")).toEqual(["a"]);
		const list = ["a"];
		expect(recordPrompt(list, "a")).toBe(list);
		expect(recordPrompt(["a", "b"], "b")).toEqual(["b", "a"]);
		expect(recordPrompt(["a"], "  ")).toEqual(["a"]);
		expect(recordPrompt(["a", "b", "c"], "d", 2)).toEqual(["d", "a"]);
	});

	test("mergeOlderPrompts anexa o transcript atrás e deduplica", () => {
		expect(mergeOlderPrompts(["b"], ["a", "b", "c"])).toEqual(["b", "c", "a"]);
		expect(mergeOlderPrompts(["c"], ["a", "b", "c"])).toEqual(["c", "b", "a"]);
		expect(mergeOlderPrompts([], [])).toEqual([]);
	});

	test("promptsFromMessages usa só mensagens do usuário, em ordem", () => {
		expect(
			promptsFromMessages([
				message("user", "primeira"),
				message("assistant", "resposta"),
				message("user", "segunda"),
			]),
		).toEqual(["primeira", "segunda"]);
	});

	test("caret nas bordas controla o recall", () => {
		expect(caretOnFirstLine("abc", 0, 0)).toBe(true);
		expect(caretOnFirstLine("a\nb", 2, 2)).toBe(false);
		expect(caretOnFirstLine("a\nb", 0, 0)).toBe(true);
		expect(caretOnLastLine("a\nb", 3, 3)).toBe(true);
		expect(caretOnLastLine("a\nb", 1, 1)).toBe(false);
		expect(caretOnFirstLine("abc", 0, 1)).toBe(false);
	});
});
