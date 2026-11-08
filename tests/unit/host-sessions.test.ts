import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DesktopEvent } from "../../src/shared/contracts";
import { isRecord } from "../../src/shared/session-state";
import { AttachmentStore } from "../../src/host/attachments";
import { jsonBytes, MAX_EVENT_BYTES } from "../../src/host/limits";
import { HostLogger } from "../../src/host/log";
import { SettingsService } from "../../src/host/settings";
import { SessionError, SessionsService } from "../../src/host/sessions";
import { WorkspaceStore } from "../../src/host/workspaces";

const FAKE_OMP = path.resolve(import.meta.dir, "../fixtures/fake-omp.ts");

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from("fake-png-body"),
]);

async function recordLines(file: string): Promise<Array<Record<string, unknown>>> {
	try {
		const text = await fs.promises.readFile(file, "utf8");
		return text
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

function uiResponseNotice(idPrefix: string): (event: DesktopEvent) => boolean {
	return (event) =>
		event.name === "frame" &&
		typeof event.data === "object" &&
		event.data !== null &&
		(event.data as { type?: string }).type === "notice" &&
		String((event.data as { message?: string }).message ?? "") === `ui_response:${idPrefix}`;
}

class EventBus {
	readonly events: DesktopEvent[] = [];
	private readonly waiters: Array<{ predicate: (event: DesktopEvent) => boolean; resolve: (event: DesktopEvent) => void }> = [];

	emit(event: DesktopEvent): void {
		this.events.push(event);
		for (let index = this.waiters.length - 1; index >= 0; index--) {
			const waiter = this.waiters[index];
			if (!waiter.predicate(event)) continue;
			this.waiters.splice(index, 1);
			waiter.resolve(event);
		}
	}

	wait(predicate: (event: DesktopEvent) => boolean): Promise<DesktopEvent> {
		const found = this.events.find(predicate);
		if (found) return Promise.resolve(found);
		const deferred = Promise.withResolvers<DesktopEvent>();
		this.waiters.push({ predicate, resolve: deferred.resolve });
		return deferred.promise;
	}
}

interface Harness {
	dataDir: string;
	workspaceDir: string;
	workspaceId: string;
	sessionFile: string;
	sessionFiles: string[];
	bus: EventBus;
	sessions: SessionsService;
	workspaces: WorkspaceStore;
	attachments: AttachmentStore;
}

const harnesses: Harness[] = [];

type LeaseMode = "ok" | "held" | "unavailable" | "unknown";

async function createHarness(options: {
	scenario: string;
	env?: Record<string, string | undefined>;
	held?: boolean;
	lease?: LeaseMode;
	requestTimeoutMs?: number;
	entries?: unknown;
	sessionCount?: number;
	defaultProfile?: string;
	onListSessions?: (profile?: string) => void;
}): Promise<Harness> {
	const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-host-data-"));
	const workspaceDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-host-ws-"));
	const sessionFile = path.join(dataDir, "fake-session.jsonl");
	const sessionFiles = [sessionFile];
	for (let index = 1; index < (options.sessionCount ?? 1); index++) {
		sessionFiles.push(path.join(dataDir, `fake-session-${index}.jsonl`));
	}
	for (const file of sessionFiles) await fs.promises.writeFile(file, "", "utf8");
	let entriesPath: string | undefined;
	if (options.entries !== undefined) {
		entriesPath = path.join(dataDir, "entries.json");
		await fs.promises.writeFile(entriesPath, JSON.stringify(options.entries), "utf8");
	}
	const logger = new HostLogger(dataDir);
	const workspaces = new WorkspaceStore(dataDir);
	await workspaces.load();
	const workspace = await workspaces.add(workspaceDir);
	const attachments = new AttachmentStore(dataDir);
	const settings = new SettingsService(() => ({ ompPath: FAKE_OMP }));
	const bus = new EventBus();
	const leaseMode: LeaseMode = options.lease ?? (options.held ? "held" : "ok");
	const sessions = new SessionsService({
		workspaces,
		attachments,
		settings,
		dataDir,
		ompPath: FAKE_OMP,
		defaultProfile: options.defaultProfile,
		requestTimeoutMs: options.requestTimeoutMs,
		env: {
			FAKE_OMP_SCENARIO: options.scenario,
			FAKE_OMP_SESSION_FILE: sessionFile,
			...(entriesPath ? { FAKE_OMP_ENTRIES: entriesPath } : {}),
			...options.env,
		},
		emit: (event) => bus.emit(event),
		log: logger,
		listSessions: async (_cwd, profile) => {
			options.onListSessions?.(profile);
			return sessionFiles.map((file, index) => ({
				path: file,
				id: index === 0 ? "fake-session" : `fake-session-${index}`,
				title: index === 0 ? "Sessão fake" : `Sessão fake ${index}`,
				cwd: workspaceDir,
				modified: Date.now(),
				messageCount: 0,
			}));
		},
		leaseProbe: async () => {
			if (leaseMode === "unavailable") {
				return {
					held: [],
					unknown: [],
					verified: false,
					reason: "comando de lease indisponível nesta versão",
				};
			}
			if (leaseMode === "unknown") return { held: [], unknown: ["fake-session"], verified: true };
			return { held: leaseMode === "held" ? ["fake-session"] : [], unknown: [], verified: true };
		},
	});
	const harness: Harness = {
		dataDir,
		workspaceDir,
		workspaceId: workspace.workspaceId,
		sessionFile,
		sessionFiles,
		bus,
		sessions,
		workspaces,
		attachments,
	};
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.sessions.closeAll().catch(() => undefined);
		await fs.promises.rm(harness.dataDir, { recursive: true, force: true }).catch(() => undefined);
		await fs.promises.rm(harness.workspaceDir, { recursive: true, force: true }).catch(() => undefined);
	}
});

