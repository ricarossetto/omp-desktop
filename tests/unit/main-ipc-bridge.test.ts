import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { DesktopEvent, DesktopRequest, RuntimeStatus, WorkspaceDto } from "../../src/shared/contracts";
import { AttachmentRegistry, SessionRegistry, WorkspaceRegistry } from "../../src/main/registries";

const productionFileUrl = "file:///C:/app/out/renderer/index.html";
const mainFrame = { url: productionFileUrl };
const sent: DesktopEvent[] = [];
const closedTerminals: string[] = [];
let selectedDirectory = "";

mock.module("electron", () => ({
	app: { getPath: () => selectedDirectory },
	dialog: {
		showOpenDialog: async () => ({ canceled: false, filePaths: [selectedDirectory] }),
		showSaveDialog: async () => ({ canceled: true }),
	},
	ipcMain: { handle: () => undefined },
	shell: {
		openPath: async () => "",
		showItemInFolder: () => undefined,
	},
}));

// O módulo `electron` precisa do mock registrado antes de ser avaliado; por isso
// o import de `MainBridge` é dinâmico (os imports estáticos são hoisted).
const { MainBridge } = await import("../../src/main/ipc");

const status: RuntimeStatus = { phase: "ready", signed: false };
const workspace: WorkspaceDto = {
	workspaceId: "ws1",
	path: "",
	name: "Projeto",
	available: true,
	lastOpenedAt: 1,
};

let root = "";

beforeAll(async () => {
	root = await mkdtemp(path.join(tmpdir(), "omp-bridge-"));
	selectedDirectory = root;
	workspace.path = root;
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

function createBridge() {
	sent.length = 0;
	closedTerminals.length = 0;
	const workspaces = new WorkspaceRegistry();
	workspaces.add(workspace);
	const sessions = new SessionRegistry();
	const attachments = new AttachmentRegistry();
	const terminalInfo = {
		terminalId: "t1",
		workspaceId: "ws1",
		cwd: root,
		pid: 1234,
		shell: "cmd.exe",
		ownerId: 7,
	};
	const terminals = {
		get: (terminalId: string) => (terminalId === "t1" ? terminalInfo : undefined),
		owns: (terminalId: string, workspaceId?: string) =>
			terminalId === "t1" && (workspaceId === undefined || workspaceId === "ws1"),
		write: () => true,
		resize: () => true,
		close: async (terminalId: string) => {
			closedTerminals.push(terminalId);
			return true;
		},
		list: () => [terminalInfo],
		hasActive: () => true,
		closeAll: async () => undefined,
	};
	const webContents = {
		id: 7,
		isDestroyed: () => false,
		getURL: () => productionFileUrl,
		mainFrame,
		send: (_channel: string, event: DesktopEvent) => sent.push(event),
	};
	const win = { isDestroyed: () => false, webContents };
	const bridge = new MainBridge({
		getWindow: () => win as never,
		authorizedUrls: () => ({ productionFileUrl }),
		runtime: {} as never,
		uiState: {} as never,
		workspaces,
		sessions,
		attachments,
		terminals: terminals as never,
		requestHost: (async (op: string) => {
			if (op === "workspace.relocate") {
				return { ...workspace, path: selectedDirectory } satisfies WorkspaceDto;
			}
			throw new Error(`op inesperada: ${op}`);
		}) as never,
		getStatus: () => status,
		awaitRuntimeStatus: async () => status,
		restartHost: async () => undefined,
		log: () => undefined,
		isSmokeMode: () => false,
	});
	const dispatch = (request: DesktopRequest) =>
		(bridge as unknown as { dispatch(request: DesktopRequest): Promise<unknown> }).dispatch(request);
	return { bridge, dispatch, workspaces, sessions, attachments };
}

describe("MainBridge terminal", () => {
	test("write/resize/close exigem terminal da janela e de projeto aberto", async () => {
		const { dispatch, workspaces } = createBridge();
		await expect(
			dispatch({ op: "terminal.write", terminalId: "t1", data: "x" }),
		).resolves.toEqual({ written: true });
		await expect(
			dispatch({ op: "terminal.resize", terminalId: "t1", cols: 80, rows: 24 }),
		).resolves.toEqual({ resized: true });
		await expect(dispatch({ op: "terminal.close", terminalId: "t1" })).resolves.toEqual({ closed: true });
		expect(closedTerminals).toEqual(["t1"]);

		workspaces.remove("ws1");
		await expect(
			dispatch({ op: "terminal.write", terminalId: "t1", data: "x" }),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});
});

describe("MainBridge limpeza de workspace", () => {
	test("relocate fecha terminais, limpa sessões/anexos e avisa a UI", async () => {
		const { dispatch, sessions, attachments } = createBridge();
		sessions.registerSession({ workspaceId: "ws1", sessionId: "s1", sessionPath: path.join(root, "s1.jsonl") });
		attachments.add("ws1", {
			attachmentId: "att1",
			name: "a.txt",
			mimeType: "text/plain",
			size: 3,
			kind: "file",
		});
		await dispatch({ op: "workspace.relocate", workspaceId: "ws1" });
		expect(sessions.has("s1")).toBe(false);
		expect(attachments.belongsTo("att1", "ws1")).toBe(false);
		expect(closedTerminals).toEqual(["t1"]);
		const event = sent.find((item) => item.name === "session.status");
		expect(event).toMatchObject({
			workspaceId: "ws1",
			sessionId: "s1",
			data: { status: "closed" },
		});
	});

	test("evento sintético usa a geração e sequência observadas", async () => {
		const { bridge } = createBridge();
		await bridge.handleHostEvent({
			kind: "event",
			workspaceId: "ws1",
			sessionId: "s1",
			generation: 4,
			sequence: 9,
			name: "frame",
			data: { type: "session_settled" },
		});
		bridge.notifySessionsUnavailable(
			[{ sessionId: "s1", workspaceId: "ws1" }],
			"error",
			"O serviço local encerrou.",
		);
		const event = sent.find((item) => item.name === "session.status");
		expect(event).toMatchObject({
			generation: 4,
			sequence: 10,
			data: { status: "error", error: "O serviço local encerrou." },
		});
	});
});
