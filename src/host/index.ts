/**
 * Host Bun do OMP Desktop.
 *
 * Protocolo privado (somente JSONL no stdout; logs vão para arquivo/stderr):
 *   stdin  <- {kind:'request', id, op, payload}
 *   stdout -> {kind:'response', id, ok:true, data} | {kind:'response', id, ok:false, error}
 *           -> {kind:'event', workspaceId, sessionId?, generation, sequence, name, data}
 *           -> {kind:'chunk', id, index, count, bytes, responseId?|event?, data}
 *              (mensagens grandes; data é base64 de uma fatia UTF-8 e o cliente
 *               remonta antes de decodificar o JSON original)
 *
 * Ops repassadas 1:1 do renderer (mesmo payload de `contracts.ts`):
 *   session.list/create/open/close/snapshot/rpc/uiResponse/subagentTranscript,
 *   settings.list/save/applyPreset, account.usage, workspace.list,
 *   workspace.removeRecent, attachment.remove.
 *
 * Ops internas enriquecidas pelo main (o renderer não as envia):
 *   workspace.add {path}                                  -> WorkspaceDto
 *   workspace.relocate {workspaceId, path}                -> WorkspaceDto
 *   workspace.removeRecent {workspaceId}                  -> {removed:true}
 *   attachment.add {workspaceId, name, mimeType, bytesBase64} -> AttachmentDto
 *   attachment.remove {attachmentId}                      -> {removed:true}
 *   session.exportHtml {workspaceId, sessionId, destinationPath} -> {path}
 *   host.status {}                                        -> RuntimeStatus parcial
 *
 * Ops de main/Electron (runtime.*, ui.*, terminal.*, git.*, files.*,
 * workspace.pick, attachment.pick) não são tratadas aqui.
 *
 * Args do host: --data-dir <dir> | OMP_DESKTOP_DATA_DIR,
 *               --omp-path <exe> | OMP_DESKTOP_OMP_PATH,
 *               --profile <nome> | OMP_DESKTOP_PROFILE.
 * Nenhuma operação encerra processos por nome; só a árvore de PIDs iniciada.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	desktopRequestSchema,
	ERROR_CODES,
	hostRequestSchema,
	type DesktopEvent,
	type RuntimeStatus,
} from "../shared/contracts";
import { isRecord } from "../shared/session-state";
import { isApprovalMode } from "../shared/session-types";
import { readAccountUsage } from "./accounts";
import { AttachmentStore } from "./attachments";
import { JsonlWriter } from "./jsonl-writer";
import { HostLogger } from "./log";
import { readOmpVersion, resolveOmpPath, runOmp } from "./omp-cli";
import { projectRuntimeStatus } from "./sanitize";
import { SettingsService } from "./settings";
import { SessionsService } from "./sessions";
import { WorkspaceStore } from "./workspaces";

interface HostArgs {
	dataDir?: string;
	ompPath?: string;
	profile?: string;
}

function parseHostArgs(argv: readonly string[]): HostArgs {
	const args: HostArgs = {};
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index];
		const next = argv[index + 1];
		const readValue = (): string | undefined => {
			if (next && !next.startsWith("--")) {
				index += 1;
				return next;
			}
			return undefined;
		};
		if (value === "--data-dir") args.dataDir = readValue();
		else if (value.startsWith("--data-dir=")) args.dataDir = value.slice("--data-dir=".length);
		else if (value === "--omp-path") args.ompPath = readValue();
		else if (value.startsWith("--omp-path=")) args.ompPath = value.slice("--omp-path=".length);
		else if (value === "--profile") args.profile = readValue();
		else if (value.startsWith("--profile=")) args.profile = value.slice("--profile=".length);
	}
	return args;
}

function defaultDataDir(): string {
	const configured = process.env.OMP_DESKTOP_DATA_DIR;
	if (configured && configured.trim().length > 0) return path.resolve(configured.trim());
	if (process.platform === "win32") {
		const appData = process.env.APPDATA;
		if (appData) return path.join(appData, "omp-desktop");
		return path.join(os.homedir(), "AppData", "Roaming", "omp-desktop");
	}
	const xdg = process.env.XDG_DATA_HOME;
	// XDG_DATA_HOME só vale quando é absoluto; caso contrário o padrão da
	// especificação é $HOME/.local/share.
	if (xdg && path.isAbsolute(xdg)) return path.join(xdg, "omp-desktop");
	return path.join(os.homedir(), ".local", "share", "omp-desktop");
}

/** Shell informado no status do host; precisa ser um caminho executável real. */
function hostShell(): string {
	if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
	const configured = process.env.SHELL;
	const unusable = /^(?:false|nologin|sync|shutdown|halt)$/i;
	if (configured && path.isAbsolute(configured) && !unusable.test(path.basename(configured))) {
		try {
			fs.accessSync(configured, fs.constants.X_OK);
			return configured;
		} catch {
			/* $SHELL inválido: cai no shell POSIX padrão */
		}
	}
	return "/bin/sh";
}

