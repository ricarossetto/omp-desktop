/**
 * Processo principal do OMP Desktop.
 *
 * Janela única, preload isolado, comunicação com o host Bun e estados visíveis
 * (janela carregando, host iniciando, OMP pronto, falha). Nenhum processo é
 * encerrado por nome: somente árvores dos PIDs que este app iniciou.
 */
import {
	app,
	BrowserWindow,
	dialog,
	Menu,
	nativeTheme,
	screen,
	session,
	type WebContents,
} from "electron";
import { access, appendFile, mkdir, rename, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { DesktopEvent, RuntimeStatus, WorkspaceDto } from "../shared/contracts";
import { buildHostEnv, HostClient, HostClientError, redactLogLine } from "./host-client";
import { MainBridge } from "./ipc";
import { isAllowedRendererUrl, rendererFileUrl, validateDevRendererUrl } from "./ipc-guard";
import { readJsonFile, writeJsonAtomic } from "./json-store";
import { assertWorkspaceDirectory } from "./paths";
import { AttachmentRegistry, SessionRegistry, WorkspaceRegistry } from "./registries";
import { isOmpVersionCompatible, RuntimeResolver } from "./runtime";
import { sanitizeForRenderer } from "./sanitize";
import { TerminalManager, terminalPids } from "./terminal";
import { UiStateStore } from "./ui-state";
import { restoreWindowBounds, type StoredWindowState } from "./window-state";

const APP_TITLE = "OMP Desktop";
const RETRY_HOST = "omp-desktop.invalid";
const RETRY_PATH = "/retry";

function argValue(flag: string, args: string[] = process.argv.slice(1)): string | undefined {
	for (let index = 0; index < args.length; index += 1) {
		const current = args[index];
		if (current === flag) {
			const next = args[index + 1];
			if (next && !next.startsWith("--")) return next;
			return undefined;
		}
		const prefix = `${flag}=`;
		if (current.startsWith(prefix)) return current.slice(prefix.length);
	}
	return undefined;
}

const userDataOverride = argValue("--user-data-dir");
if (userDataOverride) {
	try {
		app.setPath("userData", path.resolve(userDataOverride));
	} catch {
		/* caminho inválido: mantém o padrão */
	}
}

app.setAppUserModelId("local.omp.desktop");

const smokeReportArg = argValue("--smoke-report");
const initialCwdArg = argValue("--cwd");

let mainWindow: BrowserWindow | null = null;
let uiState: UiStateStore;
let runtime: RuntimeResolver;
let bridge: MainBridge;
let host: HostClient | null = null;
let hostStarted = false;
let hostReady = false;
let hostPid: number | undefined;
let restartingHost = false;
let shuttingDown = false;
let promptInFlight = false;
let rendererLoaded = false;
let showingError = false;
let retrying = false;
let initialCwdConsumed = false;
let hostStatusSequence = 0;
let selectedOmpPath: string | undefined;
let runtimeStatus: RuntimeStatus = { phase: "starting-host", signed: false };
let savedWindowState: StoredWindowState | null = null;
let windowStateTimer: ReturnType<typeof setTimeout> | undefined;
const busySessions = new Set<string>();
const statusReady = Promise.withResolvers<void>();
const bootSettled = Promise.withResolvers<void>();

const workspaceRegistry = new WorkspaceRegistry();
const sessionRegistry = new SessionRegistry();
const attachmentRegistry = new AttachmentRegistry();

const repoRoot = app.getAppPath();
const rendererIndexPath = path.join(repoRoot, "out", "renderer", "index.html");
const preloadPath = path.join(repoRoot, "out", "preload", "index.cjs");
const productionFileUrl = rendererFileUrl(rendererIndexPath);
const devUrl = app.isPackaged ? undefined : validateDevRendererUrl(process.env.ELECTRON_RENDERER_URL);
const userDataDir = app.getPath("userData");
const logFile = path.join(userDataDir, "logs", "main.log");
const windowStateFile = path.join(userDataDir, "window-state.json");
const smokeReportPath = smokeReportArg ? path.resolve(smokeReportArg) : undefined;
const smokeState = { wrote: false };

let logChain: Promise<void> = Promise.resolve();
let terminals: TerminalManager;

function log(level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>): void {
	const payload = {
		at: new Date().toISOString(),
		level,
		event,
		...(fields ? (sanitizeForRenderer(fields) as Record<string, unknown>) : {}),
	};
	let line: string;
	try {
		line = redactLogLine(JSON.stringify(payload));
	} catch {
		line = redactLogLine(JSON.stringify({ at: new Date().toISOString(), level, event }));
	}
	if (level === "error") console.error(line);
	logChain = logChain
		.then(async () => {
			await mkdir(path.dirname(logFile), { recursive: true });
			await appendFile(logFile, `${line}\n`, "utf8");
		})
		.catch(() => undefined);
}

async function rotateLogIfNeeded(): Promise<void> {
	try {
		const info = await stat(logFile);
		if (info.size > 2 * 1024 * 1024) {
			await rename(logFile, `${logFile}.1`).catch(() => undefined);
		}
	} catch {
		/* ainda não existe */
	}
}

function authorizedUrls(): { productionFileUrl?: string; devUrl?: string } {
	return { productionFileUrl, devUrl: devUrl ?? undefined };
}

/** Espera que não segura o processo sozinha (usada em timeouts de status). */
function delayUnref(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref?.();
	return promise;
}

function isTrustedRendererUrl(url: string): boolean {
	return isAllowedRendererUrl(url, {
		webContentsId: mainWindow?.webContents.id ?? -1,
		mainFrame: { url },
		productionFileUrl,
		devUrl: devUrl ?? undefined,
	});
}

/** O Chromium informa apenas a origem `file://` em checks de permissão. */
function isTrustedPermissionOrigin(url: string): boolean {
	if (url === "file://" || url === "file:///" || url === "file:") {
		return Boolean(productionFileUrl);
	}
	return isTrustedRendererUrl(url);
}

function emitStatus(): void {
	const win = mainWindow;
	if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
	if (!rendererLoaded) return;
	if (!isTrustedRendererUrl(win.webContents.getURL())) return;
	hostStatusSequence += 1;
	const event: DesktopEvent = {
		kind: "event",
		workspaceId: "host",
		generation: 0,
		sequence: hostStatusSequence,
		name: "host.status",
		data: sanitizeForRenderer(runtimeStatus),
	};
	win.webContents.send("omp:event", event);
}

function setStatus(patch: Partial<RuntimeStatus>): void {
	runtimeStatus = { ...runtimeStatus, ...patch };
	emitStatus();
	void maybeWriteSmokeReport();
}

function mergeHostStatus(data: unknown): void {
	if (typeof data !== "object" || data === null) return;
	const record = data as Record<string, unknown>;
	const phase = typeof record.phase === "string" ? record.phase : undefined;
	const next: RuntimeStatus = { ...runtimeStatus };
	if (typeof record.ompPath === "string") next.ompPath = record.ompPath;
	if (typeof record.ompVersion === "string") next.ompVersion = record.ompVersion;
	if (typeof record.bunPath === "string") next.bunPath = record.bunPath;
	if (typeof record.gitVersion === "string") next.gitVersion = record.gitVersion;
	if (typeof record.shell === "string") next.shell = record.shell;
	if (phase === "host-failed") {
		next.phase = "host-failed";
		next.message =
			typeof record.message === "string" && record.message.length > 0
				? record.message
				: "O serviço local não conseguiu iniciar.";
	} else if (phase === "ready") {
		hostReady = true;
		const compatibleByHost =
			typeof record.ompPath === "string" && isOmpVersionCompatible(typeof record.ompVersion === "string" ? record.ompVersion : undefined);
		if (compatibleByHost) {
			next.phase = "ready";
			next.ompPath = record.ompPath as string;
			if (typeof record.ompVersion === "string") next.ompVersion = record.ompVersion;
		} else if (
			runtimeStatus.phase !== "omp-missing" &&
			runtimeStatus.phase !== "omp-incompatible" &&
			runtimeStatus.phase !== "host-failed" &&
			isOmpVersionCompatible(runtimeStatus.ompVersion)
		) {
			next.phase = "ready";
		}
	}
	runtimeStatus = next;
	emitStatus();
	void maybeWriteSmokeReport();
}

function trackWork(event: DesktopEvent): void {
	const sessionId = event.sessionId;
	if (!sessionId) return;
	if (event.name === "session.status") {
		const data = event.data;
		if (typeof data === "object" && data !== null && "status" in data) {
			const status = (data as { status?: unknown }).status;
			if (status === "busy" || status === "starting") busySessions.add(sessionId);
			if (status === "settled" || status === "closed" || status === "error" || status === "interrupted") {
				busySessions.delete(sessionId);
			}
		}
		return;
	}
	if (event.name !== "frame") return;
	const data = event.data;
	if (typeof data !== "object" || data === null) return;
	const type = (data as { type?: unknown }).type;
	if (type === "agent_start") busySessions.add(sessionId);
	if (type === "session_settled") busySessions.delete(sessionId);
	if (type === "prompt_result") {
		const settled = (data as { sessionSettled?: unknown }).sessionSettled;
		if (settled === true) busySessions.delete(sessionId);
	}
}

function handleHostEvent(event: DesktopEvent): void {
	if (event.name === "host.status" && event.workspaceId === "host") {
		mergeHostStatus(event.data);
		return;
	}
	trackWork(event);
	void bridge.handleHostEvent(event);
}

function handleHostExit(info: { code: number | null; signal: string | null }): void {
	hostStarted = false;
	hostReady = false;
	const intentional = restartingHost || shuttingDown;
	notifySessionsBeforeCleanup(
		intentional ? "closed" : "error",
		intentional
			? "O serviço local foi encerrado; as sessões abertas foram fechadas."
			: "O serviço local encerrou inesperadamente. Os diálogos pendentes foram cancelados; reabra o aplicativo para continuar.",
	);
	busySessions.clear();
	sessionRegistry.clearAll();
	attachmentRegistry.clearAll();
	if (shuttingDown || restartingHost) return;
	log("error", "host.encerrou_inesperado", { code: info.code, signal: info.signal });
	runtimeStatus = {
		...runtimeStatus,
		phase: "host-failed",
		message: `O serviço local encerrou inesperadamente (código ${info.code ?? "desconhecido"}). Feche e reabra o aplicativo para recuperar as sessões.`,
	};
	emitStatus();
	void maybeWriteSmokeReport(true);
}

/**
 * Avisa a UI antes de limpar sessões do registro: status terminal faz os
 * diálogos pendentes sumirem. Só emite para sessões que ainda estavam abertas.
 */
function notifySessionsBeforeCleanup(status: "closed" | "error", message: string): void {
	if (!bridge) return;
	const records = sessionRegistry.list();
	if (records.length === 0) return;
	bridge.notifySessionsUnavailable(records, status, message);
}

/**
 * A escolha manual de `omp.exe` é persistida pelo RuntimeResolver e vence a
 * variável de ambiente; um caminho resolvido só é adotado se ainda não houver
 * seleção, para não sobrescrever o que o usuário escolheu.
 */
function adoptResolvedOmpPath(): void {
	if (!selectedOmpPath) selectedOmpPath = runtimeStatus.ompPath;
}

function hasActiveWork(): boolean {
	return terminals.hasActive() || busySessions.size > 0;
}

/** Leitura não estreitada pelo fluxo local (o host muda após awaits). */
function currentHost(): HostClient | null {
	return host;
}

function buildSmokeReport(): Record<string, unknown> {
	return {
		ok: rendererLoaded && hostStarted && runtimeStatus.phase === "ready",
		phase: runtimeStatus.phase,
		message: runtimeStatus.message ?? null,
		windowLoaded: rendererLoaded,
		hostStarted,
		hostReady,
		ompPath: runtimeStatus.ompPath ?? null,
		ompVersion: runtimeStatus.ompVersion ?? null,
		bunPath: runtimeStatus.bunPath ?? null,
		gitVersion: runtimeStatus.gitVersion ?? null,
		shell: runtimeStatus.shell ?? null,
		pids: {
			electron: process.pid,
			host: host?.pid ?? hostPid ?? null,
			terminals: terminalPids(terminals),
		},
		userDataDir,
		appPath: repoRoot,
		generatedAt: new Date().toISOString(),
	};
}

async function maybeWriteSmokeReport(forceFailure = false): Promise<void> {
	if (!smokeReportPath || smokeState.wrote) return;
	const terminalFailure =
		runtimeStatus.phase === "host-failed" ||
		runtimeStatus.phase === "omp-missing" ||
		runtimeStatus.phase === "omp-incompatible";
	if (!rendererLoaded && !forceFailure) return;
	if (!forceFailure && !terminalFailure && !(hostStarted && hostReady)) return;
	smokeState.wrote = true;
	try {
		await mkdir(path.dirname(smokeReportPath), { recursive: true });
		await writeFile(smokeReportPath, `${JSON.stringify(buildSmokeReport(), null, 2)}\n`, "utf8");
	} catch (error) {
		log("error", "smoke.relatorio_falhou", { message: (error as Error).message });
	}
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function errorPageHtml(message: string): string {
	return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<title>OMP Desktop — falha ao carregar</title>
<style>
html,body{height:100%;margin:0}
body{background:#111315;color:#E6E8EA;font-family:"Segoe UI Variable","Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center}
main{max-width:560px;padding:32px}
h1{font-size:20px;font-weight:600;margin:0 0 12px}
p{font-size:14px;line-height:1.5;color:#A4AAB2;margin:0 0 24px;white-space:pre-wrap}
button{font:inherit;font-size:14px;background:#83B4E8;color:#111315;border:0;border-radius:8px;padding:10px 16px;cursor:pointer}
button:focus-visible{outline:2px solid #E6E8EA;outline-offset:2px}
small{display:block;margin-top:16px;color:#A4AAB2;font-size:12px}
</style></head>
<body><main>
<h1>Não foi possível carregar a interface</h1>
<p>${escapeHtml(message)}</p>
<button id="retry" type="button">Tentar novamente</button>
<small>Se o problema continuar, verifique o OMP, o Bun e o arquivo de log do aplicativo.</small>
<script>
document.getElementById('retry').addEventListener('click', function () {
  window.location.href = 'https://${RETRY_HOST}${RETRY_PATH}';
});
</script>
</main></body></html>`;
}

async function showErrorPage(win: BrowserWindow, message: string): Promise<void> {
	if (win.isDestroyed() || shuttingDown) return;
	showingError = true;
	log("error", "janela.pagina_de_erro", { message });
	const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(errorPageHtml(message))}`;
	try {
		await win.loadURL(dataUrl);
	} catch (error) {
		log("error", "janela.pagina_de_erro_falhou", { message: (error as Error).message });
	}
}

async function loadApp(win: BrowserWindow): Promise<void> {
	showingError = false;
	const target = devUrl ?? productionFileUrl;
	try {
		await win.loadURL(target);
	} catch (error) {
		if (showingError) return;
		await showErrorPage(
			win,
			`Não foi possível abrir a interface em ${target}.\n\n${(error as Error).message}\n\nEm desenvolvimento, confirme que o servidor Vite está em execução (bun run dev).`,
		);
	}
}

async function retryFromErrorPage(): Promise<void> {
	if (retrying) return;
	retrying = true;
	try {
		log("info", "janela.reabrir");
		if (!host || !host.running) {
			runtime.invalidate();
			runtimeStatus = await runtime.buildStatus(true);
			adoptResolvedOmpPath();
			emitStatus();
			await startHost();
			await confirmHostStatus();
		}
		if (mainWindow && !mainWindow.isDestroyed()) await loadApp(mainWindow);
	} finally {
		retrying = false;
	}
}

function installPermissionHandlers(): void {
	const ses = session.defaultSession;
	ses.setPermissionRequestHandler((contents, permission, callback, details) => {
		const requestingUrl = "requestingUrl" in details ? details.requestingUrl : contents.getURL();
		const clipboard = permission === "clipboard-read" || permission === "clipboard-sanitized-write";
		callback(clipboard && isTrustedPermissionOrigin(requestingUrl));
	});
	ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
		if (permission !== "clipboard-read" && permission !== "clipboard-sanitized-write") return false;
		const url = requestingOrigin || contents?.getURL() || "";
		return isTrustedPermissionOrigin(url);
	});
}

function attachWindowSecurity(win: BrowserWindow): void {
	win.webContents.setWindowOpenHandler(({ url }) => {
		log("warn", "janela.abrir_url_bloqueada", { url: redactLogLine(url).slice(0, 300) });
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		// Em desenvolvimento o servidor Vite pode recarregar a página inteira
		// (HMR completo). Navegar dentro do próprio loopback é seguro e evita a
		// janela parar de atualizar depois de salvar um arquivo.
		if (!app.isPackaged && isTrustedRendererUrl(url)) return;
		event.preventDefault();
		try {
			const parsed = new URL(url);
			if (parsed.hostname === RETRY_HOST && parsed.pathname === RETRY_PATH) {
				void retryFromErrorPage();
				return;
			}
		} catch {
			/* URL inválida */
		}
		log("warn", "janela.navegacao_bloqueada", { url: redactLogLine(url).slice(0, 300) });
	});
	win.webContents.on("will-redirect", (event) => {
		event.preventDefault();
	});
	win.webContents.on("will-attach-webview", (event) => {
		event.preventDefault();
	});
}

function attachWindowDiagnostics(win: BrowserWindow): void {
	win.webContents.on("did-finish-load", () => {
		const url = win.webContents.getURL();
		if (!isTrustedRendererUrl(url)) return;
		rendererLoaded = true;
		log("info", "janela.carregada", { url: url.slice(0, 300) });
		emitStatus();
		void maybeWriteSmokeReport();
	});
	win.webContents.on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
		if (!isMainFrame || code === -3) return;
		if (validatedURL.startsWith("data:")) return;
		log("error", "janela.falha_carregar", {
			code,
			description,
			url: redactLogLine(validatedURL).slice(0, 300),
		});
		rendererLoaded = false;
		void showErrorPage(
			win,
			`A janela não carregou (${description || code}).\nEndereço: ${validatedURL}\n\nTente novamente.`,
		);
	});
	win.webContents.on("render-process-gone", (_event, details) => {
		log("error", "janela.renderer_encerrou", { reason: details.reason, exitCode: details.exitCode });
		rendererLoaded = false;
		void showErrorPage(
			win,
			`A interface do aplicativo foi encerrada inesperadamente (${details.reason}).\n\nNenhum prompt foi reenviado. Tente reabrir a interface.`,
		);
	});
	win.webContents.on("preload-error", (_event, preload, error) => {
		log("error", "janela.preload_falhou", { preload, message: error.message });
		rendererLoaded = false;
		void showErrorPage(
			win,
			`O preload de segurança não pôde ser carregado.\n\n${error.message}\n\nReinstale o aplicativo se o erro continuar.`,
		);
	});
	win.webContents.on("unresponsive", () => {
		log("warn", "janela.sem_resposta");
	});
	win.webContents.on("console-message", (details, level, message) => {
		const levelName = details.level ?? (level === 3 ? "error" : level === 2 ? "warning" : "info");
		const text = details.message ?? message ?? "";
		if (levelName !== "error") return;
		log("error", "renderer.console", { message: redactLogLine(text).slice(0, 500) });
	});
	win.on("resize", scheduleSaveWindowState);
	win.on("move", scheduleSaveWindowState);
	win.on("maximize", scheduleSaveWindowState);
	win.on("unmaximize", scheduleSaveWindowState);
}

function scheduleSaveWindowState(): void {
	clearTimeout(windowStateTimer);
	windowStateTimer = setTimeout(() => {
		void saveWindowState();
	}, 500);
}

async function saveWindowState(): Promise<void> {
	const win = mainWindow;
	if (!win || win.isDestroyed()) return;
	try {
		const maximized = win.isMaximized();
		const bounds = maximized ? win.getNormalBounds() : win.getBounds();
		savedWindowState = { ...bounds, maximized };
		await writeJsonAtomic(windowStateFile, savedWindowState);
	} catch (error) {
		log("warn", "janela.estado_falhou", { message: (error as Error).message });
	}
}

/** Cores do overlay nativo (minimizar, maximizar, fechar), alinhadas aos tokens --bg e --text. */
export const TITLEBAR_HEIGHT = 36;
function titleBarOverlayColors(): { color: string; symbolColor: string; height: number } {
	const dark = nativeTheme.shouldUseDarkColors;
	return {
		color: dark ? "#0e1013" : "#e4e8ed",
		symbolColor: dark ? "#e6e9ee" : "#151920",
		height: TITLEBAR_HEIGHT,
	};
}

/** Mantém overlay nativo e fundo da janela coerentes com o tema efetivo. */
function syncTitleBarTheme(win: BrowserWindow | null = mainWindow): void {
	if (!win || win.isDestroyed()) return;
	win.setTitleBarOverlay(titleBarOverlayColors());
	win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#0e1013" : "#e4e8ed");
}

/** O tema escolhido no app também decide as cores do overlay nativo. */
export function applyThemeSource(theme: unknown): void {
	if (theme === "light" || theme === "dark" || theme === "system") nativeTheme.themeSource = theme;
	syncTitleBarTheme();
}

function createWindow(): BrowserWindow {
	const displays = screen.getAllDisplays().map((display) => display.workArea);
	const restored = restoreWindowBounds(savedWindowState, displays, {
		width: 1440,
		height: 920,
		minWidth: 1000,
		minHeight: 700,
	});
	const win = new BrowserWindow({
		...restored.bounds,
		minWidth: 1000,
		minHeight: 700,
		show: false,
		center: restored.bounds.x === undefined,
		title: APP_TITLE,
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e1013" : "#e4e8ed",
		autoHideMenuBar: true,
		// Barra de título própria: o renderer desenha marca, título e ações;
		// minimizar, maximizar e fechar continuam nativos do Windows (overlay).
		titleBarStyle: "hidden",
		titleBarOverlay: titleBarOverlayColors(),
		webPreferences: {
			preload: preloadPath,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webviewTag: false,
			spellcheck: false,
		},
	});
	win.setMenu(null);
	const syncTitleBar = () => syncTitleBarTheme(win);
	nativeTheme.on("updated", syncTitleBar);
	win.once("closed", () => nativeTheme.off("updated", syncTitleBar));
	if (restored.maximized) win.maximize();
	attachWindowSecurity(win);
	attachWindowDiagnostics(win);
	win.once("ready-to-show", () => {
		if (!win.isDestroyed()) win.show();
	});
	const showFallback = setTimeout(() => {
		if (!win.isDestroyed() && !win.isVisible()) win.show();
	}, 4000);
	showFallback.unref?.();
	win.on("close", (event) => {
		if (shuttingDown) return;
		event.preventDefault();
		void promptAndShutdown();
	});
	win.on("closed", () => {
		mainWindow = null;
	});
	return win;
}

async function addWorkspaceAt(dirValue: string): Promise<WorkspaceDto | null> {
	try {
		const real = await assertWorkspaceDirectory(path.resolve(dirValue));
		if (!host || !host.running) return null;
		const dto = await host.request<WorkspaceDto>("workspace.add", { path: real }, { timeoutMs: 60_000 });
		if (dto && typeof dto.workspaceId === "string" && typeof dto.path === "string") {
			workspaceRegistry.add(dto);
			log("info", "workspace.inicial_aberto", { workspaceId: dto.workspaceId });
			return dto;
		}
		return null;
	} catch (error) {
		log("warn", "workspace.inicial_falhou", { message: (error as Error).message });
		return null;
	}
}

async function confirmHostStatus(): Promise<void> {
	if (!host || !host.running) return;
	try {
		const info = await host.request<unknown>("host.status", {}, { timeoutMs: 60_000 });
		mergeHostStatus(info);
	} catch (error) {
		log("warn", "host.status_falhou", { message: (error as Error).message });
	}
}

async function startHost(): Promise<void> {
	if (host?.running) return;
	if (host) {
		try {
			await host.close(5000);
		} catch {
			/* já encerrado */
		}
		host = null;
	}
	const bunPath = runtimeStatus.bunPath ?? (await runtime.resolveBun());
	if (!bunPath) {
		setStatus({
			phase: "host-failed",
			message: app.isPackaged
				? "O Bun incluído no aplicativo não foi encontrado. Reinstale o OMP Desktop."
				: "Bun não encontrado no PATH. Instale o Bun para executar o serviço local.",
		});
		void maybeWriteSmokeReport(true);
		return;
	}
	let hostScript = runtime.getHostScript();
	try {
		await access(hostScript);
	} catch {
		const fallback = path.join(repoRoot, "out", "host", "index.js");
		try {
			await access(fallback);
			hostScript = fallback;
		} catch {
			setStatus({
				phase: "host-failed",
				message: "O serviço local não foi compilado (out/host/index.js). Execute bun run build.",
			});
			void maybeWriteSmokeReport(true);
			return;
		}
	}
	const env = buildHostEnv();
	if (selectedOmpPath) env.OMP_DESKTOP_OMP_PATH = selectedOmpPath;
	// Mantém workspaces/abas do host dentro do userData do app (isolado em testes).
	env.OMP_DESKTOP_DATA_DIR = path.join(userDataDir, "host-data");
	const client = new HostClient({
		bunPath,
		hostScript,
		cwd: repoRoot,
		env,
		onEvent: handleHostEvent,
		onExit: handleHostExit,
		onSpawnError: (error) => log("error", "host.spawn_falhou", { message: error.message }),
		log,
		requestTimeoutMs: 180_000,
	});
	host = client;
	try {
		await client.start();
	} catch (error) {
		host = null;
		setStatus({ phase: "host-failed", message: (error as Error).message });
		void maybeWriteSmokeReport(true);
		return;
	}
	hostStarted = true;
	hostPid = client.pid;
	if (runtimeStatus.phase === "host-failed" && isOmpVersionCompatible(runtimeStatus.ompVersion)) {
		runtimeStatus = { ...runtimeStatus, phase: "starting-host", message: undefined };
	}
	log("info", "host.iniciado", { pid: hostPid, bunPath, hostScript });
	if (selectedOmpPath) {
		log("info", "host.omp_configurado", { ompPath: selectedOmpPath });
	}
	emitStatus();
	if (initialCwdArg && !initialCwdConsumed) {
		initialCwdConsumed = true;
		void addWorkspaceAt(initialCwdArg).then(() => emitStatus());
	}
}

async function restartHost(ompPath?: string): Promise<void> {
	restartingHost = true;
	try {
		if (ompPath) selectedOmpPath = ompPath;
		if (host) {
			const previous = host;
			host = null;
			await previous.close(8000);
		}
		hostStarted = false;
		hostReady = false;
		runtime.invalidate();
		runtimeStatus = await runtime.buildStatus(true);
		adoptResolvedOmpPath();
		notifySessionsBeforeCleanup(
			"closed",
			"O serviço local foi reiniciado; reabra as sessões para continuar.",
		);
		sessionRegistry.clearAll();
		attachmentRegistry.clearAll();
		busySessions.clear();
		emitStatus();
		await startHost();
		await confirmHostStatus();
		const runningHost = currentHost();
		if (runningHost?.running) {
			try {
				const list = await runningHost.request<WorkspaceDto[]>("workspace.list", {}, { timeoutMs: 30_000 });
				if (Array.isArray(list)) {
					workspaceRegistry.clear();
					for (const dto of list) workspaceRegistry.add(dto);
				}
			} catch {
				/* o renderer recarrega a lista */
			}
			if (initialCwdArg && !workspaceRegistry.findByPath(initialCwdArg)) {
				await addWorkspaceAt(initialCwdArg);
			}
		}
	} finally {
		restartingHost = false;
	}
}

async function promptAndShutdown(): Promise<void> {
	if (shuttingDown || promptInFlight) return;
	promptInFlight = true;
	try {
		const win = mainWindow;
		if (hasActiveWork() && !smokeReportPath && win && !win.isDestroyed()) {
			log("info", "app.confirmar_encerramento", { busy: busySessions.size, terminals: terminals.hasActive() });
			const result = await dialog.showMessageBox(win, {
				type: "warning",
				title: "Trabalho ativo",
				message: "Há trabalho ativo neste aplicativo.",
				detail:
					"Encerrar agora interrompe terminais e sessões em andamento. Os históricos já gravados pelo OMP são preservados e nenhum prompt será reenviado ao reabrir.",
				buttons: ["Continuar trabalhando", "Encerrar mesmo assim"],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
			});
			if (result.response !== 1) return;
		}
		shuttingDown = true;
		log("info", "app.encerrando");
		await saveWindowState();
		await terminals.closeAll().catch((error: unknown) => {
			log("warn", "terminal.encerrar_falhou", { message: (error as Error).message });
		});
		if (host) {
			const client = host;
			host = null;
			await client.close(10_000).catch((error: unknown) => {
				log("warn", "host.encerrar_falhou", { message: (error as Error).message });
			});
		}
		log("info", "app.encerrado");
		app.exit(0);
	} finally {
		promptInFlight = false;
	}
}

async function bootstrap(): Promise<void> {
	await app.whenReady();
	Menu.setApplicationMenu(null);
	installPermissionHandlers();
	await rotateLogIfNeeded();
	app.on("web-contents-created", (_event, contents: WebContents) => {
		contents.setWindowOpenHandler(() => ({ action: "deny" }));
		contents.on("will-attach-webview", (event) => event.preventDefault());
	});
	app.on("window-all-closed", () => {
		if (!shuttingDown) app.quit();
	});
	app.on("before-quit", (event) => {
		if (shuttingDown) return;
		event.preventDefault();
		void promptAndShutdown();
	});
	process.on("uncaughtException", (error) => {
		log("error", "process.uncaught", { message: error.message });
	});
	process.on("unhandledRejection", (reason) => {
		const message = reason instanceof Error ? reason.message : String(reason);
		log("error", "process.rejeicao_nao_tratada", { message });
	});

	uiState = new UiStateStore(path.join(userDataDir, "ui-state.json"));
	await uiState.load();
	const themeOf = (state: Record<string, unknown>): unknown => {
		const shell = state.shell;
		return shell && typeof shell === "object" ? ((shell as Record<string, unknown>).theme ?? "system") : "system";
	};
	applyThemeSource(themeOf(uiState.getState()));
	const persistUiState = uiState.setState.bind(uiState);
	uiState.setState = async (next: unknown) => {
		const saved = await persistUiState(next);
		applyThemeSource(themeOf(saved));
		return saved;
	};
	savedWindowState = await readJsonFile<StoredWindowState | null>(windowStateFile, null);
	runtime = new RuntimeResolver({
		userDataDir,
		appPath: repoRoot,
		resourcesPath: process.resourcesPath,
		isPackaged: app.isPackaged,
		execPath: process.execPath,
	});

	terminals = new TerminalManager({
		onData: (info, data) => bridge.onTerminalData(info, data),
		onExit: (info, exitCode) => bridge.onTerminalExit(info, exitCode),
		log,
	});

	bridge = new MainBridge({
		getWindow: () => mainWindow,
		authorizedUrls,
		runtime,
		uiState,
		workspaces: workspaceRegistry,
		sessions: sessionRegistry,
		attachments: attachmentRegistry,
		terminals,
		requestHost: <T>(op: string, payload: unknown, timeoutMs?: number) => {
			if (shuttingDown || !host || !host.running) {
				return Promise.reject(
					new HostClientError("HOST_EXITED", "O serviço local não está em execução. Reabra o aplicativo."),
				) as Promise<T>;
			}
			return host.request<T>(op, payload, timeoutMs ? { timeoutMs } : {});
		},
		getStatus: () => runtimeStatus,
		awaitRuntimeStatus: async () => {
			await Promise.race([statusReady.promise, delayUnref(5000)]);
			await Promise.race([bootSettled.promise, delayUnref(15_000)]);
			return runtimeStatus;
		},
		restartHost,
		log,
		isSmokeMode: () => Boolean(smokeReportPath),
		markSessionBusy: (sessionId) => busySessions.add(sessionId),
	});

	mainWindow = createWindow();
	bridge.register();
	mainWindow.webContents.once("did-finish-load", () => {
		emitStatus();
	});
	if (smokeReportPath) {
		const watchdog = setTimeout(() => {
			void maybeWriteSmokeReport(true);
		}, 60_000);
		watchdog.unref?.();
	}
	const discovery = runtime.buildStatus(true);
	await loadApp(mainWindow);

	log("info", "app.iniciado", { version: app.getVersion(), packaged: app.isPackaged });
	runtimeStatus = await discovery;
	adoptResolvedOmpPath();
	if (
		hostReady &&
		runtimeStatus.phase === "starting-host" &&
		isOmpVersionCompatible(runtimeStatus.ompVersion)
	) {
		runtimeStatus = { ...runtimeStatus, phase: "ready" };
	}
	statusReady.resolve();
	emitStatus();
	await startHost();
	await confirmHostStatus();
	bootSettled.resolve();
	void maybeWriteSmokeReport();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", (_event, commandLine) => {
		const win = mainWindow;
		if (win && !win.isDestroyed()) {
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
		}
		const cwd = argValue("--cwd", commandLine);
		if (cwd) void addWorkspaceAt(cwd);
	});
	void bootstrap().catch((error: unknown) => {
		log("error", "app.bootstrap_falhou", { message: (error as Error).message });
		app.exit(1);
	});
}
