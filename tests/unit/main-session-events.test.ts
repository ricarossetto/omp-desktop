import { describe, expect, test } from "bun:test";
import {
	buildSessionUnavailableEvent,
	readSnapshotClock,
	SessionEventClock,
} from "../../src/main/session-events";

describe("SessionEventClock", () => {
	test("sequência sintética é sempre posterior ao último evento observado", () => {
		const clock = new SessionEventClock();
		clock.observe("s1", 4, 10);
		expect(clock.next("s1")).toEqual({ generation: 4, sequence: 11 });
		// Evento atrasado (sequência menor) não retrocede o relógio.
		clock.observe("s1", 4, 9);
		expect(clock.next("s1")).toEqual({ generation: 4, sequence: 12 });
	});

	test("nova geração reinicia a sequência e sessão desconhecida começa em 1", () => {
		const clock = new SessionEventClock();
		clock.observe("s1", 1, 7);
		clock.observe("s1", 2, 1);
		expect(clock.next("s1")).toEqual({ generation: 2, sequence: 2 });
		expect(clock.next("nova")).toEqual({ generation: 0, sequence: 1 });
	});

	test("lê geração/sequência de snapshot e ignora formato inválido", () => {
		expect(readSnapshotClock({ state: { generation: 3, sequence: 9 } })).toEqual({
			generation: 3,
			sequence: 9,
		});
		expect(readSnapshotClock({ state: { generation: "3", sequence: 9 } })).toBeUndefined();
		expect(readSnapshotClock({ state: null })).toBeUndefined();
		expect(readSnapshotClock(null)).toBeUndefined();
	});
});

describe("buildSessionUnavailableEvent", () => {
	test("emite session.status terminal com ids e relógio da sessão", () => {
		const event = buildSessionUnavailableEvent(
			{ sessionId: "s1", workspaceId: "w1", sessionPath: "C:\\s.jsonl" },
			{ generation: 5, sequence: 42 },
			"error",
			"O serviço local encerrou.",
		);
		expect(event).toEqual({
			kind: "event",
			workspaceId: "w1",
			sessionId: "s1",
			generation: 5,
			sequence: 42,
			name: "session.status",
			data: { status: "error", error: "O serviço local encerrou." },
		});
	});
});
