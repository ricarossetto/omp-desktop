/**
 * Ponte IPC do Electron main.
 *
 * - Um único handler `omp:invoke`, com validação do main frame da janela dona.
 * - Associação workspace/sessão/terminal/anexo validada antes de encaminhar ao host.
 * - Operações locais (runtime, ui, workspace.pick/relocate, anexos via diálogo,
 *   exportação HTML, terminal, Git e arquivos) resolvidas no próprio main.
 * - Eventos vão somente para a janela autorizada.
 */
import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import {
	desktopRequestSchema,
	type AttachmentDto,
	type DesktopEvent,
	type DesktopRequest,
	type DesktopResult,
	type GitDiffResult,
	type GitStatusResult,
	type HostErrorBody,
	type RuntimeStatus,
	type SessionListItem,
	type UiResponse,
	type WorkspaceDto,
} from "../shared/contracts";
import type { SessionSnapshot } from "../shared/session-types";
import { readWorkspaceFile, externalOpenMode, resolveFileForExternalOpen } from "./files";
import { gitCommit, gitDiff, gitStage, gitStatus, gitUnstage, GitError, type GitCommitResult } from "./git";
import { HostClientError } from "./host-client";
import { isAuthorizedSender, isAllowedRendererUrl, type AuthorizedWindow } from "./ipc-guard";
import { assertWorkspaceDirectory, PathValidationError } from "./paths";
import { AttachmentRegistry, SessionRegistry, WorkspaceRegistry } from "./registries";
import {
	buildSessionUnavailableEvent,
	readSnapshotClock,
	SessionEventClock,
} from "./session-events";
import type { RuntimeResolver } from "./runtime";
import { sanitizeForRenderer } from "./sanitize";
import type { TerminalInfo, TerminalManager } from "./terminal";
import type { UiStateStore } from "./ui-state";

// Mesmo limite do host: o prompt inteiro precisa caber em um frame de 1 MiB.
/** Timeout do main por comando; nunca menor que o do host. */
function rpcTimeoutFor(type: string): number {
	if (type === "login" || type === "logout") return 660_000;
	if (type === "compact" || type === "export_html") return 660_000;
	if (type === "get_entries" || type === "get_messages_page" || type === "get_session_stats") return 360_000;
	return 240_000;
}

const MAX_ATTACHMENT_BYTES = 600 * 1024;
const MAX_ATTACHMENTS_PER_PICK = 16;

const MIME_BY_EXTENSION: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".csv": "text/csv",
	".ts": "text/plain",
	".tsx": "text/plain",
	".js": "text/plain",
	".jsx": "text/plain",
	".css": "text/plain",
	".html": "text/plain",
	".xml": "text/plain",
	".yaml": "text/plain",
	".yml": "text/plain",
};

function mimeForFile(filePath: string): string {
	return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function safeFileName(value: string): string {
	const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/, "");
	return cleaned.length > 0 ? cleaned.slice(0, 120) : "sessao";
}

export function toHostErrorBody(error: unknown): HostErrorBody {
	if (error instanceof HostClientError) return { code: error.code, message: error.message };
	if (error instanceof PathValidationError) return { code: "FORBIDDEN_PATH", message: error.message };
	if (error instanceof GitError) return { code: "INTERNAL", message: error.message };
	if (error instanceof Error) {
		const message = error.message.trim().length > 0 ? error.message : "Ocorreu uma falha inesperada.";
		return { code: "INTERNAL", message };
	}
	return { code: "INTERNAL", message: "Ocorreu uma falha inesperada." };
}

function listFromResponse<T>(value: unknown, key: string): T[] {
	if (Array.isArray(value)) return value as T[];
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		for (const candidateKey of [key, "items", "list"]) {
			const candidate = record[candidateKey];
			if (Array.isArray(candidate)) return candidate as T[];
		}
	}
	throw new HostClientError("INTERNAL", "O serviço local devolveu uma resposta inesperada.");
}

