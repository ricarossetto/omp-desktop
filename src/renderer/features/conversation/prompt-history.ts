import type { ChatMessage } from "@shared/session-types";

export const PROMPT_HISTORY_LIMIT = 100;

/** Nova entrada no topo; o mesmo texto não duplica. */
export function recordPrompt(
	list: readonly string[],
	text: string,
	limit = PROMPT_HISTORY_LIMIT,
): string[] {
	const trimmed = text.trim();
	if (!trimmed) return list as string[];
	if (list[0] === trimmed) return list as string[];
	return [trimmed, ...list.filter((item) => item !== trimmed)].slice(0, limit);
}

/** Junta prompts antigos do transcript (ordem cronológica) atrás dos já vivos. */
export function mergeOlderPrompts(
	existing: readonly string[],
	older: readonly string[],
	limit = PROMPT_HISTORY_LIMIT,
): string[] {
	const seen = new Set(existing);
	const merged = [...existing];
	for (let index = older.length - 1; index >= 0; index -= 1) {
		const text = older[index]?.trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		merged.push(text);
	}
	return merged.slice(0, limit);
}

/** Prompts digitados pelo usuário, em ordem cronológica. */
export function promptsFromMessages(messages: readonly ChatMessage[]): string[] {
	const prompts: string[] = [];
	for (const message of messages) {
		if (message.role !== "user") continue;
		const text = message.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.filter(Boolean)
			.join("\n")
			.trim();
		if (text) prompts.push(text);
	}
	return prompts;
}

/** Caret colapsado na primeira linha: ↑ começa/continua a recuperação. */
export function caretOnFirstLine(value: string, start: number, end: number): boolean {
	return start === end && (start === 0 || value.lastIndexOf("\n", start - 1) === -1);
}

/** Caret colapsado na última linha: ↓ volta para o rascunho salvo. */
export function caretOnLastLine(value: string, start: number, end: number): boolean {
	return start === end && value.indexOf("\n", end) === -1;
}