describe("SessionsService", () => {
	test("cria sessão com snapshot idle, histórico por entryId e estatísticas", async () => {
		const entries = {
			leafId: "e3",
			entries: [
				{
					type: "message",
					id: "e1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "oi", timestamp: 1 },
				},
				{
					type: "message",
					id: "e2",
					parentId: "e1",
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "lendo" },
							{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
						],
						provider: "fake",
						model: "fake-model",
						usage: { input: 1, output: 2, totalTokens: 3 },
						stopReason: "endTurn",
						timestamp: 2,
					},
				},
				{
					type: "message",
					id: "e3",
					parentId: "e2",
					timestamp: "2026-01-01T00:00:02.000Z",
					message: {
						role: "toolResult",
						toolCallId: "t1",
						toolName: "read",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 3,
					},
				},
			],
		};
		const harness = await createHarness({ scenario: "basic", entries });
		const snapshot = await harness.sessions.create(harness.workspaceId);
		expect(snapshot.sessionPath).toBe(harness.sessionFile);
		expect(snapshot.state.messages.map((message) => message.key)).toEqual([
			"entry:e1",
			"entry:e2",
			"entry:e3",
		]);
		expect(snapshot.state.messages[1].content[1].type).toBe("toolCall");
		expect(snapshot.state.tools.t1?.status).toBe("done");
		expect(snapshot.state.tools.t1?.resultText).toBe("ok");
		expect(snapshot.state.stats?.costUsd).toBe(0.42);
		expect(snapshot.state.meta?.contextPercent).toBe(3.2);
		expect(snapshot.state.status).toBe("settled");
	});

	test("prompt emite session.status busy antes da resposta do rpc", async () => {
		// O main acompanha ocupação por evento (não marca busy depois da
		// resposta): o busy precisa existir antes do ack para que um
		// prompt_result/session_settled que chegue no mesmo chunk não seja
		// desfeito por uma marca tardia.
		const harness = await createHarness({ scenario: "stream" });
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const eventsBefore = harness.bus.events.length;
		let eventsAtResponse = -1;
		const rpc = harness.sessions
			.rpc({
				workspaceId: harness.workspaceId,
				sessionId: snapshot.state.sessionId,
				command: { type: "prompt", message: "oi" },
			})
			.then((result) => {
				eventsAtResponse = harness.bus.events.length;
				return result;
			});
		await rpc;
		const busyIndex = harness.bus.events.findIndex(
			(event, index) =>
				index >= eventsBefore &&
				event.name === "session.status" &&
				isRecord(event.data) &&
				event.data.status === "busy",
		);
		expect(busyIndex).toBeGreaterThanOrEqual(0);
		expect(busyIndex).toBeLessThan(eventsAtResponse);
	});

	test("pergunta ask multi-pergunta é respondida e não aceita segunda resposta", async () => {
		const record = path.join(os.tmpdir(), `fake-ask-${Date.now()}.log`);
		const harness = await createHarness({
			scenario: "ask",
			env: { FAKE_OMP_RECORD: record },
		});
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const sessionId = snapshot.state.sessionId;
		const askEvent = harness.bus.wait(
			(event) =>
				event.name === "frame" &&
				typeof event.data === "object" &&
				event.data !== null &&
				(event.data as { type?: string }).type === "extension_ui_request" &&
				(event.data as { method?: string }).method === "ask",
		);
		await harness.sessions.rpc({
			workspaceId: harness.workspaceId,
			sessionId,
			command: { type: "prompt", message: "pergunte" },
		});
		const frame = (await askEvent).data as { id: string };
		const current = await harness.sessions.snapshot(harness.workspaceId, sessionId);
		expect(current.state.pendingDialogs).toHaveLength(1);
		expect(current.state.pendingDialogs[0].questions).toHaveLength(2);
		const recorded = harness.bus.wait(uiResponseNotice(frame.id));

		const delivered = await harness.sessions.uiResponse({
			workspaceId: harness.workspaceId,
			sessionId,
			response: {
				type: "extension_ui_response",
				id: frame.id,
				answers: [
					{ id: "q1", selectedOptions: ["a.txt"], customInput: "livre" },
					{ id: "q2", selectedOptions: ["alpha", "beta"] },
				],
			},
		});
		expect(delivered).toEqual({ delivered: true });
		const duplicate = await harness.sessions.uiResponse({
			workspaceId: harness.workspaceId,
			sessionId,
			response: { type: "extension_ui_response", id: frame.id, value: "duas vezes" },
		});
		expect(duplicate).toEqual({ delivered: false });
		const after = await harness.sessions.snapshot(harness.workspaceId, sessionId);
		expect(after.state.pendingDialogs).toHaveLength(0);
		await recorded;
		const lines = (await fs.promises.readFile(record, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const responses = lines.filter((line) => line.type === "ui_response");
		expect(responses).toHaveLength(1);
		const response = responses[0].response as {
			answers?: Array<{ id: string; selectedOptions: string[]; customInput?: string }>;
		};
		expect(response.answers).toEqual([
			{ id: "q1", selectedOptions: ["a.txt"], customInput: "livre" },
			{ id: "q2", selectedOptions: ["alpha", "beta"] },
		]);
	});

	test("queda do OMP interrompe a sessão, preserva transcript e não reenvia prompt", async () => {
		const record = path.join(os.tmpdir(), `fake-crash-${Date.now()}.log`);
		const harness = await createHarness({
			scenario: "crash",
			env: { FAKE_OMP_RECORD: record },
		});
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const sessionId = snapshot.state.sessionId;
		const interrupted = harness.bus.wait(
			(event) =>
				event.name === "session.status" &&
				typeof event.data === "object" &&
				event.data !== null &&
				(event.data as { status?: string }).status === "interrupted",
		);
		await harness.sessions.rpc({
			workspaceId: harness.workspaceId,
			sessionId,
			command: { type: "prompt", message: "execute uma vez" },
		});
		await interrupted;
		const after = await harness.sessions.snapshot(harness.workspaceId, sessionId);
		expect(after.state.status).toBe("interrupted");
		const prompt = Object.values(after.state.prompts)[0];
		expect(prompt.status).toBe("interrupted");
		let failure: unknown;
		try {
			await harness.sessions.rpc({
				workspaceId: harness.workspaceId,
				sessionId,
				command: { type: "get_state" },
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SessionError);
		expect((failure as SessionError).code).toBe("HOST_EXITED");
		const prompts = (await fs.promises.readFile(record, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((line) => line.type === "prompt");
		expect(prompts).toHaveLength(1);
	});

	test("sessão ocupada por outro processo não é tomada à força", async () => {
		const harness = await createHarness({ scenario: "basic", held: true });
		let failure: unknown;
		try {
			await harness.sessions.open(harness.workspaceId, harness.sessionFile);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SessionError);
		expect((failure as SessionError).code).toBe("SESSION_LOCKED");
	});

	test("lista sessões do inventário com estado de abertura", async () => {
		const harness = await createHarness({ scenario: "basic" });
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const list = await harness.sessions.list(harness.workspaceId);
		expect(list).toHaveLength(1);
		expect(list[0].path).toBe(harness.sessionFile);
		expect(list[0].title).toBe("Sessão fake");
		expect(list[0].openSessionId).toBe(snapshot.state.sessionId);
	});

	test("lease indisponível bloqueia a abertura e a lista fica indefinida (fail-closed)", async () => {
		const harness = await createHarness({ scenario: "basic", lease: "unavailable" });
		let failure: unknown;
		try {
			await harness.sessions.open(harness.workspaceId, harness.sessionFile);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SessionError);
		expect((failure as SessionError).code).toBe("SESSION_LOCKED");
		expect((failure as SessionError).message).toContain("Não foi possível verificar se a sessão está em uso");
		const list = await harness.sessions.list(harness.workspaceId);
		expect(list[0].locked).toBeUndefined();
		expect(list[0].openSessionId).toBeUndefined();
	});

	test("lease com posse desconhecida também não abre a sessão", async () => {
		const harness = await createHarness({ scenario: "basic", lease: "unknown" });
		let failure: unknown;
		try {
			await harness.sessions.open(harness.workspaceId, harness.sessionFile);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SessionError);
		expect((failure as SessionError).code).toBe("SESSION_LOCKED");
		const list = await harness.sessions.list(harness.workspaceId);
		expect(list[0].locked).toBeUndefined();
	});

	test("resposta de select/confirm: opção fora da lista é recusada e só uma resposta é enviada", async () => {
		const record = path.join(os.tmpdir(), `fake-dialogs-${Date.now()}.log`);
		const harness = await createHarness({ scenario: "dialogs", env: { FAKE_OMP_RECORD: record } });
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const sessionId = snapshot.state.sessionId;
		const selectEvent = harness.bus.wait(
			(event) =>
				event.name === "frame" &&
				typeof event.data === "object" &&
				event.data !== null &&
				(event.data as { type?: string }).type === "extension_ui_request" &&
				(event.data as { method?: string }).method === "select",
		);
		const confirmEvent = harness.bus.wait(
			(event) =>
				event.name === "frame" &&
				typeof event.data === "object" &&
				event.data !== null &&
				(event.data as { type?: string }).type === "extension_ui_request" &&
				(event.data as { method?: string }).method === "confirm",
		);
		await harness.sessions.rpc({ workspaceId: harness.workspaceId, sessionId, command: { type: "prompt", message: "pergunte" } });
		const selectId = ((await selectEvent).data as { id: string }).id;
		const confirmId = ((await confirmEvent).data as { id: string }).id;
		const confirmNotice = harness.bus.wait(uiResponseNotice(confirmId));
		let current = await harness.sessions.snapshot(harness.workspaceId, sessionId);
		expect(current.state.pendingDialogs).toHaveLength(2);

		let invalid: unknown;
		try {
			await harness.sessions.uiResponse({
				workspaceId: harness.workspaceId,
				sessionId,
				response: { type: "extension_ui_response", id: selectId, value: "opção inventada" },
			});
		} catch (error) {
			invalid = error;
		}
		expect(invalid).toBeInstanceOf(SessionError);
		expect((invalid as SessionError).code).toBe("INVALID_REQUEST");
		current = await harness.sessions.snapshot(harness.workspaceId, sessionId);
		expect(current.state.pendingDialogs).toHaveLength(2);

		const delivered = await harness.sessions.uiResponse({
			workspaceId: harness.workspaceId,
			sessionId,
			response: { type: "extension_ui_response", id: selectId, value: "dois" },
		});
		expect(delivered).toEqual({ delivered: true });
		const duplicate = await harness.sessions.uiResponse({
			workspaceId: harness.workspaceId,
			sessionId,
			response: { type: "extension_ui_response", id: selectId, value: "um" },
		});
		expect(duplicate).toEqual({ delivered: false });
		current = await harness.sessions.snapshot(harness.workspaceId, sessionId);
		const confirmDialog = current.state.pendingDialogs.find((dialog) => dialog.method === "confirm");
		expect(confirmDialog).toBeDefined();
		const confirmed = await harness.sessions.uiResponse({
			workspaceId: harness.workspaceId,
			sessionId,
			response: { type: "extension_ui_response", id: confirmDialog?.id ?? "", confirmed: true },
		});
		expect(confirmed).toEqual({ delivered: true });
		await confirmNotice;
		const responses = (await recordLines(record)).filter((line) => line.type === "ui_response");
		expect(responses).toHaveLength(2);
	});

	test("pergunta ask recusa opção não oferecida antes de responder o OMP", async () => {
		const record = path.join(os.tmpdir(), `fake-ask-invalid-${Date.now()}.log`);
		const harness = await createHarness({ scenario: "ask", env: { FAKE_OMP_RECORD: record } });
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const sessionId = snapshot.state.sessionId;
		const askEvent = harness.bus.wait(
			(event) =>
				event.name === "frame" &&
				typeof event.data === "object" &&
				event.data !== null &&
				(event.data as { type?: string }).type === "extension_ui_request" &&
				(event.data as { method?: string }).method === "ask",
		);
		await harness.sessions.rpc({ workspaceId: harness.workspaceId, sessionId, command: { type: "prompt", message: "pergunte" } });
		const askId = ((await askEvent).data as { id: string }).id;
		let failure: unknown;
		try {
			await harness.sessions.uiResponse({
				workspaceId: harness.workspaceId,
				sessionId,
				response: {
					type: "extension_ui_response",
					id: askId,
					answers: [
						{ id: "q1", selectedOptions: ["arquivo-que-nao-existe"] },
						{ id: "q2", selectedOptions: ["alpha"] },
					],
				},
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SessionError);
		expect((failure as SessionError).code).toBe("INVALID_REQUEST");
		expect((await recordLines(record)).filter((line) => line.type === "ui_response")).toHaveLength(0);
		const current = await harness.sessions.snapshot(harness.workspaceId, sessionId);
		expect(current.state.pendingDialogs).toHaveLength(1);
	});

	test("método extension_ui_request desconhecido é cancelado e avisado; métodos sem resposta não são respondidos", async () => {
		const record = path.join(os.tmpdir(), `fake-unknown-ui-${Date.now()}.log`);
		const harness = await createHarness({ scenario: "unknown_ui", env: { FAKE_OMP_RECORD: record } });
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const sessionId = snapshot.state.sessionId;
		const notice = harness.bus.wait(
			(event) =>
				event.name === "desktop_notice" &&
				typeof event.data === "object" &&
				event.data !== null &&
				String((event.data as { text?: string }).text ?? "").includes("diálogo não suportado"),
		);
		const cancelledResponse = harness.bus.wait(
			(event) =>
				event.name === "frame" &&
				typeof event.data === "object" &&
				event.data !== null &&
				(event.data as { type?: string }).type === "notice" &&
				String((event.data as { message?: string }).message ?? "").startsWith("ui_response:weird-"),
		);
		await harness.sessions.rpc({ workspaceId: harness.workspaceId, sessionId, command: { type: "prompt", message: "oi" } });
		await notice;
		await cancelledResponse;
		const responses = (await recordLines(record)).filter((line) => line.type === "ui_response");
		expect(responses).toHaveLength(1);
		const response = responses[0].response as { id?: string; cancelled?: boolean };
		expect(response.id).toStartWith("weird-");
		expect(response.cancelled).toBe(true);
	});

	test("ack de prompt não confirmado vira interrupted (nunca erro reenviável)", async () => {
		const record = path.join(os.tmpdir(), `fake-slow-ack-${Date.now()}.log`);
		const harness = await createHarness({
			scenario: "slow_ack",
			requestTimeoutMs: 400,
			env: { FAKE_OMP_RECORD: record },
		});
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const sessionId = snapshot.state.sessionId;
		let failure: unknown;
		try {
			await harness.sessions.rpc({ workspaceId: harness.workspaceId, sessionId, command: { type: "prompt", message: "uma vez" } });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SessionError);
		const state = (await harness.sessions.snapshot(harness.workspaceId, sessionId)).state;
		const prompt = Object.values(state.prompts)[0];
		expect(prompt?.status).toBe("interrupted");
		expect(
			harness.bus.events.filter(
				(event) =>
					event.name === "desktop_prompt" && (event.data as { status?: string }).status === "sent",
			),
		).toHaveLength(1);
		const prompts = (await recordLines(record)).filter((line) => line.type === "prompt");
		expect(prompts).toHaveLength(1);
	});

	test("avisos de prontidão do OMP viram desktop_notice ao abrir a sessão", async () => {
		const harness = await createHarness({ scenario: "basic", env: { FAKE_OMP_PROTOCOL: "1" } });
		await harness.sessions.create(harness.workspaceId);
		const notices = harness.bus.events.filter((event) => event.name === "desktop_notice");
		const texts = notices.map((event) => String((event.data as { text?: string }).text ?? ""));
		expect(texts.some((text) => text.includes("protocolo v1"))).toBe(true);
		expect(texts.some((text) => text.includes("serão recusados com aviso"))).toBe(true);
	});

	test("get_state via session.rpc não devolve systemPrompt/dumpTools/segredos e modelos são projetados", async () => {
		const harness = await createHarness({ scenario: "leak" });
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const sessionId = snapshot.state.sessionId;
		const state = (await harness.sessions.rpc({ workspaceId: harness.workspaceId, sessionId, command: { type: "get_state" } })) as Record<string, unknown>;
		expect(state.systemPrompt).toBeUndefined();
		expect(state.dumpTools).toBeUndefined();
		expect(state.apiKey).toBeUndefined();
		expect(state.providerPayload).toBeUndefined();
		expect(JSON.stringify(state)).not.toContain("instruções internas");
		const stateEvent = harness.bus.events.find((event) => event.name === "desktop_state");
		expect(stateEvent).toBeDefined();
		expect((stateEvent?.data as Record<string, unknown>).systemPrompt).toBeUndefined();
		const models = (await harness.sessions.rpc({ workspaceId: harness.workspaceId, sessionId, command: { type: "get_available_models" } })) as { models: Array<Record<string, unknown>> };
		expect(models.models).toHaveLength(1);
		expect(models.models[0].provider).toBe("fake");
	});

	test("modelo sem suporte declarado a imagens recusa o anexo antes do envio", async () => {
		const record = path.join(os.tmpdir(), `fake-no-image-${Date.now()}.log`);
		const harness = await createHarness({
			scenario: "basic",
			env: { FAKE_OMP_MODEL_INPUT: "text", FAKE_OMP_RECORD: record },
		});
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const sessionId = snapshot.state.sessionId;
		const image = await harness.attachments.add({
			workspaceId: harness.workspaceId,
			name: "foto.png",
			mimeType: "image/png",
			bytesBase64: PNG.toString("base64"),
		});
		let failure: unknown;
		try {
			await harness.sessions.rpc({
				workspaceId: harness.workspaceId,
				sessionId,
				command: { type: "prompt", message: "veja", attachmentIds: [image.attachmentId] },
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as { code?: string }).code).toBe("UNSUPPORTED");
		expect((await recordLines(record)).filter((line) => line.type === "prompt")).toHaveLength(0);
	});

	test("histórico >8 MiB atravessa o snapshot com conteúdo, ordem e detalhes profundos intactos", async () => {
		// Unicode + emoji: ~9 MiB em UTF-8 numa única mensagem de ferramenta.
		const huge = "á🚀".repeat(1_500_000);
		expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(MAX_EVENT_BYTES);
		let details: Record<string, unknown> = { fim: "valor-profundo" };
		for (let level = 0; level < 20; level++) details = { nivel: level, filho: details };
		const entries = {
			leafId: "e4",
			entries: [
				{
					type: "message",
					id: "e1",
					parentId: null,
					message: { role: "user", content: "INÍCIO-HISTÓRICO", timestamp: 1 },
				},
				{
					type: "message",
					id: "e2",
					parentId: "e1",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }],
						timestamp: 2,
					},
				},
				{
					type: "message",
					id: "e3",
					parentId: "e2",
					message: {
						role: "toolResult",
						toolCallId: "t1",
						toolName: "read",
						content: [{ type: "text", text: huge }],
						details,
						isError: false,
						timestamp: 3,
					},
				},
				{
					type: "message",
					id: "e4",
					parentId: "e3",
					message: { role: "user", content: "FIM-HISTÓRICO", timestamp: 4 },
				},
			],
		};
		const harness = await createHarness({ scenario: "basic", entries });
		const snapshot = await harness.sessions.create(harness.workspaceId);

		expect(jsonBytes(snapshot)).toBeGreaterThan(MAX_EVENT_BYTES);
		expect(snapshot.state.messages.map((message) => message.key)).toEqual([
			"entry:e1",
			"entry:e2",
			"entry:e3",
			"entry:e4",
		]);
		const first = snapshot.state.messages[0].content[0];
		expect(first).toEqual({ type: "text", text: "INÍCIO-HISTÓRICO" });
		const last = snapshot.state.messages[3].content[0];
		expect(last).toEqual({ type: "text", text: "FIM-HISTÓRICO" });
		const toolMessage = snapshot.state.messages[2];
		expect(toolMessage.content[0]).toEqual({ type: "text", text: huge });
		expect(snapshot.state.tools.t1?.resultText).toBe(huge);
		expect(snapshot.state.tools.t1?.resultTruncated).toBeUndefined();
		expect(snapshot.state.tools.t1?.details).toEqual(details);

		// `snapshot()` é outro caminho que antes aplicava compactSnapshot.
		const reloaded = await harness.sessions.snapshot(harness.workspaceId, snapshot.state.sessionId);
		expect(reloaded.state.messages.map((message) => message.key)).toEqual([
			"entry:e1",
			"entry:e2",
			"entry:e3",
			"entry:e4",
		]);
		expect(reloaded.state.messages[2].content[0]).toEqual({ type: "text", text: huge });
		expect(reloaded.state.tools.t1?.details).toEqual(details);
		expect(jsonBytes(reloaded)).toBeGreaterThan(MAX_EVENT_BYTES);
	});

	test("get_entries acima do limite não cai em get_messages_page", async () => {
		const harness = await createHarness({ scenario: "basic" });
		const calls: string[] = [];
		const transport = {
			request: async (command: { type: string }) => {
				calls.push(command.type);
				if (command.type === "get_entries") {
					return {
						id: "r",
						type: "response",
						command: "get_entries",
						success: false,
						error: "RPC response exceeded the transport limit",
					};
				}
				return {
					id: "r",
					type: "response",
					command: "get_messages_page",
					success: true,
					data: { messages: [], totalMessages: 0 },
				};
			},
		};
		const service = harness.sessions as unknown as {
			readHistory(session: unknown): Promise<unknown>;
		};
		await expect(service.readHistory({ generation: 1, transport })).rejects.toThrow("grande demais");
		expect(calls).toEqual(["get_entries"]);
	});

	test("paginação do histórico não para em 200 páginas e preserva ordem/chaves", async () => {
		const harness = await createHarness({ scenario: "basic" });
		const total = 201;
		let index = 0;
		const transport = {
			request: async () => {
				const current = index++;
				return {
					id: `r${current}`,
					type: "response",
					command: "get_messages_page",
					success: true,
					data: {
						messages: [{ role: "user", content: `msg-${current}`, timestamp: current }],
						totalMessages: total,
						...(current < total - 1 ? { nextCursor: `cursor-${current + 1}` } : {}),
					},
				};
			},
		};
		const service = harness.sessions as unknown as {
			readHistoryPages(session: unknown): Promise<{
				messages: Array<{ key: string; content: Array<{ type: string; text?: string }> }>;
			}>;
		};
		const result = await service.readHistoryPages({ generation: 7, transport });
		expect(result.messages).toHaveLength(total);
		expect(result.messages[0].key).toBe("hist:7:0");
		expect(result.messages.at(-1)?.key).toBe(`hist:7:${total - 1}`);
		expect(result.messages[0].content[0]).toEqual({ type: "text", text: "msg-0" });
		expect(result.messages.at(-1)?.content[0]).toEqual({ type: "text", text: `msg-${total - 1}` });
	});

	test("paginação do histórico falha explicitamente em cursor repetido", async () => {
		const harness = await createHarness({ scenario: "basic" });
		const transport = {
			request: async () => ({
				id: "r",
				type: "response",
				command: "get_messages_page",
				success: true,
				data: {
					messages: [{ role: "user", content: "msg", timestamp: 1 }],
					totalMessages: 2,
					nextCursor: "cursor-repetido",
				},
			}),
		};
		const service = harness.sessions as unknown as {
			readHistoryPages(session: unknown): Promise<unknown>;
		};
		await expect(service.readHistoryPages({ generation: 1, transport })).rejects.toThrow("repetiu um cursor");
	});

	test("paginação do histórico falha explicitamente quando termina incompleta", async () => {
		const harness = await createHarness({ scenario: "basic" });
		const transport = {
			request: async () => ({
				id: "r",
				type: "response",
				command: "get_messages_page",
				success: true,
				data: {
					messages: [{ role: "user", content: "msg", timestamp: 1 }],
					totalMessages: 2,
				},
			}),
		};
		const service = harness.sessions as unknown as {
			readHistoryPages(session: unknown): Promise<unknown>;
		};
		await expect(service.readHistoryPages({ generation: 1, transport })).rejects.toThrow("terminou incompleta");
	});

	test("paginação do histórico falha quando o total muda entre páginas", async () => {
		const harness = await createHarness({ scenario: "basic" });
		let call = 0;
		const transport = {
			request: async () => {
				call += 1;
				return {
					id: "r",
					type: "response",
					command: "get_messages_page",
					success: true,
					data: {
						messages: [{ role: "user", content: `msg-${call}`, timestamp: call }],
						totalMessages: call === 1 ? 2 : 3,
						nextCursor: `cursor-${call}`,
					},
				};
			},
		};
		const service = harness.sessions as unknown as {
			readHistoryPages(session: unknown): Promise<unknown>;
		};
		await expect(service.readHistoryPages({ generation: 1, transport })).rejects.toThrow("histórico mudou");
	});

	test("paginação do histórico falha em página vazia com cursor", async () => {
		const harness = await createHarness({ scenario: "basic" });
		let call = 0;
		const transport = {
			request: async () => {
				call += 1;
				return {
					id: "r",
					type: "response",
					command: "get_messages_page",
					success: true,
					data: {
						messages: call === 1 ? [{ role: "user", content: "msg", timestamp: 1 }] : [],
						totalMessages: 2,
						nextCursor: `cursor-${call}`,
					},
				};
			},
		};
		const service = harness.sessions as unknown as {
			readHistoryPages(session: unknown): Promise<unknown>;
		};
		await expect(service.readHistoryPages({ generation: 1, transport })).rejects.toThrow("não avançou");
	});

	test("fechar sessão com diálogo pendente emite desktop_dialog_closed e limpa o estado", async () => {
		const harness = await createHarness({ scenario: "ask" });
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const sessionId = snapshot.state.sessionId;
		const askEvent = harness.bus.wait(
			(event) =>
				event.name === "frame" &&
				typeof event.data === "object" &&
				event.data !== null &&
				(event.data as { method?: string }).method === "ask",
		);
		await harness.sessions.rpc({ workspaceId: harness.workspaceId, sessionId, command: { type: "prompt", message: "pergunte" } });
		const askId = ((await askEvent).data as { id: string }).id;
		const closedEvent = harness.bus.wait(
			(event) => event.name === "desktop_dialog_closed" && (event.data as { id?: string }).id === askId,
		);
		await harness.sessions.close(harness.workspaceId, sessionId);
		const closed = await closedEvent;
		expect((closed.data as { reason?: string }).reason).toBe("session_closed");
	});

	test("queda do OMP com diálogo pendente cancela o diálogo explicitamente", async () => {
		const harness = await createHarness({
			scenario: "ask",
			env: { FAKE_OMP_EXIT_AFTER_UI: "1" },
		});
		const snapshot = await harness.sessions.create(harness.workspaceId);
		const sessionId = snapshot.state.sessionId;
		const askEvent = harness.bus.wait(
			(event) =>
				event.name === "frame" &&
				typeof event.data === "object" &&
				event.data !== null &&
				(event.data as { method?: string }).method === "ask",
		);
		await harness.sessions.rpc({ workspaceId: harness.workspaceId, sessionId, command: { type: "prompt", message: "pergunte" } });
		const askId = ((await askEvent).data as { id: string }).id;
		const closedEvent = harness.bus.wait(
			(event) => event.name === "desktop_dialog_closed" && (event.data as { id?: string }).id === askId,
		);
		const closed = await closedEvent;
		expect((closed.data as { reason?: string }).reason).toBe("host_exited");
		const state = (await harness.sessions.snapshot(harness.workspaceId, sessionId)).state;
		expect(state.pendingDialogs).toHaveLength(0);
		expect(state.status).toBe("interrupted");
	});

	test("closeAll preserva as abas no encerramento normal", async () => {
		const harness = await createHarness({ scenario: "basic", sessionCount: 2 });
		await harness.sessions.open(harness.workspaceId, harness.sessionFiles[0]);
		await harness.sessions.open(harness.workspaceId, harness.sessionFiles[1]);
		const tabsFile = path.join(harness.dataDir, "tabs.json");
		const before = JSON.parse(await fs.promises.readFile(tabsFile, "utf8")) as {
			tabs: Array<{ sessionPath: string }>;
		};
		expect(before.tabs).toHaveLength(2);

		await harness.sessions.closeAll();

		const after = JSON.parse(await fs.promises.readFile(tabsFile, "utf8")) as {
			tabs: Array<{ sessionPath: string }>;
		};
		expect(after.tabs).toHaveLength(2);
		expect(after.tabs.map((tab) => tab.sessionPath).sort()).toEqual([...harness.sessionFiles].sort());
	});

	test("restoreTabs não trunca tabs.json no meio da restauração", async () => {
		const observed: number[] = [];
		let harnessRef: Harness | undefined;
		const harness = await createHarness({
			scenario: "basic",
			sessionCount: 2,
			onListSessions: () => {
				if (!harnessRef) return;
				try {
					const raw = JSON.parse(
						fs.readFileSync(path.join(harnessRef.dataDir, "tabs.json"), "utf8"),
					) as { tabs?: unknown[] };
					observed.push(raw.tabs?.length ?? 0);
				} catch {
					observed.push(-1);
				}
			},
		});
		harnessRef = harness;
		await harness.sessions.open(harness.workspaceId, harness.sessionFiles[0]);
		await harness.sessions.open(harness.workspaceId, harness.sessionFiles[1]);
		await harness.sessions.closeAll();
		observed.length = 0;

		await harness.sessions.restoreTabs();

		// Durante a restauração o arquivo continua com as 2 abas; só é reescrito
		// ao final (antes, cada `open` gravava uma lista parcial).
		expect(observed.length).toBeGreaterThanOrEqual(2);
		expect(observed.every((count) => count === 2)).toBe(true);
		const after = JSON.parse(
			await fs.promises.readFile(path.join(harness.dataDir, "tabs.json"), "utf8"),
		) as { tabs: unknown[] };
		expect(after.tabs).toHaveLength(2);
	});

	test("restoreTabs reutiliza o profile persistido", async () => {
		const profiles: Array<string | undefined> = [];
		const harness = await createHarness({
			scenario: "basic",
			onListSessions: (profile) => profiles.push(profile),
		});
		await fs.promises.writeFile(
			path.join(harness.dataDir, "tabs.json"),
			`${JSON.stringify({
				version: 1,
				tabs: [
					{
						workspaceId: harness.workspaceId,
						sessionPath: harness.sessionFile,
						cwd: harness.workspaceDir,
						profile: "trabalho",
					},
				],
			})}\n`,
			"utf8",
		);
		await harness.sessions.restoreTabs();
		expect(profiles).toContain("trabalho");
	});
});
