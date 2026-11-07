import { describe, expect, test } from "bun:test";
import type { DesktopEvent } from "../../src/shared/contracts";
import { applyEvent, createSessionState, isGap } from "../../src/shared/session-state";
import type { SessionViewState } from "../../src/shared/session-types";

const WORKSPACE = "ws_test";
const SESSION = "s_test";
const GEN = 7;

function initial(): SessionViewState {
	return createSessionState({ workspaceId: WORKSPACE, sessionId: SESSION, generation: GEN });
}

function next(state: SessionViewState, name: string, data: unknown): SessionViewState {
	const event: DesktopEvent = {
		kind: "event",
		workspaceId: WORKSPACE,
		sessionId: SESSION,
		generation: GEN,
		sequence: state.sequence + 1,
		name,
		data,
	};
	return applyEvent(state, event);
}

function frame(state: SessionViewState, data: Record<string, unknown>): SessionViewState {
	return next(state, "frame", data);
}

const assistantFinal = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "pensando" },
		{ type: "text", text: "Pronto." },
		{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a.txt" } },
	],
	provider: "fake",
	model: "model-x",
	usage: { input: 3, output: 4, totalTokens: 7, cost: { total: 0.001 } },
	stopReason: "endTurn",
	timestamp: 1,
};

describe("session-state", () => {
	test("deltas completos repetidos produzem uma única mensagem e custo só de desktop_stats", () => {
		let state = initial();
		state = frame(state, {
			type: "message_start",
			messageId: "m1",
			message: { role: "assistant", content: [] },
		});
		state = frame(state, {
			type: "message_update",
			messageId: "m1",
			message: assistantFinal,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Pronto." },
		});
		state = frame(state, {
			type: "message_update",
			messageId: "m1",
			message: assistantFinal,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Pronto." },
		});
		state = frame(state, {
			type: "message_update",
			messageId: "m1",
			message: assistantFinal,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Pronto." },
		});
		state = frame(state, { type: "message_end", messageId: "m1", message: assistantFinal });
		state = frame(state, {
			type: "agent_end",
			messages: [assistantFinal],
			isTerminal: false,
			yielded: false,
		});
		state = next(state, "desktop_stats", {
			cost: 0.42,
			tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
		});

		expect(state.messages).toHaveLength(1);
		const message = state.messages[0];
		expect(message.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
		const text = message.content.find((block) => block.type === "text");
		expect(text && text.type === "text" ? text.text : "").toBe("Pronto.");
		expect(message.streaming).toBe(false);
		expect(message.usage?.cost?.total).toBe(0.001);
		expect(state.stats?.costUsd).toBe(0.42);
		expect(state.stats?.tokens?.total).toBe(15);
		// agent_end não torna a sessão ociosa.
		expect(state.status).not.toBe("settled");
	});

	test("message_end é autoritativo e não duplica conteúdo parcial", () => {
		let state = initial();
		state = frame(state, { type: "message_start", messageId: "m", message: { role: "assistant", content: [] } });
		state = frame(state, {
			type: "message_update",
			messageId: "m",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
			message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
		});
		state = frame(state, {
			type: "message_end",
			messageId: "m",
			message: { role: "assistant", content: [{ type: "text", text: "Hello" }], usage: { output: 2 } },
		});
		expect(state.messages).toHaveLength(1);
		const block = state.messages[0].content[0];
		expect(block.type === "text" ? block.text : "").toBe("Hello");
		expect(state.messages[0].usage?.output).toBe(2);
	});

	test("contexto 3.2 permanece 3.2% e session_settled define ociosidade", () => {
		let state = initial();
		state = next(state, "desktop_state", {
			isStreaming: false,
			isSettled: false,
			contextUsage: { tokens: 6400, contextWindow: 200000, percent: 3.2 },
			queuedMessages: { steering: ["a"], followUp: [], liveSteered: 0 },
		});
		expect(state.meta?.contextPercent).toBe(3.2);
		expect(state.meta?.contextTokens).toBe(6400);
		expect(state.queue.steering).toEqual(["a"]);
		state = frame(state, { type: "agent_end", messages: [], isTerminal: true, yielded: true });
		expect(state.status).not.toBe("settled");
		state = frame(state, { type: "session_settled" });
		expect(state.status).toBe("settled");
		expect(state.meta?.isSettled).toBe(true);
	});

	test("ask multi-pergunta, cancel só remove o targetId e open_url vira aviso", () => {
		let state = initial();
		state = frame(state, {
			type: "extension_ui_request",
			id: "ask-1",
			method: "ask",
			questions: [
				{ id: "q1", question: "Um?", options: [{ label: "a" }, { label: "b" }] },
				{ id: "q2", question: "Vários?", options: [{ label: "x" }, { label: "y" }], multi: true },
			],
		});
		expect(state.pendingDialogs).toHaveLength(1);
		expect(state.pendingDialogs[0].method).toBe("ask");
		expect(state.pendingDialogs[0].questions).toHaveLength(2);
		expect(state.pendingDialogs[0].questions?.[1].multi).toBe(true);
		state = frame(state, { type: "extension_ui_request", id: "sel-1", method: "select", title: "Escolha", options: ["a"] });
		expect(state.pendingDialogs).toHaveLength(2);
		state = frame(state, { type: "extension_ui_request", id: "cancel-1", method: "cancel", targetId: "ask-1" });
		expect(state.pendingDialogs).toHaveLength(1);
		expect(state.pendingDialogs[0].id).toBe("sel-1");
		state = frame(state, {
			type: "extension_ui_request",
			id: "url-1",
			method: "open_url",
			url: "https://example.com/auth",
			instructions: "Abra no navegador",
		});
		expect(state.pendingDialogs).toHaveLength(1);
		expect(state.notices.some((notice) => notice.text.includes("https://example.com/auth"))).toBe(true);
		state = frame(state, { type: "extension_ui_request", id: "n-1", method: "notify", message: "Aviso", notifyType: "warning" });
		expect(state.notices.at(-1)?.level).toBe("warning");
	});

	test("subagente: evento + snapshot = uma linha; finalizado é mantido e modelo efetivo não é inferido", () => {
		let state = initial();
		state = frame(state, {
			type: "subagent_lifecycle",
			payload: {
				id: "sub-1",
				index: 0,
				agent: "runner",
				status: "started",
				parentToolCallId: "tool-1",
				sessionFile: "C:/tmp/parent/sub-1.jsonl",
			},
		});
		expect(state.agents).toHaveLength(1);
		expect(state.agents[0].status).toBe("running");
		expect(state.agents[0].effectiveModel).toBeUndefined();
		state = frame(state, {
			type: "subagent_progress",
			payload: {
				id: "sub-1",
				index: 0,
				agent: "runner",
				parentToolCallId: "tool-1",
				progress: { id: "sub-1", status: "running", resolvedModel: "fake/runner:max" },
			},
		});
		expect(state.agents).toHaveLength(1);
		expect(state.agents[0].effectiveModel).toBe("fake/runner:max");
		state = next(state, "desktop_agents", { agents: [] });
		expect(state.agents).toHaveLength(1);
		state = frame(state, {
			type: "subagent_lifecycle",
			payload: { id: "sub-1", index: 0, agent: "runner", status: "completed", parentToolCallId: "tool-1" },
		});
		expect(state.agents).toHaveLength(1);
		expect(state.agents[0].finalized).toBe(true);
		expect(state.agents[0].status).toBe("completed");
		state = next(state, "desktop_agents", { agents: [] });
		expect(state.agents).toHaveLength(1);
		expect(state.agents[0].finalized).toBe(true);
	});

	test("fila, tarefas, goal e thinking acompanham os frames", () => {
		let state = initial();
		state = frame(state, { type: "queue_update", steering: ["agora"], followUp: ["depois"], liveSteered: 1 });
		expect(state.queue).toEqual({ steering: ["agora"], followUp: ["depois"], liveSteered: 1 });
		state = frame(state, {
			type: "todo_reminder",
			todos: [{ content: "fazer", status: "in_progress" }],
			attempt: 1,
			maxAttempts: 2,
		});
		expect(state.meta?.todoPhases[0].tasks[0].content).toBe("fazer");
		state = frame(state, { type: "todo_auto_clear" });
		expect(state.meta?.todoPhases).toEqual([]);
		state = frame(state, { type: "goal_updated", goal: { objective: "entregar" } });
		expect(state.meta?.goal).toBeTruthy();
		state = frame(state, { type: "thinking_level_changed", thinkingLevel: "high" });
		expect(state.meta?.thinkingLevel).toBe("high");
	});

	test("identidade, duplicata e lacuna", () => {
		let state = initial();
		const before = state;
		const other = applyEvent(state, {
			kind: "event",
			workspaceId: "outro",
			sessionId: SESSION,
			generation: GEN,
			sequence: 1,
			name: "frame",
			data: { type: "session_settled" },
		});
		expect(other).toBe(before);
		state = frame(state, { type: "session_settled" });
		expect(state.sequence).toBe(1);
		const duplicate = applyEvent(state, {
			kind: "event",
			workspaceId: WORKSPACE,
			sessionId: SESSION,
			generation: GEN,
			sequence: 1,
			name: "frame",
			data: { type: "session_settled" },
		});
		expect(duplicate).toBe(state);
		const gapEvent = {
			kind: "event",
			workspaceId: WORKSPACE,
			sessionId: SESSION,
			generation: GEN,
			sequence: 5,
			name: "frame",
			data: {},
		} satisfies DesktopEvent;
		expect(isGap(state, gapEvent)).toBe(true);
		expect(isGap(state, { ...gapEvent, sequence: 2 })).toBe(false);
	});

	test("prompt_result com erro notifica e encerra o prompt", () => {
		let state = initial();
		state = next(state, "desktop_prompt", { promptId: "p1", status: "sent" });
		state = next(state, "desktop_prompt", { promptId: "p1", status: "acked" });
		state = frame(state, {
			type: "prompt_result",
			id: "p1",
			agentInvoked: true,
			status: "error",
			error: { message: "falhou" },
			sessionSettled: true,
		});
		expect(state.prompts.p1.status).toBe("error");
		expect(state.status).toBe("settled");
		expect(state.notices.at(-1)?.level).toBe("error");
	});

	test("snapshot substitui o estado inteiro e troca a geração", () => {
		let state = initial();
		state = frame(state, { type: "session_settled" });
		const event: DesktopEvent = {
			kind: "event",
			workspaceId: WORKSPACE,
			sessionId: SESSION,
			generation: GEN + 1,
			sequence: 9,
			name: "desktop_snapshot",
			data: {
				state: {
					...createSessionState({ workspaceId: WORKSPACE, sessionId: SESSION, generation: GEN + 1 }),
					status: "settled",
					sequence: 0,
					messages: [
						{
							key: "entry:e1",
							entryId: "e1",
							role: "user",
							content: [{ type: "text", text: "oi" }],
							streaming: false,
						},
					],
				},
				sessionPath: "C:/tmp/s.jsonl",
			},
		};
		state = applyEvent(state, event);
		expect(state.generation).toBe(GEN + 1);
		expect(state.sequence).toBe(9);
		expect(state.messages).toHaveLength(1);
		expect(state.status).toBe("settled");
	});

	test("status terminal limpa diálogos pendentes (queda do host não deixa aprovação órfã)", () => {
		let state = initial();
		state = frame(state, {
			type: "extension_ui_request",
			id: "d1",
			method: "confirm",
			title: "Aprovar?",
			message: "execute",
		});
		state = frame(state, {
			type: "extension_ui_request",
			id: "d2",
			method: "select",
			title: "Escolha",
			options: ["a", "b"],
		});
		expect(state.pendingDialogs).toHaveLength(2);
		state = next(state, "desktop_status", { status: "interrupted", error: "OMP caiu" });
		expect(state.pendingDialogs).toHaveLength(0);
		expect(state.status).toBe("interrupted");

		let second = initial();
		second = frame(second, { type: "extension_ui_request", id: "d3", method: "confirm", title: "x", message: "y" });
		second = next(second, "session.status", { status: "closed" });
		expect(second.pendingDialogs).toHaveLength(0);
	});

	test("desktop_dialog_closed remove somente o diálogo alvo", () => {
		let state = initial();
		state = frame(state, { type: "extension_ui_request", id: "d1", method: "confirm", title: "a", message: "b" });
		state = frame(state, { type: "extension_ui_request", id: "d2", method: "input", title: "c" });
		state = next(state, "desktop_dialog_closed", { id: "d1", reason: "answered" });
		expect(state.pendingDialogs.map((dialog) => dialog.id)).toEqual(["d2"]);
	});
});