class HostFailure extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "HostFailure";
	}
}

function errorCodeOf(error: unknown): string {
	if (error && typeof error === "object" && "code" in error) {
		const code = error.code;
		if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) return code;
	}
	return "INTERNAL";
}

function errorMessageOf(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) return error.message;
	return "O serviço local não conseguiu concluir a operação.";
}

function errorBody(error: unknown): { code: string; message: string } {
	return { code: errorCodeOf(error), message: errorMessageOf(error) };
}

function payloadRecord(payload: unknown): Record<string, unknown> {
	return isRecord(payload) ? payload : {};
}

async function main(): Promise<void> {
	const args = parseHostArgs(process.argv.slice(2));
	const dataDir = args.dataDir ? path.resolve(args.dataDir) : defaultDataDir();
	// cwd neutro para operações globais (sem projeto): nunca o home, para o OMP
	// não tratar `~/.omp` como camada de projeto.
	const cliCwd = path.join(dataDir, "cli");
	const writer = new JsonlWriter();
	let logger: HostLogger;
	try {
		fs.mkdirSync(dataDir, { recursive: true });
		fs.mkdirSync(cliCwd, { recursive: true });
		logger = new HostLogger(dataDir);
	} catch (error) {
		const message = `Não foi possível preparar a pasta de dados do aplicativo (${dataDir}): ${(error as Error).message}`;
		writer.write({
			kind: "event",
			workspaceId: "host",
			generation: 0,
			sequence: 0,
			name: "host.status",
			data: { phase: "host-failed", message },
		});
		await writer.flush();
		process.stderr.write(`host: ${message}\n`);
		process.exit(1);
	}

	const workspaces = new WorkspaceStore(dataDir);
	await workspaces.load();
	const attachments = new AttachmentStore(dataDir);
	await attachments
		.cleanupOrphans()
		.then((removed) => {
			if (removed > 0) logger.info("anexos.orfaos_removidos", { removed });
		})
		.catch((error: unknown) => logger.warn("anexos.limpeza_falhou", { message: (error as Error).message }));
	const ompPath = resolveOmpPath(args.ompPath);
	let ompVersion: string | undefined;
	let status: Partial<RuntimeStatus> = { phase: "ready", bunPath: process.execPath };
	if (ompPath) {
		status.ompPath = ompPath;
		const version = await readOmpVersion(ompPath).catch(() => undefined);
		if (version) {
			ompVersion = version.raw;
			status.ompVersion = version.raw;
			if (!version.compatible) {
				status.message =
					`O OMP ${version.raw} é mais antigo que o mínimo suportado (18.16). Alguns recursos podem falhar; atualize o OMP.`;
			}
		}
	}
	let gitVersion: string | undefined;
	try {
		const git = await runOmp("git", ["--version"], { timeoutMs: 10_000 });
		if (git.exitCode === 0) {
			const match = /git version ([^\s]+)/.exec(git.stdout);
			gitVersion = match?.[1];
		}
	} catch {
		gitVersion = undefined;
	}
	status.gitVersion = gitVersion;
	status.shell = hostShell();
	const profile = args.profile ?? process.env.OMP_DESKTOP_PROFILE ?? undefined;
	const settings = new SettingsService(() => ({
		ompPath: ompPath ?? resolveOmpPath(),
	}));
	const sessions = new SessionsService({
		workspaces,
		attachments,
		settings,
		dataDir,
		ompPath,
		defaultProfile: profile,
		log: logger,
		emit: (event: DesktopEvent) => writer.write(event),
	});

	const readyStatus = projectRuntimeStatus({ ...status, phase: "ready" });
	writer.write({
		kind: "event",
		workspaceId: "host",
		generation: 0,
		sequence: 0,
		name: "host.status",
		data: readyStatus,
	});
	logger.info("host.pronto", {
		ompPath: ompPath ?? null,
		ompVersion: ompVersion ?? null,
		bunPath: process.execPath,
		gitVersion: gitVersion ?? null,
		dataDir,
	});
	// Restaura as abas persistidas sem prompt, fora do caminho crítico do boot.
	// No app desktop a interface restaura só a aba ativa (OMP_DESKTOP_LAZY_TABS):
	// cada aba restaurada sobe um processo OMP e o conjunto esgota a memória.
	if (process.env.OMP_DESKTOP_LAZY_TABS !== "1") {
		setTimeout(() => {
			void sessions.startRestore().catch((error: unknown) => {
				logger.warn("abas.restaurar_geral_falhou", { message: (error as Error).message });
			});
		}, 0);
	}

	await handleStdin(
		writer,
		logger,
		sessions,
		workspaces,
		attachments,
		settings,
		ompPath,
		cliCwd,
		() =>
			projectRuntimeStatus({
				...status,
				phase: "ready",
			}),
	);
}

