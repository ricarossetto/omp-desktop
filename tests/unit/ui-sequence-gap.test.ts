import { describe, expect, test } from "bun:test";
import type { DesktopEvent } from "../../src/shared/contracts";
import { createSessionState } from "../../src/shared/session-state";
import { classifySessionEvent, isSequenceGap } from "../../src/renderer/store/event-disposition";

function event(patch: Partial<DesktopEvent>): DesktopEvent {
	return {
		kind: "event",
		workspaceId: "ws-1",
		sessionId: "s-1",
		generation: 4,
		sequence: 1,
		name: "frame",
		data: {},
		...patch,
	};
}

function stateAt(generation: number, sequence: number) {
	const state = createSessionState("ws-1", "s-1");
	return { ...state, generation, sequence, status: "ready" as const };
}

describe("classificação de eventos de sessão", () => {
	test("aplica o próximo evento da mesma geração", () => {
		expect(classifySessionEvent(stateAt(4, 10), event({ sequence: 11 }))).toBe("apply");
	});

	test("ignora duplicados e eventos antigos", () => {
		expect(classifySessionEvent(stateAt(4, 10), event({ sequence: 10 }))).toBe("ignore");
		expect(classifySessionEvent(stateAt(4, 10), event({ sequence: 3 }))).toBe("ignore");
	});

	test("detecta lacuna e pede ressincronização", () => {
		const state = stateAt(4, 10);
		expect(classifySessionEvent(state, event({ sequence: 13 }))).toBe("resync");
		expect(isSequenceGap(state, event({ sequence: 13 }))).toBe(true);
		expect(isSequenceGap(state, event({ sequence: 11 }))).toBe(false);
	});

	test("geração nova sempre ressincroniza, mesmo com sequência contígua", () => {
		expect(classifySessionEvent(stateAt(4, 10), event({ generation: 5, sequence: 11 }))).toBe("resync");
	});

	test("snapshot substitui o estado e pode trocar a geração", () => {
		expect(
			classifySessionEvent(stateAt(4, 10), event({ name: "desktop_snapshot", generation: 5, sequence: 1 })),
		).toBe("replace");
	});

	test("status sem geração conhecida não força ressincronização infinita", () => {
		const fresh = stateAt(0, 0);
		expect(classifySessionEvent(fresh, event({ name: "session.status", generation: 3, sequence: 1 }))).toBe(
			"apply",
		);
	});

	test("status de geração diferente em estado vivo pede snapshot", () => {
		expect(classifySessionEvent(stateAt(4, 10), event({ name: "session.status", generation: 5, sequence: 11 }))).toBe(
			"resync",
		);
	});

	test("eventos de outro workspace ou sessão são ignorados", () => {
		expect(classifySessionEvent(stateAt(4, 10), event({ workspaceId: "ws-2", sequence: 11 }))).toBe("ignore");
		expect(classifySessionEvent(stateAt(4, 10), event({ sessionId: "s-2", sequence: 11 }))).toBe("ignore");
	});
});
