import { describe, expect, test } from "bun:test";
import type { DesktopEvent, DesktopRequest, DesktopResult } from "../../src/shared/contracts";
import type {
	PendingDialog,
	SessionMeta,
	SessionSnapshot,
	SessionStatus,
} from "../../src/shared/session-types";
import { createSessionState } from "../../src/shared/session-state";
import type { AppStore } from "../../src/renderer/store/create-store";
import { createAppStore } from "../../src/renderer/store/create-store";
import {
	clearDialogsForLostSession,
	isLostSessionStatus,
	unsupportedDialogMethod,
} from "../../src/renderer/store/dialog-state";

const WORKSPACE_ID = "ws-dialogs";
const SESSION_ID = "session-dialogs";
const SESSION_PATH = "C:\\sessions\\dialogs.jsonl";

const meta: SessionMeta = {
	isStreaming: false,
	isCompacting: false,
	isSettled: true,
	hasPendingAsyncWork: false,
	sessionName: "Sessão com diálogo",
	messageCount: 0,
	todoPhases: [],
	goal: null,
};

const pendingDialog: PendingDialog = {
	id: "dialog-1",
	method: "confirm",
	title: "Confirmar alteração",
	message: "A ferramenta quer alterar arquivos.",
	receivedAt: 1_000,
};

function makeSnapshot(options: {
	status?: SessionStatus;
	pendingDialogs?: PendingDialog[];
} = {}): SessionSnapshot {
	const state = createSessionState(WORKSPACE_ID, SESSION_ID);
	return {
		sessionPath: SESSION_PATH,
		state: {
			...state,
			generation: 2,
			sequence: 10,
			status: options.status ?? "ready",
			meta,
			pendingDialogs: options.pendingDialogs ?? [],
		},
	};
}