async function handleStdin(
	writer: JsonlWriter,
	logger: HostLogger,
	sessions: SessionsService,
	workspaces: WorkspaceStore,
	attachments: AttachmentStore,
	settings: SettingsService,
	ompPath: string | undefined,
	cliCwd: string,
	status: () => Partial<RuntimeStatus>,
): Promise<void> {
	let shuttingDown = false;

	const shutdown = async (reason: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info("host.encerrando", { reason });
		try {
			await sessions.closeAll();
		} catch (error) {
			logger.warn("host.fechar_sessoes_falhou", { message: (error as Error).message });
		}
		await writer.flush();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("uncaughtException", (error) => {
		logger.error("host.excecao_nao_tratada", { message: error.message });
	});
	process.on("unhandledRejection", (error) => {
		logger.error("host.promessa_rejeitada", {
			message: error instanceof Error ? error.message : String(error),
		});
	});

	const dispatch = async (line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			logger.warn("host.linha_invalida", { bytes: line.length });
			return;
		}
		const envelope = hostRequestSchema.safeParse(parsed);
		if (!envelope.success) {
			const raw = isRecord(parsed) ? parsed : {};
			const id = typeof raw.id === "string" ? raw.id : undefined;
			if (id) {
				writer.write({
					kind: "response",
					id,
					ok: false,
					error: { code: "INVALID_REQUEST", message: "O pedido ao serviço local tem formato inválido." },
				});
			}
			return;
		}
		const request = envelope.data;
		const started = Date.now();
		logger.info("host.request", { op: request.op, id: request.id });
		try {
			if (shuttingDown) {
				throw new HostFailure("HOST_EXITED", "O serviço local está encerrando.");
			}
			const data = await routeRequest(request.op, request.payload, {
				sessions,
				workspaces,
				attachments,
				settings,
				ompPath,
				cliCwd,
				status,
			});
			writer.write({ kind: "response", id: request.id, ok: true, data: data ?? null });
		} catch (error) {
			const body = errorBody(error);
			logger.warn("host.request_falhou", {
				op: request.op,
				id: request.id,
				code: body.code,
				messageLength: body.message.length,
				durationMs: Date.now() - started,
			});
			writer.write({ kind: "response", id: request.id, ok: false, error: body });
		}
	};

	const reader = Bun.stdin.stream().getReader();
	const decoder = new TextDecoder("utf-8");
	let carry: Uint8Array = new Uint8Array(0);
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			let start = 0;
			for (let index = 0; index < value.byteLength; index++) {
				if (value[index] !== 0x0a) continue;
				const slice = value.subarray(start, index);
				const lineBytes =
					carry.byteLength > 0 ? concatBytes(carry, slice) : slice;
				carry = new Uint8Array(0);
				start = index + 1;
				const line = decoder.decode(lineBytes).replace(/\r$/, "").trim();
				if (line.length === 0) continue;
				void dispatch(line);
			}
			if (start < value.byteLength) carry = concatBytes(carry, value.subarray(start));
			if (carry.byteLength > 64 * 1024 * 1024) {
				logger.error("host.linha_grande", { bytes: carry.byteLength });
				await shutdown("linha maior que o limite");
				return;
			}
		}
	} catch (error) {
		logger.error("host.stdin_falhou", { message: (error as Error).message });
	}
	await shutdown("stdin encerrado");
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	if (left.byteLength === 0) return right;
	if (right.byteLength === 0) return left;
	const out = new Uint8Array(left.byteLength + right.byteLength);
	out.set(left, 0);
	out.set(right, left.byteLength);
	return out;
}

