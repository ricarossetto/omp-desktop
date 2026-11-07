import { describe, expect, test } from "bun:test";
import type { DesktopEvent, DesktopRequest, DesktopResult } from "../../src/shared/contracts";
import type { SessionMeta, SessionSnapshot, SessionViewState } from "../../src/shared/session-types";
import { createSessionState } from "../../src/shared/session-state";
import type { AppStore } from "../../src/renderer/store/create-store";
import { createAppStore } from "../../src/renderer/store/create-store";

const WORKSPACE_ID = "ws-events";
const SESSION_ID = "session-events";
const SESSION_PATH = "C:\\sessions\\events.jsonl";

const meta: SessionMeta = {
	isStreaming: false,
	isCompacting: false,
	isSettled: true,
	hasPendingAsyncWork: false,
	sessionName: "Sessão de eventos",
	messageCount: 0,
	todoPhases: [],
	goal: null,
};

function baseState(): SessionViewState {
	const state = createSessionState(WORKSPACE_ID, SESSION_ID);
	return { ...state, generation: 2, sequence: 10, status: "ready", meta };
}

function snapshotOf(state: SessionViewState): SessionSnapshot {
	return { sessionPath: SESSION_PATH, state };
}

interface Harness {
	calls: DesktopRequest[];
	snapshotState: SessionViewState;
	gate: Promise<void> | null;
	rpcResults: Record<string, unknown>;
	imported: number;
	emit(event: DesktopEvent): void;
}

function createHarness(): Harness {
	const calls: DesktopRequest[] = [];
	let listener: ((event: DesktopEvent) => void) | null = null;
	const harness: Harness = {
		calls,
		snapshotState: baseState(),
		gate: null,
		rpcResults: {},
		imported: 0,
		emit(next) {
			listener?.(next);
		},
	};

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
							tabs: [
								{
									workspaceId: WORKSPACE_ID,
									sessionId: SESSION_ID,
									sessionPath: SESSION_PATH,
								},
							],
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
							path: "C:\\projetos\\events",
							name: "events",
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
							title: "Sessão de eventos",
							cwd: "C:\\projetos\\events",
							modified: 1,
							openSessionId: SESSION_ID,
						},
					],
				};
			case "session.snapshot":
				if (harness.gate) await harness.gate;
				return { ok: true, data: snapshotOf(harness.snapshotState) };
			case "session.rpc": {
				const type = request.command.type;
				if (type === "get_session_stats") return { ok: true, data: null };
				return { ok: true, data: harness.rpcResults[type] ?? null };
			}
			case "attachment.import": {
				harness.imported += 1;
				return {
					ok: true,
					data: {
						attachment: {
							attachmentId: `att-${harness.imported}`,
							name: "imagem-restaurada-1.png",
							mimeType: "image/png",
							size: 3,
							kind: "image",
						},
					},
				};
			}
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
	return harness;
}

function event(name: string, sequence: number, data: unknown, patch: Partial<DesktopEvent> = {}): DesktopEvent {
	return {
		kind: "event",
		workspaceId: WORKSPACE_ID,
		sessionId: SESSION_ID,
		generation: 2,
		sequence,
		name,
		data,
		...patch,
	};
}

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

async function startStore(harness: Harness): Promise<{ store: AppStore; cleanup: () => void }> {
	const store = createAppStore();
	const cleanup = store.actions.start();
	await waitForState(store, (current) => Boolean(current.getState().sessionStates[SESSION_ID]));
	return { store, cleanup };
}

describe("eventos que chegam antes do snapshot", () => {
	test("avisos de inicialização são aplicados depois do snapshot, sem resync espúrio", async () => {
		const harness = createHarness();
		const gate = Promise.withResolvers<void>();
		harness.gate = gate.promise;
		const store = createAppStore();
		const cleanup = store.actions.start();

		// `restoringTabs` fica true enquanto o snapshot está retido pelo gate:
		// é o instante em que a sessão ainda não é conhecida.
		await waitForState(store, (current) => current.getState().restoringTabs);
		harness.emit(event("desktop_notice", 11, { level: "warning", text: "aviso de inicialização" }));
		harness.emit(event("desktop_notice", 10, { level: "info", text: "coberto pelo snapshot" }));
		expect(store.getState().sessionRecords[SESSION_ID]).toBeUndefined();

		gate.resolve();
		await waitForState(
			store,
			(current) =>
				(current.getState().sessionStates[SESSION_ID]?.notices ?? []).some(
					(notice) => notice.text === "aviso de inicialização",
				),
		);

		const view = store.getState().sessionStates[SESSION_ID];
		expect(view?.notices.map((notice) => notice.text)).toEqual(["aviso de inicialização"]);
		expect(view?.sequence).toBe(11);
		expect(store.getState().resyncing[SESSION_ID]).not.toBe(true);
		// O buffer não provoca snapshot extra: só o da abertura.
		expect(harness.calls.filter((call) => call.op === "session.snapshot")).toHaveLength(1);
		cleanup();
	});

	test("eventos de geração anterior no buffer são descartados", async () => {
		const harness = createHarness();
		const gate = Promise.withResolvers<void>();
		harness.gate = gate.promise;
		const store = createAppStore();
		const cleanup = store.actions.start();

		await waitForState(store, (current) => current.getState().restoringTabs);
		harness.emit(event("desktop_notice", 11, { level: "info", text: "processo antigo" }, { generation: 1 }));
		gate.resolve();
		await waitForState(store, (current) => Boolean(current.getState().sessionStates[SESSION_ID]));

		expect(store.getState().sessionStates[SESSION_ID]?.notices).toHaveLength(0);
		cleanup();
	});
});

