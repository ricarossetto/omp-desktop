import { describe, expect, test } from "bun:test";
import type { DesktopEvent, DesktopRequest, DesktopResult } from "../../src/shared/contracts";
import type { SessionMeta, SessionSnapshot } from "../../src/shared/session-types";
import { createSessionState } from "../../src/shared/session-state";
import type { AppStore } from "../../src/renderer/store/create-store";
import { createAppStore } from "../../src/renderer/store/create-store";

const WORKSPACE_ID = "ws-ui";
const SESSION_ID = "session-ui";
const SESSION_PATH = "C:\\sessions\\ui.jsonl";

const meta: SessionMeta = {
	isStreaming: false,
	isCompacting: false,
	isSettled: true,
	hasPendingAsyncWork: false,
	sessionName: "Sessão de teste",
	messageCount: 0,
	todoPhases: [],
	goal: null,
};

function snapshot(): SessionSnapshot {
	const state = createSessionState(WORKSPACE_ID, SESSION_ID);
	return {
		sessionPath: SESSION_PATH,
		state: { ...state, generation: 2, sequence: 10, status: "ready", meta },
	};
}

interface Harness {
	calls: DesktopRequest[];
	emit(event: DesktopEvent): void;
	invoke: (request: DesktopRequest) => Promise<DesktopResult>;
}

function createHarness(): Harness {
	const calls: DesktopRequest[] = [];
	let listener: ((event: DesktopEvent) => void) | null = null;

	const invoke = async (request: DesktopRequest): Promise<DesktopResult> => {
		calls.push(request);
		switch (request.op) {
			case "ui.getState":
				return {
					ok: true,
					data: {
						shell: {
							version: 1,
							layout: {},
							theme: "dark",
							activeWorkspaceId: WORKSPACE_ID,
							tabs: [{ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, sessionPath: SESSION_PATH }],
							activeSessionId: SESSION_ID,
						},
					},
				};
			case "runtime.status":
				return { ok: true, data: { phase: "ready", signed: false } };
			case "workspace.list":
				return {
					ok: true,
					data: [
						{
							workspaceId: WORKSPACE_ID,
							path: "C:\\projetos\\ui",
							name: "ui",
							available: true,
							lastOpenedAt: 1,
						},
					],
				};
			case "session.list":
				return {
					ok: true,
					data: [
						{
							path: SESSION_PATH,
							id: SESSION_ID,
							title: "Sessão de teste",
							cwd: "C:\\projetos\\ui",
							modified: 1,
							openSessionId: SESSION_ID,
						},
					],
				};
			case "session.snapshot":
				return { ok: true, data: snapshot() };
			default:
				return { ok: true, data: null };
		}
	};

	const ompDesktop = {
		invoke,
		subscribe(next: (event: DesktopEvent) => void) {
			listener = next;
			return () => {
				listener = null;
			};
		},
	};
	Object.defineProperty(globalThis, "window", { value: { ompDesktop }, configurable: true, writable: true });

	return {
		calls,
		emit(event) {
			listener?.(event);
		},
		invoke,
	};
}

/** Espera uma notificação do store cujo estado satisfaça o predicado. */
function waitForState(store: AppStore, predicate: (store: AppStore) => boolean): Promise<void> {
	if (predicate(store)) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsubscribe = store.subscribe(() => {
		if (!predicate(store)) return;
		unsubscribe();
		resolve();
	});
	return promise;
}

describe("store do renderer", () => {
	test("restaura aba persistida, aplica evento contíguo, ressincroniza em lacuna e limpa rascunho no ack", async () => {
		const api = createHarness();
		const store = createAppStore();
		const cleanup = store.actions.start();

		await waitForState(store, (current) => Boolean(current.getState().sessionStates[SESSION_ID]));
		expect(store.getState().activeSessionId).toBe(SESSION_ID);
		expect(store.getState().sessionRecords[SESSION_ID]?.title).toBe("Sessão de teste");

		const initialSnapshots = api.calls.filter((call) => call.op === "session.snapshot").length;
		expect(initialSnapshots).toBe(1);

		api.emit({
			kind: "event",
			workspaceId: WORKSPACE_ID,
			sessionId: SESSION_ID,
			generation: 2,
			sequence: 11,
			name: "desktop_notice",
			data: { level: "info", text: "evento contíguo" },
		});
		await waitForState(store, (current) => (current.getState().sessionStates[SESSION_ID]?.notices.length ?? 0) > 0);

		api.emit({
			kind: "event",
			workspaceId: WORKSPACE_ID,
			sessionId: SESSION_ID,
			generation: 2,
			sequence: 14,
			name: "frame",
			data: { type: "noop" },
		});
		await waitForState(
			store,
			(current) => api.calls.filter((call) => call.op === "session.snapshot").length > initialSnapshots,
		);
		await waitForState(store, (current) => current.getState().resyncing[SESSION_ID] !== true);

		store.actions.setDraft(SESSION_ID, "olá");
		const sent = await store.actions.sendPrompt(SESSION_ID, "olá", []);
		expect(sent).toBe(true);
		expect(store.getState().drafts[SESSION_ID]?.text).toBe("");
		expect(store.getState().sending[SESSION_ID]).not.toBe(true);

		cleanup();
	});
});