interface RouteContext {
	sessions: SessionsService;
	workspaces: WorkspaceStore;
	attachments: AttachmentStore;
	settings: SettingsService;
	ompPath?: string;
	/** cwd neutro para operações sem workspace (nunca o home). */
	cliCwd: string;
	status: () => Partial<RuntimeStatus>;
}

/** Operações resolvidas no Electron main; nunca devem chegar ao host. */
const MAIN_ONLY_OPS: Record<string, true> = {
	"runtime.status": true,
	"runtime.selectOmp": true,
	"runtime.installOmp": true,
	"runtime.dependencies": true,
	"runtime.installDependency": true,
	"runtime.openExternal": true,
	"ui.getState": true,
	"ui.setState": true,
	"workspace.pick": true,
	"terminal.create": true,
	"terminal.write": true,
	"terminal.resize": true,
	"terminal.close": true,
	"git.status": true,
	"git.diff": true,
	"git.stage": true,
	"git.unstage": true,
	"git.commit": true,
	"files.read": true,
	"files.openExternal": true,
	"attachment.pick": true,
	"attachment.import": true,
};

function stringField(record: Record<string, unknown>, key: string, label: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new HostFailure("INVALID_REQUEST", `Informe ${label}.`);
	}
	return value;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validateDesktopPayload(op: string, payload: unknown): Record<string, unknown> {
	const candidate = { op, ...payloadRecord(payload) };
	const parsed = desktopRequestSchema.safeParse(candidate);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
		throw new HostFailure(
			"INVALID_REQUEST",
			`O pedido "${op}" tem dados inválidos${where}: ${issue?.message ?? "formato inesperado"}.`,
		);
	}
	const data: unknown = parsed.data;
	if (!isRecord(data)) {
		throw new HostFailure("INVALID_REQUEST", `O pedido "${op}" tem formato inesperado.`);
	}
	return data;
}