describe("reinício do host", () => {
	test("descarta sessões e reabre as abas sem reenviar prompt", async () => {
		const harness = createHarness();
		const { store, cleanup } = await startStore(harness);
		expect(store.getState().tabs).toEqual([SESSION_ID]);

		harness.emit({
			kind: "event",
			workspaceId: "host",
			generation: 0,
			sequence: 1,
			name: "host.status",
			data: { phase: "starting-host", signed: false },
		});
		expect(store.getState().sessionRecords).toEqual({});
		expect(store.getState().sessionStates).toEqual({});
		expect(store.getState().tabs).toEqual([]);
		expect(store.getState().activeSessionId).toBeNull();

		harness.emit({
			kind: "event",
			workspaceId: "host",
			generation: 0,
			sequence: 2,
			name: "host.status",
			data: { phase: "ready", signed: false },
		});
		await waitForState(store, (current) => Boolean(current.getState().sessionStates[SESSION_ID]));

		expect(store.getState().tabs).toEqual([SESSION_ID]);
		expect(store.getState().activeSessionId).toBe(SESSION_ID);
		expect(harness.calls.filter((call) => call.op === "session.snapshot").length).toBeGreaterThanOrEqual(2);
		expect(
			harness.calls.some(
				(call) => call.op === "session.rpc" && call.command.type === "prompt",
			),
		).toBe(false);
		cleanup();
	});
});

describe("rewind e fila", () => {
	test("navigate_tree devolve editorText para o rascunho", async () => {
		const harness = createHarness();
		harness.rpcResults.navigate_tree = { cancelled: false, editorText: "mensagem antiga" };
		const { store, cleanup } = await startStore(harness);

		const ok = await store.actions.navigateTree(SESSION_ID, "entry-1");
		expect(ok).toBe(true);
		expect(store.getState().drafts[SESSION_ID]?.text).toBe("mensagem antiga");
		expect(store.getState().notices.some((notice) => notice.text.includes("compositor"))).toBe(true);
		cleanup();
	});

	test("remove_queued_message reimporta as imagens e nunca remove orientação já entregue", async () => {
		const harness = createHarness();
		harness.snapshotState = {
			...baseState(),
			queue: { steering: ["entregue", "removível"], followUp: [], liveSteered: 1 },
		};
		harness.rpcResults.remove_queued_message = {
			removed: true,
			images: [{ type: "image", data: btoa("abc"), mimeType: "image/png" }],
		};
		const { store, cleanup } = await startStore(harness);

		await store.actions.removeQueued(SESSION_ID, "removível", "steering");
		expect(store.getState().sessionStates[SESSION_ID]?.queue.steering).toEqual(["entregue"]);
		expect(harness.imported).toBe(1);
		const attachments = store.getState().drafts[SESSION_ID]?.attachments ?? [];
		expect(attachments).toHaveLength(1);
		expect(attachments[0]?.name).toContain("imagem-restaurada");

		const before = harness.calls.filter(
			(call) => call.op === "session.rpc" && call.command.type === "remove_queued_message",
		).length;
		await store.actions.removeQueued(SESSION_ID, "entregue", "steering");
		const after = harness.calls.filter(
			(call) => call.op === "session.rpc" && call.command.type === "remove_queued_message",
		).length;
		expect(after).toBe(before);
		expect(store.getState().sessionStates[SESSION_ID]?.queue.steering).toEqual(["entregue"]);
		expect(
			store.getState().notices.some((notice) => notice.text.includes("já foi entregue ao agente")),
		).toBe(true);
		cleanup();
	});

	test("promote_queued_message com promoted:false mantém a fila e avisa", async () => {
		const harness = createHarness();
		harness.snapshotState = {
			...baseState(),
			queue: { steering: [], followUp: ["depois"], liveSteered: 0 },
		};
		harness.rpcResults.promote_queued_message = { promoted: false };
		const { store, cleanup } = await startStore(harness);

		await store.actions.promoteQueued(SESSION_ID, "depois");
		expect(store.getState().sessionStates[SESSION_ID]?.queue.followUp).toEqual(["depois"]);
		expect(store.getState().sessionStates[SESSION_ID]?.queue.steering).toEqual([]);
		expect(
			store.getState().notices.some((notice) => notice.text.includes("continua na fila")),
		).toBe(true);

		harness.rpcResults.promote_queued_message = { promoted: true };
		await store.actions.promoteQueued(SESSION_ID, "depois");
		expect(store.getState().sessionStates[SESSION_ID]?.queue.followUp).toEqual([]);
		expect(store.getState().sessionStates[SESSION_ID]?.queue.steering).toEqual(["depois"]);
		cleanup();
	});
});