export interface BridgeDeps {
	getWindow(): BrowserWindow | null;
	authorizedUrls(): { productionFileUrl?: string; devUrl?: string };
	runtime: RuntimeResolver;
	uiState: UiStateStore;
	workspaces: WorkspaceRegistry;
	sessions: SessionRegistry;
	attachments: AttachmentRegistry;
	terminals: TerminalManager;
	requestHost<T>(op: string, payload: unknown, timeoutMs?: number): Promise<T>;
	getStatus(): RuntimeStatus;
	awaitRuntimeStatus(): Promise<RuntimeStatus>;
	restartHost(ompPath?: string): Promise<void>;
	log(level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): void;
	isSmokeMode(): boolean;
	markSessionBusy?(sessionId: string): void;
}

export class MainBridge {
	private readonly deps: BridgeDeps;
	private registered = false;
	private readonly terminalSequences = new Map<string, number>();
	private readonly sessionClock = new SessionEventClock();

	constructor(deps: BridgeDeps) {
		this.deps = deps;
	}

	register(): void {
		if (this.registered) return;
		this.registered = true;
		ipcMain.handle("omp:invoke", (event, raw) => this.handleInvoke(event, raw));
	}

	private handleInvoke(event: IpcMainInvokeEvent, raw: unknown): Promise<DesktopResult> {
		const win = this.deps.getWindow();
		if (!win || win.isDestroyed()) {
			return Promise.resolve({
				ok: false,
				error: { code: "INTERNAL", message: "A janela do aplicativo não está disponível." },
			});
		}
		const urls = this.deps.authorizedUrls();
		const authorized: AuthorizedWindow = {
			webContentsId: win.webContents.id,
			mainFrame: win.webContents.mainFrame,
			productionFileUrl: urls.productionFileUrl,
			devUrl: urls.devUrl,
		};
		const frame = event.senderFrame;
		if (
			!isAuthorizedSender(
				{
					sender: { id: event.sender.id, mainFrame: win.webContents.mainFrame },
					senderFrame: frame,
				},
				authorized,
			)
		) {
			this.deps.log("warn", "ipc.origem_recusada", { hasFrame: Boolean(frame) });
			return Promise.resolve({
				ok: false,
				error: {
					code: "INVALID_REQUEST",
					message: "O pedido não veio da janela autorizada do aplicativo.",
				},
			});
		}
		const parsed = desktopRequestSchema.safeParse(raw);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			const location = issue && issue.path.length > 0 ? issue.path.join(".") : "pedido";
			return Promise.resolve({
				ok: false,
				error: {
					code: "INVALID_REQUEST",
					message: `Pedido inválido (${location}): ${issue?.message ?? "formato não reconhecido"}.`,
				},
			});
		}
		return this.dispatch(parsed.data)
			.then((data) => ({ ok: true, data: sanitizeForRenderer(data) }) as DesktopResult)
			.catch((error: unknown) => {
				const body = toHostErrorBody(error);
				if (body.code === "INTERNAL") {
					this.deps.log("error", "ipc.falha", { op: parsed.data.op, message: body.message });
				}
				return { ok: false, error: body } as DesktopResult;
			});
	}

	private requireWindow(): BrowserWindow {
		const win = this.deps.getWindow();
		if (!win || win.isDestroyed()) {
			throw new HostClientError("INTERNAL", "A janela do aplicativo não está disponível.");
		}
		return win;
	}

	private requireWorkspace(workspaceId: string): WorkspaceDto {
		const workspace = this.deps.workspaces.get(workspaceId);
		if (!workspace) {
			throw new HostClientError(
				"UNKNOWN_WORKSPACE",
				"Este projeto não está aberto no aplicativo. Abra a pasta novamente.",
			);
		}
		return workspace;
	}

	private async requireAvailableWorkspace(workspaceId: string): Promise<WorkspaceDto> {
		const workspace = this.requireWorkspace(workspaceId);
		if (!workspace.available) {
			throw new HostClientError(
				"UNKNOWN_WORKSPACE",
				"A pasta deste projeto não está disponível no disco. Use Diagnóstico para localizá-la novamente.",
			);
		}
		await assertWorkspaceDirectory(workspace.path);
		return workspace;
	}

	private requireSession(workspaceId: string, sessionId: string): void {
		if (!this.deps.sessions.has(sessionId, workspaceId)) {
			throw new HostClientError(
				"UNKNOWN_SESSION",
				"A sessão não está aberta neste aplicativo. Abra a sessão novamente.",
			);
		}
	}

	/**
	 * Verifica que o terminal pertence a esta janela e a um projeto ainda aberto.
	 * O pedido de terminal não carrega `workspaceId`, então a associação vem do
	 * próprio registro do PTY criado pelo main — nunca do renderer.
	 */
	private requireTerminal(terminalId: string): TerminalInfo {
		const win = this.requireWindow();
		const info = this.deps.terminals.get(terminalId);
		if (
			!info ||
			info.ownerId !== win.webContents.id ||
			!this.deps.workspaces.has(info.workspaceId) ||
			!this.deps.terminals.owns(terminalId, info.workspaceId)
		) {
			throw new HostClientError("INVALID_REQUEST", "Este terminal não está aberto neste aplicativo.");
		}
		return info;
	}

	private registerSnapshot(workspaceId: string, value: unknown): SessionSnapshot {
		if (typeof value !== "object" || value === null) {
			throw new HostClientError("INTERNAL", "O serviço local não devolveu o estado da sessão.");
		}
		const snapshot = value as SessionSnapshot;
		const sessionId = snapshot.state?.sessionId;
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new HostClientError("INTERNAL", "O serviço local não informou o identificador da sessão.");
		}
		this.sessionClock.observe(sessionId, snapshot.state.generation, snapshot.state.sequence);
		this.deps.sessions.registerSession({
			workspaceId,
			sessionId,
			sessionPath: typeof snapshot.sessionPath === "string" ? snapshot.sessionPath : undefined,
		});
		return snapshot;
	}

	/**
	 * Avisa a UI que sessões perderam o processo (queda/troca do host ou remoção
	 * do projeto). O status terminal faz o reducer limpar diálogos pendentes; só
	 * emite para sessões que ainda estão registradas.
	 */
	notifySessionsUnavailable(
		records: Array<{ sessionId: string; workspaceId: string }>,
		status: "closed" | "error",
		message: string,
	): void {
		if (records.length === 0) return;
		const win = this.deps.getWindow();
		if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
		for (const record of records) {
			const clock = this.sessionClock.next(record.sessionId);
			this.sendEvent(buildSessionUnavailableEvent(record, clock, status, message));
		}
	}

	private validateAttachmentIds(workspaceId: string, command: unknown): void {
		if (typeof command !== "object" || command === null) return;
		const ids = (command as { attachmentIds?: unknown }).attachmentIds;
		if (!Array.isArray(ids)) return;
		for (const id of ids) {
			if (typeof id !== "string" || !this.deps.attachments.belongsTo(id, workspaceId)) {
				throw new HostClientError(
					"INVALID_REQUEST",
					"Um dos anexos não pertence a este projeto. Anexe o arquivo novamente.",
				);
			}
		}
	}

	async handleHostEvent(event: DesktopEvent): Promise<void> {
		if (event.sessionId) {
			this.sessionClock.observe(event.sessionId, event.generation, event.sequence);
		}
		if (event.workspaceId !== "host" && !this.deps.workspaces.has(event.workspaceId)) {
			this.deps.log("warn", "host.evento_workspace_desconhecido", { name: event.name });
			return;
		}
		this.sendEvent(event);
	}

	onTerminalData(info: TerminalInfo, data: string): void {
		const win = this.deps.getWindow();
		if (!win || win.isDestroyed() || info.ownerId !== win.webContents.id) return;
		const sequence = (this.terminalSequences.get(info.workspaceId) ?? 0) + 1;
		this.terminalSequences.set(info.workspaceId, sequence);
		this.sendEvent({
			kind: "event",
			workspaceId: info.workspaceId,
			generation: 0,
			sequence,
			name: "terminal.data",
			data: { terminalId: info.terminalId, data },
		});
	}

	onTerminalExit(info: TerminalInfo, exitCode: number): void {
		const win = this.deps.getWindow();
		if (!win || win.isDestroyed() || info.ownerId !== win.webContents.id) return;
		const sequence = (this.terminalSequences.get(info.workspaceId) ?? 0) + 1;
		this.terminalSequences.set(info.workspaceId, sequence);
		this.sendEvent({
			kind: "event",
			workspaceId: info.workspaceId,
			generation: 0,
			sequence,
			name: "terminal.exit",
			data: { terminalId: info.terminalId, exitCode },
		});
	}

	private sendEvent(event: DesktopEvent): void {
		const win = this.deps.getWindow();
		if (!win || win.isDestroyed()) return;
		if (win.webContents.isDestroyed()) return;
		const urls = this.deps.authorizedUrls();
		const trusted = isAllowedRendererUrl(win.webContents.getURL(), {
			webContentsId: win.webContents.id,
			mainFrame: win.webContents.mainFrame,
			productionFileUrl: urls.productionFileUrl,
			devUrl: urls.devUrl,
		});
		if (!trusted) return;
		win.webContents.send("omp:event", sanitizeForRenderer(event));
	}

	private async dispatch(request: DesktopRequest): Promise<unknown> {
		switch (request.op) {
			case "runtime.status":
				return await this.deps.awaitRuntimeStatus();

			case "runtime.selectOmp": {
				const win = this.requireWindow();
				const result = await dialog.showOpenDialog(win, {
					title: "Selecionar omp.exe",
					properties: ["openFile"],
					filters: [
						{ name: "Executável OMP", extensions: ["exe", "cmd", "bat"] },
						{ name: "Todos os arquivos", extensions: ["*"] },
					],
				});
				const selected = result.filePaths[0];
				if (result.canceled || !selected) return this.deps.getStatus();
				const probe = await this.deps.runtime.probeOmpPath(selected);
				if (!probe.compatible) {
					const current = this.deps.getStatus();
					return {
						...current,
						phase: probe.ompVersion ? "omp-incompatible" : "omp-missing",
						ompPath: probe.ompPath ?? selected,
						ompVersion: probe.ompVersion,
						message: probe.message ?? "O executável selecionado não é compatível.",
					} satisfies RuntimeStatus;
				}
				await this.deps.runtime.saveOmpPath(selected);
				this.deps.runtime.invalidate();
				await this.deps.restartHost(selected);
				return this.deps.getStatus();
			}

			case "runtime.openExternal": {
				let url: URL;
				try {
					url = new URL(request.url);
				} catch {
					throw new HostClientError("INVALID_REQUEST", "O endereço informado não é válido.");
				}
				if (url.protocol !== "https:" && url.protocol !== "http:") {
					throw new HostClientError(
						"UNSUPPORTED",
						"Somente endereços http e https podem ser abertos no navegador.",
					);
				}
				if (url.username || url.password) {
					throw new HostClientError("INVALID_REQUEST", "Endereços com credenciais embutidas não são permitidos.");
				}
				await shell.openExternal(url.toString());
				return { opened: true };
			}

			case "ui.getState":
				return this.deps.uiState.getState();

			case "ui.setState":
				return await this.deps.uiState.setState(request.state);

			case "workspace.pick": {
				const win = this.requireWindow();
				const result = await dialog.showOpenDialog(win, {
					title: "Abrir pasta do projeto",
					properties: ["openDirectory", "createDirectory"],
				});
				const selected = result.filePaths[0];
				if (result.canceled || !selected) return null;
				const real = await assertWorkspaceDirectory(selected);
				const dto = await this.deps.requestHost<WorkspaceDto>("workspace.add", { path: real });
				if (!dto || typeof dto.workspaceId !== "string" || typeof dto.path !== "string") {
					throw new HostClientError("INTERNAL", "O serviço local não devolveu o projeto aberto.");
				}
				this.deps.workspaces.add(dto);
				return dto;
			}

			case "workspace.list": {
				const value = await this.deps.requestHost<unknown>("workspace.list", {});
				const list = listFromResponse<WorkspaceDto>(value, "workspaces");
				this.deps.workspaces.clear();
				for (const dto of list) this.deps.workspaces.add(dto);
				return list;
			}

			case "workspace.removeRecent": {
				this.requireWorkspace(request.workspaceId);
				await this.deps.requestHost("workspace.removeRecent", { workspaceId: request.workspaceId });
				this.notifySessionsUnavailable(
					this.deps.sessions.openInWorkspace(request.workspaceId),
					"closed",
					"O projeto foi removido do aplicativo; as sessões abertas dele foram encerradas.",
				);
				for (const info of this.deps.terminals.list()) {
					if (info.workspaceId === request.workspaceId) await this.deps.terminals.close(info.terminalId);
				}
				this.deps.workspaces.remove(request.workspaceId);
				this.deps.sessions.clearWorkspace(request.workspaceId);
				this.deps.attachments.clearWorkspace(request.workspaceId);
				return { removed: true };
			}

			case "workspace.relocate": {
				const current = this.requireWorkspace(request.workspaceId);
				const win = this.requireWindow();
				const result = await dialog.showOpenDialog(win, {
					title: `Localizar novamente: ${current.name}`,
					properties: ["openDirectory"],
					defaultPath: current.path,
				});
				const selected = result.filePaths[0];
				if (result.canceled || !selected) return null;
				const real = await assertWorkspaceDirectory(selected);
				const dto = await this.deps.requestHost<WorkspaceDto>("workspace.relocate", {
					workspaceId: request.workspaceId,
					path: real,
				});
				if (!dto || typeof dto.path !== "string") {
					throw new HostClientError("INTERNAL", "O serviço local não devolveu o projeto relocalizado.");
				}
				// #17: o caminho mudou; sessões, terminais e anexos do caminho antigo
				// não pertencem mais a este projeto. Mesma limpeza de removeRecent.
				this.notifySessionsUnavailable(
					this.deps.sessions.openInWorkspace(request.workspaceId),
					"closed",
					"O projeto foi localizado novamente; reabra as sessões no novo caminho.",
				);
				for (const info of this.deps.terminals.list()) {
					if (info.workspaceId === request.workspaceId) await this.deps.terminals.close(info.terminalId);
				}
				this.deps.sessions.clearWorkspace(request.workspaceId);
				this.deps.attachments.clearWorkspace(request.workspaceId);
				this.deps.workspaces.add({ ...dto, workspaceId: request.workspaceId });
				return dto;
			}

			case "session.list": {
				this.requireWorkspace(request.workspaceId);
				const value = await this.deps.requestHost<unknown>("session.list", {
					workspaceId: request.workspaceId,
				});
				const list = listFromResponse<SessionListItem>(value, "sessions");
				return list.map((item) => {
					if (typeof item.path === "string") {
						this.deps.sessions.authorizePath(request.workspaceId, item.path);
					}
					const open = typeof item.path === "string" ? this.deps.sessions.findByPath(item.path) : undefined;
					const openSessionId = open?.sessionId ?? item.openSessionId;
					// O host restaura abas sozinho ao iniciar; sem registrar aqui, o main
					// recusaria snapshot/rpc/close de uma sessão restaurada.
					if (openSessionId && typeof item.path === "string" && !this.deps.sessions.get(openSessionId)) {
						this.deps.sessions.registerSession({
							sessionId: openSessionId,
							workspaceId: request.workspaceId,
							sessionPath: item.path,
						});
					}
					return { ...item, openSessionId };
				});
			}

			case "session.create": {
				this.requireWorkspace(request.workspaceId);
				const snapshot = await this.deps.requestHost<unknown>("session.create", {
					workspaceId: request.workspaceId,
				});
				return this.registerSnapshot(request.workspaceId, snapshot);
			}

			case "session.open": {
				this.requireWorkspace(request.workspaceId);
				if (!this.deps.sessions.isPathAuthorized(request.workspaceId, request.sessionPath)) {
					throw new HostClientError(
						"UNKNOWN_SESSION",
						"A sessão escolhida não veio da listagem autorizada deste projeto. Recarregue a lista de sessões.",
					);
				}
				const snapshot = await this.deps.requestHost<unknown>("session.open", {
					workspaceId: request.workspaceId,
					sessionPath: request.sessionPath,
				});
				return this.registerSnapshot(request.workspaceId, snapshot);
			}

			case "session.close": {
				this.requireSession(request.workspaceId, request.sessionId);
				await this.deps.requestHost("session.close", {
					workspaceId: request.workspaceId,
					sessionId: request.sessionId,
				});
				this.deps.sessions.unregister(request.sessionId);
				return { closed: true };
			}

			case "session.snapshot": {
				this.requireSession(request.workspaceId, request.sessionId);
				const snapshot = await this.deps.requestHost<unknown>("session.snapshot", {
					workspaceId: request.workspaceId,
					sessionId: request.sessionId,
				});
				const clock = readSnapshotClock(snapshot);
				if (clock) this.sessionClock.observe(request.sessionId, clock.generation, clock.sequence);
				return snapshot;
			}

			case "session.rpc": {
				this.requireSession(request.workspaceId, request.sessionId);
				this.validateAttachmentIds(request.workspaceId, request.command);
				const rpcResult = await this.deps.requestHost(
					"session.rpc",
					{
						workspaceId: request.workspaceId,
						sessionId: request.sessionId,
						command: request.command,
					},
					rpcTimeoutFor(request.command.type),
				);
				if (
					request.command.type === "prompt" ||
					request.command.type === "steer" ||
					request.command.type === "follow_up"
				) {
					this.deps.markSessionBusy?.(request.sessionId);
				}
				return rpcResult;
			}

			case "session.uiResponse": {
				this.requireSession(request.workspaceId, request.sessionId);
				const response: UiResponse = request.response;
				return await this.deps.requestHost("session.uiResponse", {
					workspaceId: request.workspaceId,
					sessionId: request.sessionId,
					response,
				});
			}

			case "session.exportHtml": {
				const record = this.deps.sessions.get(request.sessionId);
				this.requireSession(request.workspaceId, request.sessionId);
				const win = this.requireWindow();
				const base = record?.sessionPath
					? path.basename(record.sessionPath, path.extname(record.sessionPath))
					: request.sessionId;
				const result = await dialog.showSaveDialog(win, {
					title: "Exportar sessão em HTML",
					defaultPath: path.join(app.getPath("documents"), `${safeFileName(base)}.html`),
					filters: [{ name: "HTML", extensions: ["html"] }],
					properties: ["createDirectory", "showOverwriteConfirmation"],
				});
				if (result.canceled || !result.filePath) return { saved: false };
				const exported = await this.deps.requestHost<{ path?: string }>(
					"session.exportHtml",
					{
						workspaceId: request.workspaceId,
						sessionId: request.sessionId,
						destinationPath: result.filePath,
					},
					600_000,
				);
				return { saved: true, path: exported?.path ?? result.filePath };
			}

			case "session.subagentTranscript": {
				this.requireSession(request.workspaceId, request.sessionId);
				return await this.deps.requestHost("session.subagentTranscript", {
					workspaceId: request.workspaceId,
					sessionId: request.sessionId,
					subagentId: request.subagentId,
					fromByte: request.fromByte,
				});
			}

			case "settings.list":
				if (request.workspaceId) this.requireWorkspace(request.workspaceId);
				return await this.deps.requestHost("settings.list", { workspaceId: request.workspaceId });

			case "settings.listModels":
				return await this.deps.requestHost("settings.listModels", {}, 180_000);

			case "settings.save":
				if (request.workspaceId) this.requireWorkspace(request.workspaceId);
				return await this.deps.requestHost("settings.save", {
					workspaceId: request.workspaceId,
					scope: request.scope,
					key: request.key,
					value: request.value,
					expectedValue: request.expectedValue,
					expectedMissing: request.expectedMissing,
				});

			case "settings.applyPreset":
				this.requireWorkspace(request.workspaceId);
				this.requireSession(request.workspaceId, request.sessionId);
				return await this.deps.requestHost(
					"settings.applyPreset",
					{
						workspaceId: request.workspaceId,
						sessionId: request.sessionId,
						name: request.name,
					},
					240_000,
				);

			case "account.usage":
				if (request.workspaceId) this.requireWorkspace(request.workspaceId);
				return await this.deps.requestHost("account.usage", { workspaceId: request.workspaceId }, 240_000);

			case "terminal.create": {
				const workspace = await this.requireAvailableWorkspace(request.workspaceId);
				const win = this.requireWindow();
				const cwd = await assertWorkspaceDirectory(workspace.path);
				const shellPath = await this.deps.runtime.resolveShell();
				const info = await this.deps.terminals.create({
					workspaceId: request.workspaceId,
					cwd,
					ownerId: win.webContents.id,
					shellPath,
				});
				return { terminalId: info.terminalId, shell: info.shell, cwd: info.cwd };
			}

			case "terminal.write": {
				this.requireTerminal(request.terminalId);
				if (!this.deps.terminals.write(request.terminalId, request.data)) {
					throw new HostClientError("INVALID_REQUEST", "O terminal já foi encerrado.");
				}
				return { written: true };
			}

			case "terminal.resize": {
				this.requireTerminal(request.terminalId);
				if (!this.deps.terminals.resize(request.terminalId, request.cols, request.rows)) {
					throw new HostClientError("INVALID_REQUEST", "O terminal já foi encerrado.");
				}
				return { resized: true };
			}

			case "terminal.close": {
				this.requireTerminal(request.terminalId);
				await this.deps.terminals.close(request.terminalId);
				return { closed: true };
			}

			case "git.status": {
				const workspace = await this.requireAvailableWorkspace(request.workspaceId);
				return (await gitStatus(workspace.path)) satisfies GitStatusResult;
			}

			case "git.diff": {
				const workspace = await this.requireAvailableWorkspace(request.workspaceId);
				return (await gitDiff(workspace.path, request.path, request.source)) satisfies GitDiffResult;
			}

			case "git.stage": {
				const workspace = await this.requireAvailableWorkspace(request.workspaceId);
				return await gitStage(workspace.path, request.paths);
			}

			case "git.unstage": {
				const workspace = await this.requireAvailableWorkspace(request.workspaceId);
				return await gitUnstage(workspace.path, request.paths);
			}

			case "git.commit": {
				const workspace = await this.requireAvailableWorkspace(request.workspaceId);
				return (await gitCommit(workspace.path, request.message)) satisfies GitCommitResult;
			}

			case "files.read": {
				const workspace = await this.requireAvailableWorkspace(request.workspaceId);
				return await readWorkspaceFile(workspace.path, request.path);
			}

			case "files.openExternal": {
				const workspace = await this.requireAvailableWorkspace(request.workspaceId);
				const filePath = await resolveFileForExternalOpen(workspace.path, request.path);
				// Allowlist: só extensões inofensivas são entregues ao app padrão.
				// Qualquer outro tipo (executável/script/atalho/HTML ativo) apenas
				// aparece no Explorer; o Windows não o executa.
				if (externalOpenMode(filePath) === "reveal") {
					shell.showItemInFolder(filePath);
					return { opened: false, revealed: true };
				}
				const failure = await shell.openPath(filePath);
				if (failure) {
					throw new HostClientError(
						"INTERNAL",
						"Não foi possível abrir o arquivo no editor externo. Verifique o aplicativo padrão do Windows.",
					);
				}
				return { opened: true, revealed: false };
			}

			case "attachment.pick": {
				this.requireWorkspace(request.workspaceId);
				const win = this.requireWindow();
				const result = await dialog.showOpenDialog(win, {
					title: "Anexar arquivos",
					properties: ["openFile", "multiSelections"],
					filters: [
						{ name: "Imagens", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
						{ name: "Texto", extensions: ["txt", "md", "json", "csv", "pdf"] },
						{ name: "Todos os arquivos", extensions: ["*"] },
					],
				});
				if (result.canceled || result.filePaths.length === 0) return [];
				const selected = result.filePaths.slice(0, MAX_ATTACHMENTS_PER_PICK);
				const files: string[] = [];
				for (const filePath of selected) {
					const info = await stat(filePath);
					if (!info.isFile()) continue;
					if (info.size > MAX_ATTACHMENT_BYTES) {
						throw new HostClientError(
							"FRAME_TOO_LARGE",
							`O arquivo ${path.basename(filePath)} tem ${(info.size / 1024).toFixed(0)} KiB; o limite por anexo é ${MAX_ATTACHMENT_BYTES / 1024} KiB. Reduza a imagem ou anexe outro arquivo.`,
						);
					}
					files.push(filePath);
				}
				const attachments: AttachmentDto[] = [];
				for (const filePath of files) {
					const bytes = await readFile(filePath);
					const dto = await this.deps.requestHost<AttachmentDto>("attachment.add", {
						workspaceId: request.workspaceId,
						name: path.basename(filePath),
						mimeType: mimeForFile(filePath),
						bytesBase64: bytes.toString("base64"),
					});
					if (!dto || typeof dto.attachmentId !== "string") {
						throw new HostClientError("INTERNAL", "O serviço local não registrou o anexo.");
					}
					this.deps.attachments.add(request.workspaceId, dto);
					attachments.push(dto);
				}
				return attachments;
			}

			case "attachment.import": {
				this.requireWorkspace(request.workspaceId);
				const bytes = request.bytes;
				if (bytes.byteLength === 0) {
					throw new HostClientError("INVALID_REQUEST", "O anexo está vazio.");
				}
				if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
					throw new HostClientError(
						"FRAME_TOO_LARGE",
						`O anexo tem ${(bytes.byteLength / 1024).toFixed(0)} KiB; o limite por anexo é ${MAX_ATTACHMENT_BYTES / 1024} KiB.`,
					);
				}
				const dto = await this.deps.requestHost<AttachmentDto>("attachment.add", {
					workspaceId: request.workspaceId,
					name: request.name,
					mimeType: request.mimeType,
					bytesBase64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
				});
				if (!dto || typeof dto.attachmentId !== "string") {
					throw new HostClientError("INTERNAL", "O serviço local não registrou o anexo.");
				}
				this.deps.attachments.add(request.workspaceId, dto);
				return dto;
			}

			case "attachment.remove": {
				const workspaceId = this.deps.attachments.workspaceOf(request.attachmentId);
				if (!workspaceId) {
					throw new HostClientError("INVALID_REQUEST", "O anexo não está mais disponível neste aplicativo.");
				}
				await this.deps.requestHost("attachment.remove", { attachmentId: request.attachmentId });
				this.deps.attachments.remove(request.attachmentId);
				return { removed: true };
			}
		}
		throw new HostClientError(
			"UNSUPPORTED",
			"Esta versão do aplicativo não reconhece a operação solicitada.",
		);
	}
}