function event(name: string, sequence: number, data: unknown): DesktopEvent {
	return {
		kind: "event",
		workspaceId: WORKSPACE_ID,
		sessionId: SESSION_ID,
		generation: 2,
		sequence,
		name,
		data,
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

interface Harness {
	calls: DesktopRequest[];
	emit(event: DesktopEvent): void;
	/** Próxima resposta de `session.uiResponse`. */
	nextUiResponse: DesktopResult;
	snapshot: SessionSnapshot;
	/** Quando definido, segura respostas de snapshot até ser liberado. */
	snapshotGate: Promise<void> | null;
}

function createHarness(): Harness {
	const calls: DesktopRequest[] = [];
	let listener: ((event: DesktopEvent) => void) | null = null;
	const harness: Harness = {
		calls,
		snapshot: makeSnapshot(),
		nextUiResponse: { ok: true, data: { delivered: true } },
		snapshotGate: null,
		emit(next: DesktopEvent) {
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
							path: "C:\\projetos\\dialogs",
							name: "dialogs",
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
							title: "Sessão com diálogo",
							cwd: "C:\\projetos\\dialogs",
							modified: 1,
							openSessionId: SESSION_ID,
						},
					],
				};
			case "session.snapshot":
				if (harness.snapshotGate) await harness.snapshotGate;
				return { ok: true, data: harness.snapshot };
			case "session.uiResponse":
				return harness.nextUiResponse;
			case "ui.setState":
				return { ok: true, data: null };
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

async function startStore(harness: Harness): Promise<{ store: AppStore; cleanup: () => void }> {
	const store = createAppStore();
	const cleanup = store.actions.start();
	await waitForState(store, (current) => Boolean(current.getState().sessionStates[SESSION_ID]));
	return { store, cleanup };
}

describe("ciclo de vida dos diálogos", () => {
	test("resposta não entregue não vira sucesso e permite nova tentativa", async () => {
		const harness = createHarness();
		harness.snapshot = makeSnapshot({ pendingDialogs: [pendingDialog] });
		const { store, cleanup } = await startStore(harness);

		harness.nextUiResponse = { ok: true, data: { delivered: false } };
		const first = await store.actions.respondDialog(SESSION_ID, {
			type: "extension_ui_response",
			id: pendingDialog.id,
			confirmed: true,
		});
		expect(first).toBe(false);
		expect(store.getState().notices.some((notice) => notice.text.includes("não foi entregue"))).toBe(true);
		expect(store.getState().sessionStates[SESSION_ID]?.pendingDialogs).toHaveLength(1);

		harness.nextUiResponse = { ok: true, data: { delivered: true } };
		const retry = await store.actions.respondDialog(SESSION_ID, {
			type: "extension_ui_response",
			id: pendingDialog.id,
			confirmed: true,
		});
		expect(retry).toBe(true);
		expect(harness.calls.filter((call) => call.op === "session.uiResponse")).toHaveLength(2);

		cleanup();
	});

	test("desktop_dialog_closed remove o modal pendente", async () => {
		const harness = createHarness();
		harness.snapshot = makeSnapshot({ pendingDialogs: [pendingDialog] });
		const { store, cleanup } = await startStore(harness);
		expect(store.getState().sessionStates[SESSION_ID]?.pendingDialogs).toHaveLength(1);

		harness.emit(event("desktop_dialog_closed", 11, { id: pendingDialog.id, reason: "answered" }));

		await waitForState(
			store,
			(current) => current.getState().sessionStates[SESSION_ID]?.pendingDialogs.length === 0,
		);
		expect(harness.calls.some((call) => call.op === "session.uiResponse")).toBe(false);
		cleanup();
	});

	for (const status of ["closed", "interrupted", "error"] as const) {
		test(`status ${status} descarta pendentes sem enviar resposta`, async () => {
			const harness = createHarness();
			harness.snapshot = makeSnapshot({ pendingDialogs: [pendingDialog] });
			const { store, cleanup } = await startStore(harness);
			expect(store.getState().sessionStates[SESSION_ID]?.pendingDialogs).toHaveLength(1);

			harness.emit(event("session.status", 11, { status }));

			await waitForState(store, (current) => current.getState().sessionStates[SESSION_ID]?.status === status);
			expect(store.getState().sessionStates[SESSION_ID]?.pendingDialogs).toHaveLength(0);
			expect(harness.calls.some((call) => call.op === "session.uiResponse")).toBe(false);
			cleanup();
		});
	}

	test("snapshot de sessão já perdida não reinstala pendentes", async () => {
		const harness = createHarness();
		harness.snapshot = makeSnapshot({ status: "interrupted", pendingDialogs: [pendingDialog] });
		const { store, cleanup } = await startStore(harness);

		const view = store.getState().sessionStates[SESSION_ID];
		expect(view?.status).toBe("interrupted");
		expect(view?.pendingDialogs).toHaveLength(0);
		cleanup();
	});
});

describe("pedidos de diálogo desconhecidos", () => {
	test("avisa e não envia cancelamento duplicado", async () => {
		const harness = createHarness();
		const { store, cleanup } = await startStore(harness);

		harness.emit(
			event("frame", 11, {
				type: "extension_ui_request",
				id: "dialog-raro",
				method: "choose_magic",
				title: "Método que esta interface não conhece",
			}),
		);

		await waitForState(
			store,
			(current) => current.getState().notices.some((notice) => notice.text.includes("choose_magic")),
		);
		expect(store.getState().notices.some((notice) => notice.text.includes("cancelada automaticamente"))).toBe(true);
		expect(harness.calls.some((call) => call.op === "session.uiResponse")).toBe(false);
		cleanup();
	});

	test("avisa mesmo sem sessão registrada, sem responder nada", async () => {
		const harness = createHarness();
		const store = createAppStore();
		const cleanup = store.actions.start();

		harness.emit({
			kind: "event",
			workspaceId: WORKSPACE_ID,
			sessionId: "sessao-que-nao-existe",
			generation: 3,
			sequence: 1,
			name: "frame",
			data: { type: "extension_ui_request", id: "x-1", method: "modo_inexistente" },
		});

		await waitForState(
			store,
			(current) => current.getState().notices.some((notice) => notice.text.includes("modo_inexistente")),
		);
		expect(harness.calls.some((call) => call.op === "session.uiResponse")).toBe(false);
		cleanup();
	});

	test("avisa durante resync e não interfere no buffer", async () => {
		const harness = createHarness();
		const { store, cleanup } = await startStore(harness);

		const gate = Promise.withResolvers<void>();
		harness.snapshotGate = gate.promise;
		const refreshing = store.actions.refreshSnapshot(SESSION_ID);
		await waitForState(store, (current) => current.getState().resyncing[SESSION_ID] === true);

		// Durante o resync o frame desconhecido é avisado e fica no buffer; o
		// cancelamento é responsabilidade do host, não do renderer.
		harness.emit(event("frame", 11, { type: "extension_ui_request", id: "x-2", method: "sem_suporte" }));
		await waitForState(
			store,
			(current) => current.getState().notices.some((notice) => notice.text.includes("sem_suporte")),
		);
		expect(harness.calls.some((call) => call.op === "session.uiResponse")).toBe(false);

		gate.resolve();
		await refreshing;
		expect(
			store
				.getState()
				.notices.filter((notice) => notice.text.includes("sem_suporte")),
		).toHaveLength(1);
		expect(harness.calls.some((call) => call.op === "session.uiResponse")).toBe(false);
		cleanup();
	});
});

describe("helpers puros de diálogo", () => {
	test("status perdido é identificado sem tratar ready/settled como perda", () => {
		expect(isLostSessionStatus("closed")).toBe(true);
		expect(isLostSessionStatus("interrupted")).toBe(true);
		expect(isLostSessionStatus("error")).toBe(true);
		expect(isLostSessionStatus("ready")).toBe(false);
		expect(isLostSessionStatus("settled")).toBe(false);
		expect(isLostSessionStatus("busy")).toBe(false);
	});

	test("clearDialogsForLostSession preserva pendentes em sessão viva", () => {
		const snapshot = makeSnapshot({ pendingDialogs: [pendingDialog] });
		expect(clearDialogsForLostSession(snapshot.state)).toBe(snapshot.state);

		const lost = clearDialogsForLostSession({ ...snapshot.state, status: "interrupted" });
		expect(lost.pendingDialogs).toHaveLength(0);
	});

	test("método desconhecido só é sinalizado para extension_ui_request com id", () => {
		expect(unsupportedDialogMethod({ type: "extension_ui_request", id: "1", method: "novo_metodo" })).toBe(
			"novo_metodo",
		);
		expect(unsupportedDialogMethod({ type: "extension_ui_request", id: "1", method: "confirm" })).toBeNull();
		expect(unsupportedDialogMethod({ type: "extension_ui_request", id: "1", method: "notify" })).toBeNull();
		expect(unsupportedDialogMethod({ type: "extension_ui_request", method: "novo_metodo" })).toBeNull();
		expect(unsupportedDialogMethod({ type: "message_end" })).toBeNull();
		expect(unsupportedDialogMethod(null)).toBeNull();
	});
});