async function routeRequest(op: string, payload: unknown, context: RouteContext): Promise<unknown> {
	switch (op) {
		case "host.status":
			return context.status();
		case "workspace.add": {
			const pathValue = optionalStringField(payloadRecord(payload), "path");
			if (!pathValue) throw new HostFailure("INVALID_REQUEST", "Informe a pasta do projeto.");
			return await context.workspaces.add(pathValue);
		}
		case "workspace.relocate": {
			const record = payloadRecord(payload);
			const workspaceId = stringField(record, "workspaceId", "o projeto");
			await context.sessions.closeWorkspace(workspaceId);
			return await context.workspaces.relocate(workspaceId, stringField(record, "path", "a nova pasta"));
		}
		case "attachment.add": {
			const record = payloadRecord(payload);
			const workspaceId = stringField(record, "workspaceId", "o projeto do anexo");
			await context.workspaces.require(workspaceId);
			return await context.attachments.add({
				workspaceId,
				name: stringField(record, "name", "o nome do anexo"),
				mimeType: stringField(record, "mimeType", "o tipo do anexo"),
				bytesBase64: stringField(record, "bytesBase64", "o conteúdo do anexo"),
			});
		}
		case "session.exportHtml": {
			const record = payloadRecord(payload);
			const destinationPath = stringField(record, "destinationPath", "o destino da exportação");
			if (!path.isAbsolute(destinationPath) || destinationPath.includes("\0")) {
				throw new HostFailure("INVALID_REQUEST", "O destino da exportação precisa ser um caminho absoluto válido.");
			}
			return await context.sessions.exportHtml({
				workspaceId: stringField(record, "workspaceId", "o projeto"),
				sessionId: stringField(record, "sessionId", "a sessão"),
				destinationPath,
			});
		}
		case "session.rpc": {
			const data = validateDesktopPayload(op, payload);
			return await context.sessions.rpc({
				workspaceId: stringField(data, "workspaceId", "o projeto"),
				sessionId: stringField(data, "sessionId", "a sessão"),
				command: data.command,
			});
		}
		case "session.uiResponse": {
			const data = validateDesktopPayload(op, payload);
			return await context.sessions.uiResponse({
				workspaceId: stringField(data, "workspaceId", "o projeto"),
				sessionId: stringField(data, "sessionId", "a sessão"),
				response: data.response,
			});
		}
		case "session.subagentTranscript": {
			const data = validateDesktopPayload(op, payload);
			return await context.sessions.subagentTranscript({
				workspaceId: stringField(data, "workspaceId", "o projeto"),
				sessionId: stringField(data, "sessionId", "a sessão"),
				subagentId: stringField(data, "subagentId", "o agente"),
				fromByte: typeof data.fromByte === "number" ? data.fromByte : undefined,
			});
		}
		case "session.create": {
			const data = validateDesktopPayload(op, payload);
			return await context.sessions.create(stringField(data, "workspaceId", "o projeto"), {
				approvalMode: isApprovalMode(data.approvalMode) ? data.approvalMode : undefined,
			});
		}
		case "session.open": {
			const data = validateDesktopPayload(op, payload);
			return await context.sessions.open(
				stringField(data, "workspaceId", "o projeto"),
				stringField(data, "sessionPath", "a sessão"),
				{
					trustedPath: data.trustedPath === true,
					approvalMode: isApprovalMode(data.approvalMode) ? data.approvalMode : undefined,
				},
			);
		}
		case "session.close": {
			const data = validateDesktopPayload(op, payload);
			return await context.sessions.close(
				stringField(data, "workspaceId", "o projeto"),
				stringField(data, "sessionId", "a sessão"),
			);
		}
		case "session.snapshot": {
			const data = validateDesktopPayload(op, payload);
			return await context.sessions.snapshot(
				stringField(data, "workspaceId", "o projeto"),
				stringField(data, "sessionId", "a sessão"),
			);
		}
		case "session.list": {
			const data = validateDesktopPayload(op, payload);
			return await context.sessions.list(stringField(data, "workspaceId", "o projeto"));
		}
		case "settings.list": {
			const data = validateDesktopPayload(op, payload);
			const workspaceId = optionalStringField(data, "workspaceId");
			const cwd = workspaceId
				? (await context.workspaces.require(workspaceId)).path
				: context.cliCwd;
			return await context.settings.list(cwd);
		}
		case "settings.listModels": {
			validateDesktopPayload(op, payload);
			return await context.settings.listModels(context.cliCwd);
		}
		case "settings.save": {
			const data = validateDesktopPayload(op, payload);
			const workspaceId = optionalStringField(data, "workspaceId");
			if (data.scope === "project" && !workspaceId) {
				throw new HostFailure(
					"INVALID_REQUEST",
					"O escopo de projeto exige um projeto aberto.",
				);
			}
			const cwd = workspaceId
				? (await context.workspaces.require(workspaceId)).path
				: context.cliCwd;
			return await context.settings.save({
				cwd,
				scope: data.scope === "project" ? "project" : "global",
				key: stringField(data, "key", "a configuração"),
				value: data.value,
				expectedValue: data.expectedValue,
				expectedMissing: data.expectedMissing === true ? true : undefined,
			});
		}
		case "settings.applyPreset": {
			const data = validateDesktopPayload(op, payload);
			return await context.sessions.applyPreset({
				workspaceId: stringField(data, "workspaceId", "o projeto"),
				sessionId: stringField(data, "sessionId", "a sessão"),
				name: stringField(data, "name", "o preset"),
			});
		}
		case "account.usage": {
			const data = validateDesktopPayload(op, payload);
			const workspaceId = optionalStringField(data, "workspaceId");
			const cwd = workspaceId
				? (await context.workspaces.require(workspaceId)).path
				: context.cliCwd;
			const ompPath = context.ompPath ?? resolveOmpPath();
			if (!ompPath) {
				throw new HostFailure("OMP_UNAVAILABLE", "O executável do OMP não foi encontrado.");
			}
			return await readAccountUsage({ ompPath, cwd });
		}
		case "workspace.list":
			return await context.workspaces.list();
		case "workspace.removeRecent": {
			const data = validateDesktopPayload(op, payload);
			const workspaceId = stringField(data, "workspaceId", "o projeto");
			await context.sessions.closeWorkspace(workspaceId);
			await context.workspaces.removeRecent(workspaceId);
			return { removed: true };
		}
		case "attachment.remove": {
			const data = validateDesktopPayload(op, payload);
			await context.attachments.remove(stringField(data, "attachmentId", "o anexo"));
			return { removed: true };
		}
		default:
			if (op in MAIN_ONLY_OPS) {
				throw new HostFailure(
					"UNSUPPORTED",
					`A operação "${op}" é tratada pelo processo principal e não deve chegar ao host.`,
				);
			}
			throw new HostFailure("INVALID_REQUEST", `Operação desconhecida: "${op}".`);
	}
}

function reportFatal(error: unknown): void {
	process.stderr.write(`host: ${errorMessageOf(error)}\n`);
}

main().catch((error: unknown) => {
	reportFatal(error);
	process.exit(1);
});
