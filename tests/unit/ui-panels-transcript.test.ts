import { describe, expect, test } from "bun:test";
import {
	AGENT_STATUS_ICONS,
	AGENT_STATUS_LABELS,
	convertMessage,
	formatDurationSeconds,
	goalStatusLabel,
	mergeTranscript,
	parseTranscriptPage,
	readGoal,
	todoCounts,
	todoStatusIcon,
	todoStatusLabel,
} from "../../src/renderer/features/agents/transcript";

describe("transcript de subagente", () => {
	test("converte blocos intercalados de uma mensagem assistant", () => {
		const item = convertMessage(
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "vou analisar" },
					{ type: "text", text: "Analisando o arquivo." },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
				],
				timestamp: 1234,
			},
			"k1",
		);
		expect(item).not.toBeNull();
		expect(item?.role).toBe("assistant");
		expect(item?.parts.map(part => part.kind)).toEqual(["thinking", "text", "toolCall"]);
		expect(item?.timestamp).toBe(1234);
	});

	test("resultado de ferramenta com erro preserva a marcação", () => {
		const item = convertMessage(
			{
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "comando falhou" }],
				isError: true,
			},
			"k2",
		);
		expect(item?.parts[0]).toEqual({
			kind: "toolResult",
			toolName: "bash",
			text: "comando falhou",
			isError: true,
		});
	});

	test("imagem vira marcador sem despejar base64", () => {
		const item = convertMessage(
			{ role: "user", content: [{ type: "image", data: "AAA", mimeType: "image/png" }] },
			"k3",
		);
		expect(item?.parts[0]).toEqual({ kind: "image", label: "Imagem anexada" });
	});

	test("normaliza page incremental com reset e cursor", () => {
		const page = parseTranscriptPage({
			sessionFile: "child.jsonl",
			fromByte: 10,
			nextByte: 20,
			reset: true,
			messages: [],
		});
		expect(page).toEqual({
			sessionFile: "child.jsonl",
			fromByte: 10,
			nextByte: 20,
			reset: true,
			messages: [],
		});
	});

	test("merge anexa páginas e substitui quando reset", () => {
		const first = parseTranscriptPage({
			sessionFile: "s",
			fromByte: 0,
			nextByte: 10,
			messages: [
				{ role: "user", content: "primeira" },
				{ role: "assistant", content: [{ type: "text", text: "resposta" }] },
			],
		});
		const initial = mergeTranscript([], first, { replace: true });
		expect(initial).toHaveLength(2);

		const second = parseTranscriptPage({
			sessionFile: "s",
			fromByte: 10,
			nextByte: 20,
			messages: [{ role: "assistant", content: [{ type: "text", text: "segunda" }] }],
		});
		const merged = mergeTranscript(initial, second);
		expect(merged).toHaveLength(3);
		expect(merged[2]?.parts[0]).toEqual({ kind: "text", text: "segunda" });

		const reset = parseTranscriptPage({
			sessionFile: "s",
			fromByte: 0,
			nextByte: 30,
			reset: true,
			messages: [{ role: "user", content: "recomeço" }],
		});
		const replaced = mergeTranscript(merged, reset);
		expect(replaced).toHaveLength(1);
		expect(replaced[0]?.parts[0]).toEqual({ kind: "text", text: "recomeço" });
	});

	test("merge não duplica a mesma página", () => {
		const page = parseTranscriptPage({
			sessionFile: "s",
			fromByte: 5,
			nextByte: 9,
			messages: [{ role: "user", content: "eco" }],
		});
		const once = mergeTranscript([], page);
		expect(mergeTranscript(once, page)).toHaveLength(1);
	});
});

describe("agentes, tarefas e objetivo", () => {
	test("rótulos e ícones de todos os estados", () => {
		expect(AGENT_STATUS_LABELS.running).toBe("Em execução");
		expect(AGENT_STATUS_ICONS.failed).toBe("failed");
		expect(todoStatusLabel("in_progress")).toBe("Em andamento");
		expect(todoStatusLabel("desconhecido")).toContain("desconhecido");
		expect(todoStatusIcon("blocked")).toBe("blocked");
		expect(todoStatusIcon("abandoned")).toBe("aborted");
	});

	test("conta tarefas por fase", () => {
		expect(
			todoCounts([
				{
					name: "A",
					tasks: [
						{ content: "1", status: "completed" },
						{ content: "2", status: "blocked" },
					],
				},
				{ name: "B", tasks: [{ content: "3", status: "completed" }] },
			]),
		).toEqual({ total: 3, done: 2 });
	});

	test("lê goal direto e envelope, mantendo ausência de modelo/orçamento", () => {
		const direct = readGoal({
			id: "g1",
			objective: "concluir",
			status: "active",
			tokensUsed: 10,
			timeUsedSeconds: 65,
		});
		expect(direct?.objective).toBe("concluir");
		expect(direct?.tokenBudget).toBeUndefined();
		expect(formatDurationSeconds(direct?.timeUsedSeconds)).toBe("1 min");

		const nested = readGoal({ goal: { objective: "nested", status: "paused" }, state: { enabled: true } });
		expect(nested?.objective).toBe("nested");
		expect(goalStatusLabel("budget-limited")).toContain("orçamento");
		expect(readGoal({ status: "active" })).toBeNull();
		expect(readGoal(null)).toBeNull();
	});
});
