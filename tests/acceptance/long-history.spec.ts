import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { isRecord } from "../../src/shared/session-state";
import { buildEntries, launch, quit, type Launched } from "./helpers";

mkdirSync("test-results", { recursive: true });

interface MarkerGeometry {
	found: boolean;
	key: string;
	marker: string;
	textLength: number;
	rect: { top: number; bottom: number; left: number; right: number; height: number; width: number } | null;
	container: { top: number; bottom: number; left: number; right: number; height: number; width: number } | null;
	relativeTop: number | null;
	intersects: boolean;
	intersectionHeight: number;
	fullyVisible: boolean;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	viewportWidth: number;
	viewportHeight: number;
	dpr: number;
}

interface CaptureMetrics {
	phase: string;
	geometry: MarkerGeometry;
	lastMarkerGeometry?: MarkerGeometry;
}

/**
 * Captura o frame realmente apresentado, não o último framebuffer arbitrario.
 * O salto de scrollTop para o topo pinta um frame intermediario (o spacer
 * antigo) antes do commit do React; capturePage pode devolver esse frame. A
 * assinatura de apresentação entrega os frames pintados e o último deles já
 * contém o DOM comitado. Sem frames (página parada), capturePage é seguro.
 */
async function captureWindow(l: Launched, path: string, metrics: CaptureMetrics): Promise<void> {
	const pageUrl = l.page.url();
	const result = await l.app.evaluate(
		async ({ BrowserWindow }, { pageUrl }) => {
			const windows = BrowserWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed());
			const win =
				windows.find((candidate) => candidate.webContents.getURL() === pageUrl) ??
				windows.find((candidate) => candidate.webContents.getURL().includes("index.html")) ??
				windows[0];
			if (!win) throw new Error("janela ausente");
			const wc = win.webContents;
			const holder = globalThis as unknown as {
				__captureFrames?: number;
				__capturePng?: string | null;
				__captureAt?: number | null;
				__captureEnded?: boolean;
			};
			holder.__captureFrames = 0;
			holder.__capturePng = null;
			holder.__captureAt = null;
			holder.__captureEnded = false;
			const started = Date.now();
			const stop = () => {
				if (holder.__captureEnded) return;
				holder.__captureEnded = true;
				try {
					wc.endFrameSubscription();
				} catch {
					/* assinatura já encerrada */
				}
			};
			const callback = (image: { toPNG(): Buffer }) => {
				holder.__captureFrames = (holder.__captureFrames ?? 0) + 1;
				holder.__capturePng = image.toPNG().toString("base64");
				holder.__captureAt = Date.now();
				if ((holder.__captureFrames ?? 0) >= 2) stop();
			};
			try {
				wc.beginFrameSubscription(false, callback);
			} catch {
				holder.__captureEnded = true;
			}
			while (!holder.__captureEnded && (holder.__captureFrames ?? 0) < 2 && Date.now() - started < 1000) {
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
			}
			stop();
			const framePng = holder.__capturePng;
			const png = framePng ?? (await wc.capturePage()).toPNG().toString("base64");
			return {
				png,
				source: framePng ? "frame" : "capturePage",
				frames: holder.__captureFrames ?? 0,
				waitedMs: Date.now() - started,
				frameAt: holder.__captureAt ?? null,
				windowId: wc.id,
				windowUrl: wc.getURL(),
			};
		},
		{ pageUrl },
	);
	writeFileSync(path, Buffer.from(result.png, "base64"));
	const paintedPixels = await countMarkerPixels(path, metrics.geometry);
	writeFileSync(
		path.replace(/\.png$/, ".json"),
		JSON.stringify({ ...metrics, ...result, paintedPixels, png: undefined, capturedAt: Date.now() }, null, 2),
	);
	expect(paintedPixels, `PNG sem pixels do marcador ${metrics.geometry.marker} em ${path}`).toBeGreaterThan(0);
}

/**
 * Prova que o PNG contém o texto do marcador no rect do Range, não só o slot.
 * Usa o frame pós-paint e o rect CSS escalado para o PNG (dpr). Conta pixels
 * diferentes da cor dominante do recorte; um frame stale/fora da viewport dá 0.
 */
async function countMarkerPixels(path: string, geometry: MarkerGeometry): Promise<number> {
	if (!geometry.rect || geometry.viewportWidth <= 0) return 0;
	if (
		geometry.rect.left < 0 ||
		geometry.rect.top < 0 ||
		geometry.rect.right > geometry.viewportWidth ||
		geometry.rect.bottom > geometry.viewportHeight
	) {
		return 0;
	}
	const meta = await sharp(path).metadata();
	const imageWidth = meta.width ?? 0;
	const imageHeight = meta.height ?? 0;
	if (imageWidth <= 0 || imageHeight <= 0) return 0;
	const scale = imageWidth / geometry.viewportWidth;
	const left = Math.max(0, Math.min(imageWidth - 1, Math.round(geometry.rect.left * scale)));
	const top = Math.max(0, Math.min(imageHeight - 1, Math.round(geometry.rect.top * scale)));
	const width = Math.max(1, Math.min(imageWidth - left, Math.round(geometry.rect.width * scale)));
	const height = Math.max(1, Math.min(imageHeight - top, Math.round(geometry.rect.height * scale)));
	const { data, info } = await sharp(path)
		.extract({ left, top, width, height })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const channels = info.channels;
	const colors: Array<[number, number, number]> = [];
	const counts = new Map<number, number>();
	for (let index = 0; index < data.length; index += channels) {
		const r = data[index] ?? 0;
		const g = channels >= 3 ? (data[index + 1] ?? 0) : r;
		const b = channels >= 3 ? (data[index + 2] ?? 0) : r;
		colors.push([r, g, b]);
		const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	let modeKey = 0;
	let modeCount = -1;
	for (const [key, count] of counts) {
		if (count > modeCount) {
			modeKey = key;
			modeCount = count;
		}
	}
	const modeR = ((modeKey >> 8) & 0xf) * 17;
	const modeG = ((modeKey >> 4) & 0xf) * 17;
	const modeB = (modeKey & 0xf) * 17;
	let painted = 0;
	for (const [r, g, b] of colors) {
		if (Math.abs(r - modeR) + Math.abs(g - modeG) + Math.abs(b - modeB) > 48) painted += 1;
	}
	return painted;
}

test("histórico longo não gera loop de renderização (React #185)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-long-loop-"));
	const file = join(dir, "entries.json");
	writeFileSync(file, JSON.stringify(buildEntries(400)));
	let l: Launched | undefined;
	try {
		l = await launch("stream", { FAKE_OMP_ENTRIES: file });
		await l.page.getByText("workspace", { exact: true }).first().click();
		await l.page.getByRole("button", { name: "Criar sessão" }).click();
		await expect(l.page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });
		await l.page.waitForTimeout(3000);
		// rola para o topo e para o fundo várias vezes
		const list = l.page.locator("[data-msg-key]").first();
		await expect(list).toBeVisible();
		for (let i = 0; i < 6; i++) {
			await l.page.evaluate((step) => {
				const el = document.querySelector("[data-msg-key]")?.closest("div[class*=scroll], div") as HTMLElement | null;
				let p: HTMLElement | null = el;
				while (p && p.scrollHeight <= p.clientHeight + 5) p = p.parentElement;
				if (p) p.scrollTop = step % 2 === 0 ? 0 : p.scrollHeight;
			}, i).catch(() => undefined);
			await l.page.mouse.wheel(0, i % 2 === 0 ? -6000 : 6000);
			await l.page.waitForTimeout(400);
		}
		// mensagens novas com histórico grande
		const box = l.page.locator("textarea").first();
		for (let i = 0; i < 3; i++) {
			await box.fill(`teste ${i}`);
			await box.press("Enter");
			await l.page.waitForTimeout(1500);
		}
		await l.page.screenshot({ path: "test-results/long-history.png" });
		const text = await l.page.locator("body").innerText();
		expect(text).not.toContain("Minified React error");
		expect(l.errors.filter((e) => /185|Maximum update depth/.test(e))).toEqual([]);
	} finally {
		if (l) await quit(l);
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});

// ---------------------------------------------------------------------------
// Regressão do bug real: histórico de ~29 MiB com Unicode, ferramenta com
// argumentos/resultado/details profundos. O conteúdo precisa atravessar
// host → main → preload → renderer inteiro (hash exato), renderizar as pontas
// na lista virtual, sobreviver a reload e ao sync pós-settle sem sumir nem
// duplicar. Nada aqui depende de aviso/notice: o snapshot e o DOM são a prova.
// ---------------------------------------------------------------------------

const TOTAL = 400;
const HEAVY_START = 100;
const HEAVY_END = 299;
const MIDDLE_INDEX = 200;
const TOOL_INDEX = 397;
const TOOL_RESULT_INDEX = 398;
const LAST_INDEX = 399;
const OMITTED_TEXT = "conteúdo omitido por tamanho";

interface LongFixture {
	run: string;
	entries: unknown[];
	leafId: string | null;
	messages: Record<string, unknown>[];
	firstMarker: string;
	lastMarker: string;
	middleMarker: string;
	middleTail: string;
	promptText: string;
	toolId: string;
	toolArgs: Record<string, unknown>;
	toolResultText: string;
	toolDetails: Record<string, unknown>;
	argsTail: string;
	resultTail: string;
	detailsTail: string;
	deepTail: string;
}

interface SnapshotProbe {
	count: number;
	hashes: string[];
	mismatchIndex: number;
	mismatchExpected: string | null;
	mismatchActual: string | null;
	mismatchCanonical: string | null;
	keys: string[];
	roles: string[];
	targetKey: string | null;
	toolKey: string | null;
	first: Record<string, unknown> | null;
	last: Record<string, unknown> | null;
	tools: Record<string, Record<string, unknown>>;
	markerCounts: Record<string, number>;
	omitted: boolean;
	duplicateKeys: number;
	extra: Array<{
		role: unknown;
		text: string;
		toolCallId: unknown;
		toolName: unknown;
		toolCalls: Array<{ id: unknown; name: unknown; arguments: unknown }>;
		details: unknown;
	}>;
}

/** Texto Unicode multibyte (Ω/漢/🙂/grego) com marcador no início e no fim. */
function unicodePayload(repeats: number, marker: string): string {
	const unit = "Ω漢🙂αβγ";
	const lines: string[] = [];
	for (let index = 0; index < repeats; index++) {
		lines.push(unit.repeat(20));
		if (index % 5 === 0) lines.push(`linha ${index} ${marker}`);
	}
	return `${marker}\n${lines.join("\n")}\n${marker}-FIM`;
}

/** details com mais níveis que o antigo teto de sanitização (16). */
function deepDetails(levels: number, tail: string): Record<string, unknown> {
	let node: Record<string, unknown> = { value: tail, level: levels };
	for (let level = levels - 1; level >= 1; level--) {
		node = { [`level${level}`]: node, common: `comum-${level}` };
	}
	return node;
}

function buildLongFixture(): LongFixture {
	const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const firstMarker = `INICIO-HISTORICO-${run}`;
	const lastMarker = `FIM-HISTORICO-${run}`;
	const middleMarker = `MEIO-HISTORICO-${run}`;
	const middleTail = `TAIL-${MIDDLE_INDEX}-${run}`;
	const promptText = `SYNC-PROMPT-${run}`;
	const toolId = `tool-heavy-${run}`;
	const argsTail = `ARGS-TAIL-${run}`;
	const resultTail = `RESULT-TAIL-${run}`;
	const detailsTail = `DETAILS-TAIL-${run}`;
	const deepTail = `DEEP-TAIL-${run}`;
	const toolArgs: Record<string, unknown> = {
		path: `src/arquivo-unicode-${run}.txt`,
		oldText: `ANTES-${run}\n${unicodePayload(40, `ARGS-${run}`)}`,
		newText: `DEPOIS-${run}\n${unicodePayload(120, `ARGS-${run}`)}\n${argsTail}`,
		options: { unicode: true, nested: { deep: `args-${run}`, levels: [1, 2, 3] } },
	};
	const toolResultText = `RESULTADO-${run}\n${unicodePayload(30, `RESULT-${run}`)}\n${resultTail}`;
	const toolDetails: Record<string, unknown> = {
		stdout: `stdout-${run}\n${unicodePayload(40, `STDOUT-${run}`)}`,
		changes: { added: 3, removed: 2, path: `src/arquivo-unicode-${run}.txt` },
		nested: deepDetails(20, deepTail),
		tail: detailsTail,
	};
	const entries: unknown[] = [];
	const messages: Record<string, unknown>[] = [];
	let parent: string | null = null;
	const push = (message: Record<string, unknown>) => {
		const id = `e${entries.length + 1}`;
		entries.push({
			type: "message",
			id,
			parentId: parent,
			timestamp: new Date(1_700_000_000_000 + entries.length).toISOString(),
			message,
		});
		messages.push(message);
		parent = id;
	};
	for (let index = 0; index < TOTAL; index++) {
		if (index === 0) {
			push({ role: "user", content: [{ type: "text", text: firstMarker }], timestamp: 1_700_000_000_000 + index });
			continue;
		}
		if (index === LAST_INDEX) {
			push({
				role: "assistant",
				content: [{ type: "text", text: lastMarker }],
				model: "fake-model",
				provider: "fake",
				timestamp: 1_700_000_000_000 + index,
			});
			continue;
		}
		if (index === TOOL_INDEX) {
			push({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `analisando ${run}\n${unicodePayload(6, `THINK-${run}`)}` },
					{ type: "text", text: `[MSG-${index}] ferramenta ${run}\n${unicodePayload(40, `MSG-${index}`)}` },
					{ type: "toolCall", id: toolId, name: "edit", arguments: toolArgs, intent: `editar ${run}` },
				],
				model: "fake-model",
				provider: "fake",
				timestamp: 1_700_000_000_000 + index,
			});
			continue;
		}
		if (index === TOOL_RESULT_INDEX) {
			push({
				role: "toolResult",
				toolCallId: toolId,
				toolName: "edit",
				content: [{ type: "text", text: toolResultText }],
				details: toolDetails,
				isError: false,
				timestamp: 1_700_000_000_000 + index,
			});
			continue;
		}
		const heavy = index >= HEAVY_START && index <= HEAVY_END;
		const payload = unicodePayload(heavy ? 450 : 30, `MSG-${index}`);
		const tail = index === MIDDLE_INDEX ? middleTail : `TAIL-${index}-${run}`;
		if (index % 2 === 0) {
			push({
				role: "user",
				content: [
					{
						type: "text",
						text: `[MSG-${index}] pergunta ${index}\n${index === MIDDLE_INDEX ? `${middleMarker}\n` : ""}${payload}\n${tail}`,
					},
				],
				timestamp: 1_700_000_000_000 + index,
			});
		} else {
			push({
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `raciocínio ${index} ${run}` },
					{ type: "text", text: `[MSG-${index}] resposta ${index}\n${payload}\n${tail}` },
				],
				model: "fake-model",
				provider: "fake",
				timestamp: 1_700_000_000_000 + index,
			});
		}
	}
	return {
		run,
		entries,
		leafId: parent,
		messages,
		firstMarker,
		lastMarker,
		middleMarker,
		middleTail,
		promptText,
		toolId,
		toolArgs,
		toolResultText,
		toolDetails,
		argsTail,
		resultTail,
		detailsTail,
		deepTail,
	};
}

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
			out[key] = stable(item);
		}
		return out;
	}
	return value;
}

/** Mesma projeção do host (`chatMessageFromRaw`) para comparar cru × ChatMessage. */
function canonicalMessage(message: Record<string, unknown>): Record<string, unknown> {
	const rawContent = message.content;
	const blocks: unknown[] =
		typeof rawContent === "string"
			? [{ type: "text", text: rawContent }]
			: Array.isArray(rawContent)
				? rawContent
				: [];
	const content = blocks.map((block) => {
		const record = isRecord(block) ? block : undefined;
		if (!record) return { type: "unknown" };
		const type = typeof record.type === "string" ? record.type : "";
		switch (type) {
			case "text":
				return { type: "text", text: typeof record.text === "string" ? record.text : "" };
			case "thinking":
				return {
					type: "thinking",
					thinking: typeof record.thinking === "string" ? record.thinking : "",
				};
			case "image":
				return {
					type: "image",
					mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
					data: typeof record.data === "string" ? record.data : "",
				};
			case "toolCall": {
				const call: Record<string, unknown> = {
					type: "toolCall",
					id: typeof record.id === "string" ? record.id : "",
					name: typeof record.name === "string" ? record.name : "",
					arguments: record.arguments ?? {},
				};
				if (typeof record.intent === "string") call.intent = record.intent;
				return call;
			}
			default:
				return { type: "unknown" };
		}
	});
	return {
		role: message.role,
		content,
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		details: message.details,
		isError: message.isError,
		timestamp: message.timestamp,
	};
}

/** Hash determinístico (duas pistas FNV-1a 32 bits) do JSON canônico. */
function hashString(text: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x9e3779b9;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
	}
	return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

async function openSessionInfo(page: Page): Promise<{ workspaceId: string; sessionId: string }> {
	return page.evaluate(async () => {
		// O snapshot/IPC é dado externo: narrowing em vez de confiar num cast.
		const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
			Boolean(value) && typeof value === "object" && !Array.isArray(value);
		const api = window.ompDesktop;
		const workspaces = await api.invoke({ op: "workspace.list" });
		if (!workspaces.ok) throw new Error(`workspace.list falhou: ${JSON.stringify(workspaces.error)}`);
		const list = Array.isArray(workspaces.data) ? workspaces.data.filter(isPlainRecord) : [];
		const workspace =
			list.find(
				(item) =>
					typeof item.path === "string" && item.path.replace(/\\/g, "/").endsWith("/workspace"),
			) ?? list[0];
		if (!workspace || typeof workspace.workspaceId !== "string") {
			throw new Error("workspace não encontrado");
		}
		const sessions = await api.invoke({ op: "session.list", workspaceId: workspace.workspaceId });
		if (!sessions.ok) throw new Error(`session.list falhou: ${JSON.stringify(sessions.error)}`);
		const items = Array.isArray(sessions.data) ? sessions.data.filter(isPlainRecord) : [];
		const open = items.find((item) => typeof item.openSessionId === "string");
		if (!open || typeof open.openSessionId !== "string") throw new Error("sessão aberta não encontrada");
		return { workspaceId: workspace.workspaceId, sessionId: open.openSessionId };
	});
}

async function probeSnapshot(
	page: Page,
	info: { workspaceId: string; sessionId: string },
	expectedHashes: string[],
	expectedCount: number,
	markers: Record<string, string>,
	toolId: string,
	middleIndex: number,
	toolIndex: number,
): Promise<SnapshotProbe> {
	return page.evaluate(
		async ({ workspaceId, sessionId, expectedHashes, expectedCount, markers, toolId, middleIndex, toolIndex }) => {
			// Dado de IPC é externo: narrowing em vez de cast inline.
			const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
				Boolean(value) && typeof value === "object" && !Array.isArray(value);
			const api = window.ompDesktop;
			const result = await api.invoke({ op: "session.snapshot", workspaceId, sessionId });
			if (!result.ok) throw new Error(`session.snapshot falhou: ${JSON.stringify(result.error)}`);
			const data = result.data;
			const state = isPlainRecord(data) && isPlainRecord(data.state) ? data.state : undefined;
			const rawMessages = state && Array.isArray(state.messages) ? state.messages : [];
			const messages = rawMessages.filter(isPlainRecord);
			const tools: Record<string, Record<string, unknown>> = {};
			if (state && isPlainRecord(state.tools)) {
				for (const [key, value] of Object.entries(state.tools)) {
					if (isPlainRecord(value)) tools[key] = value;
				}
			}

			const stable = (value: unknown): unknown => {
				if (Array.isArray(value)) return value.map(stable);
				if (value && typeof value === "object") {
					const out: Record<string, unknown> = {};
					for (const [key, item] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
						out[key] = stable(item);
					}
					return out;
				}
				return value;
			};
			const canonicalMessage = (message: Record<string, unknown>): Record<string, unknown> => {
				const rawContent = message.content;
				const blocks: unknown[] =
					typeof rawContent === "string"
						? [{ type: "text", text: rawContent }]
						: Array.isArray(rawContent)
							? rawContent
							: [];
				const content = blocks.map((block) => {
					const record = isPlainRecord(block) ? block : undefined;
					if (!record) return { type: "unknown" };
					const type = typeof record.type === "string" ? record.type : "";
					switch (type) {
						case "text":
							return { type: "text", text: typeof record.text === "string" ? record.text : "" };
						case "thinking":
							return {
								type: "thinking",
								thinking: typeof record.thinking === "string" ? record.thinking : "",
							};
						case "image":
							return {
								type: "image",
								mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
								data: typeof record.data === "string" ? record.data : "",
							};
						case "toolCall": {
							const call: Record<string, unknown> = {
								type: "toolCall",
								id: typeof record.id === "string" ? record.id : "",
								name: typeof record.name === "string" ? record.name : "",
								arguments: record.arguments ?? {},
							};
							if (typeof record.intent === "string") call.intent = record.intent;
							return call;
						}
						default:
							return { type: "unknown" };
					}
				});
				return {
					role: message.role,
					content,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					details: message.details,
					isError: message.isError,
					timestamp: message.timestamp,
				};
			};
			const hashString = (text: string): string => {
				let h1 = 0x811c9dc5;
				let h2 = 0x9e3779b9;
				for (let index = 0; index < text.length; index++) {
					const code = text.charCodeAt(index);
					h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
					h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
				}
				return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
			};
			const canonicalJsons = messages.map((message) =>
				JSON.stringify(stable(canonicalMessage(message))),
			);
			const hashes = canonicalJsons.map(hashString);
			let mismatchIndex = -1;
			// Só o prefixo do fixture é comparado. Depois do sync há 3 mensagens
			// vivas extras (prompt/toolResult/assistant); elas são validadas por
			// count/extra, não contra expectedHashes.
			for (let index = 0; index < expectedCount; index++) {
				if (hashes[index] !== expectedHashes[index]) {
					mismatchIndex = index;
					break;
				}
			}
			const keys = messages.map((message) => String(message.key ?? ""));
			const textOf = (message: Record<string, unknown>): string => {
				const content = Array.isArray(message.content) ? message.content : [];
				return content
					.filter(isPlainRecord)
					.filter((block) => block.type === "text")
					.map((block) => String(block.text ?? ""))
					.join("\n");
			};
			const markerCounts: Record<string, number> = {};
			for (const name of Object.keys(markers)) markerCounts[name] = 0;
			for (const json of canonicalJsons) {
				for (const [name, marker] of Object.entries(markers)) {
					if (marker) markerCounts[name] += json.split(marker).length - 1;
				}
			}
			const extra = messages.slice(expectedCount).map((message) => {
				const content = Array.isArray(message.content) ? message.content : [];
				return {
					role: message.role,
					text: textOf(message),
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					toolCalls: content
						.filter(isPlainRecord)
						.filter((block) => block.type === "toolCall")
						.map((block) => ({ id: block.id, name: block.name, arguments: block.arguments })),
					details: message.details,
				};
			});
			return {
				count: messages.length,
				hashes,
				mismatchIndex,
				mismatchExpected: mismatchIndex >= 0 ? expectedHashes[mismatchIndex] ?? null : null,
				mismatchActual: mismatchIndex >= 0 ? hashes[mismatchIndex] ?? null : null,
				mismatchCanonical:
					mismatchIndex >= 0 ? (canonicalJsons[mismatchIndex] ?? "").slice(0, 4000) : null,
				keys,
				roles: messages.map((message) => String(message.role ?? "")),
				targetKey: messages[middleIndex]?.key ? String(messages[middleIndex].key) : null,
				toolKey: messages[toolIndex]?.key ? String(messages[toolIndex].key) : null,
				first: messages[0] ? canonicalMessage(messages[0]) : null,
				last: messages[messages.length - 1] ? canonicalMessage(messages[messages.length - 1]) : null,
				tools,
				markerCounts,
				omitted: canonicalJsons.some((json) => json.includes(markers.omitted ?? "conteúdo omitido por tamanho")),
				duplicateKeys: keys.length - new Set(keys).size,
				extra,
			};
		},
		{
			workspaceId: info.workspaceId,
			sessionId: info.sessionId,
			expectedHashes,
			expectedCount,
			markers,
			toolId,
			middleIndex,
			toolIndex,
		},
	);
}

async function snapshotSummary(
	page: Page,
	info: { workspaceId: string; sessionId: string },
	markers: { prompt: string; verified: string; first: string; last: string },
): Promise<{ count: number; prompt: number; verified: number; first: number; last: number }> {
	return page.evaluate(
		async ({ workspaceId, sessionId, markers }) => {
			const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
				Boolean(value) && typeof value === "object" && !Array.isArray(value);
			const api = window.ompDesktop;
			const result = await api.invoke({ op: "session.snapshot", workspaceId, sessionId });
			if (!result.ok) throw new Error(`session.snapshot falhou: ${JSON.stringify(result.error)}`);
			const data = result.data;
			const state = isPlainRecord(data) && isPlainRecord(data.state) ? data.state : undefined;
			const rawMessages = state && Array.isArray(state.messages) ? state.messages : [];
			const messages = rawMessages.filter(isPlainRecord);
			const textOf = (message: Record<string, unknown> | undefined): string => {
				const content = message && Array.isArray(message.content) ? message.content : [];
				return content
					.filter(isPlainRecord)
					.filter((block) => block.type === "text")
					.map((block) => String(block.text ?? ""))
					.join("\n");
			};
			const tail = messages.slice(-10).map(textOf).join("\n");
			const count = (text: string, marker: string) => (marker ? text.split(marker).length - 1 : 0);
			return {
				count: messages.length,
				prompt: count(tail, markers.prompt),
				verified: count(tail, markers.verified),
				first: count(textOf(messages[0]), markers.first),
				// Após o sync a última mensagem é a resposta viva; o marcador do
				// fixture fica no fim da janela de 10, não no último índice.
				last: count(tail, markers.last),
			};
		},
		{ workspaceId: info.workspaceId, sessionId: info.sessionId, markers },
	);
}

async function scrollLog(page: Page, position: "top" | "bottom"): Promise<void> {
	await page.evaluate((where) => {
		const log = document.querySelector<HTMLElement>('[aria-label="Histórico da conversa"]');
		if (!log) throw new Error("histórico ausente");
		log.scrollTop = where === "top" ? 0 : log.scrollHeight;
		log.dispatchEvent(new Event("scroll", { bubbles: true }));
	}, position);
}

async function markerGeometry(page: Page, key: string, marker: string): Promise<MarkerGeometry> {
	return page.evaluate(
		({ key, marker }) => {
			const log = document.querySelector<HTMLElement>('[aria-label="Histórico da conversa"]');
			if (!log) {
				return {
					found: false,
					key,
					marker,
					textLength: 0,
					rect: null,
					container: null,
					relativeTop: null,
					intersects: false,
					intersectionHeight: 0,
					fullyVisible: false,
					scrollTop: 0,
					scrollHeight: 0,
					clientHeight: 0,
					viewportWidth: 0,
					viewportHeight: 0,
					dpr: 1,
				};
			}
			const lr = log.getBoundingClientRect();
			const container = { top: lr.top, bottom: lr.bottom, left: lr.left, right: lr.right, height: lr.height, width: lr.width };
			const base = {
				found: false,
				key,
				marker,
				textLength: 0,
				rect: null,
				container,
				relativeTop: null,
				intersects: false,
				intersectionHeight: 0,
				fullyVisible: false,
				scrollTop: log.scrollTop,
				scrollHeight: log.scrollHeight,
				clientHeight: log.clientHeight,
				viewportWidth: innerWidth,
				viewportHeight: innerHeight,
				dpr: devicePixelRatio,
			};
			const slot = log.querySelector<HTMLElement>(`[data-msg-key="${key}"]`);
			if (!slot) return base;
			const walker = document.createTreeWalker(slot, NodeFilter.SHOW_TEXT);
			const nodes: Text[] = [];
			let combined = "";
			while (walker.nextNode()) {
				const node = walker.currentNode as Text;
				nodes.push(node);
				combined += node.nodeValue ?? "";
			}
			const at = combined.indexOf(marker);
			if (at < 0) return { ...base, textLength: combined.length };
			const locate = (offset: number): { node: Text; offset: number } | null => {
				let remaining = offset;
				for (const node of nodes) {
					const length = node.nodeValue?.length ?? 0;
					if (remaining <= length) return { node, offset: remaining };
					remaining -= length;
				}
				return null;
			};
			const start = locate(at);
			const end = locate(at + marker.length);
			if (!start || !end) return { ...base, textLength: combined.length };
			const range = document.createRange();
			range.setStart(start.node, start.offset);
			range.setEnd(end.node, end.offset);
			const rect = range.getBoundingClientRect();
			const intersectionHeight = Math.max(0, Math.min(rect.bottom, lr.bottom) - Math.max(rect.top, lr.top));
			return {
				found: true,
				key,
				marker,
				textLength: combined.length,
				rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height, width: rect.width },
				container,
				relativeTop: rect.top - lr.top + log.scrollTop,
				intersects: rect.bottom > lr.top && rect.top < lr.bottom,
				intersectionHeight,
				fullyVisible: rect.top >= lr.top - 1 && rect.bottom <= lr.bottom + 1,
				scrollTop: log.scrollTop,
				scrollHeight: log.scrollHeight,
				clientHeight: log.clientHeight,
				viewportWidth: innerWidth,
				viewportHeight: innerHeight,
				dpr: devicePixelRatio,
			};
		},
		{ key, marker },
	);
}

/**
 * Garante que o texto do marcador (Range, não o slot inteiro) esteja
 * integralmente dentro da viewport do histórico. Um slot de 30.000px pode
 * intersectar a viewport por um trecho que não contém o marcador.
 */
async function ensureMarkerVisible(page: Page, key: string, marker: string): Promise<MarkerGeometry> {
	let last: MarkerGeometry | undefined;
	for (let attempt = 0; attempt < 12; attempt++) {
		last = await markerGeometry(page, key, marker);
		if (last.found && last.fullyVisible) return last;
		if (!last.found) {
			await page.waitForFunction(
				({ key }) => document.querySelector(`[data-msg-key="${key}"]`) !== null,
				{ key },
				{ timeout: 10_000 },
			);
			continue;
		}
		const target = Math.max(0, (last.relativeTop ?? 0) - last.clientHeight * 0.25);
		await page.evaluate(
			({ target }) => {
				const log = document.querySelector<HTMLElement>('[aria-label="Histórico da conversa"]');
				if (!log) throw new Error("histórico ausente");
				log.scrollTop = Math.max(0, Math.min(log.scrollHeight, target));
				log.dispatchEvent(new Event("scroll", { bubbles: true }));
			},
			{ target },
		);
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => {
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
				}),
		);
	}
	if (!last || !last.found || !last.fullyVisible) {
		throw new Error(`marcador ${marker} não ficou visível em ${key}: ${JSON.stringify(last)}`);
	}
	return last;
}

async function scrollToMessage(
	page: Page,
	targetKey: string,
	targetIndex: number,
	marker?: string,
): Promise<MarkerGeometry | null> {
	// Varredura determinística pela janela renderizada, do topo para baixo.
	// Cada passo avança até o fim da última mensagem renderizada (com overlap),
	// então não depende de média de altura nem de scrollHeight estável.
	await page.evaluate(() => {
		const log = document.querySelector<HTMLElement>('[aria-label="Histórico da conversa"]');
		if (!log) throw new Error("histórico ausente");
		log.scrollTop = 0;
		log.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	// A coluna de conversa mais estreita (744 px) aumenta a altura das
	// mensagens; a varredura precisa de mais passos para chegar ao fim.
	for (let attempt = 0; attempt < 400; attempt++) {
		await page.waitForTimeout(50);
		const state = await page.evaluate(
			({ targetKey }) => {
				const log = document.querySelector<HTMLElement>('[aria-label="Histórico da conversa"]');
				if (!log) throw new Error("histórico ausente");
				const parseIndex = (key: string): number => {
					const entry = /^entry:e(\d+)$/.exec(key);
					if (entry) return Number(entry[1]) - 1;
					const hist = /^hist:\d+:(\d+)$/.exec(key);
					if (hist) return Number(hist[1]);
					return -1;
				};
				const container = log.getBoundingClientRect();
				const slots = Array.from(log.querySelectorAll<HTMLElement>("[data-msg-key]"))
					.map((slot) => {
						const key = slot.dataset.msgKey ?? "";
						const rect = slot.getBoundingClientRect();
						return {
							key,
							index: parseIndex(key),
							top: rect.top - container.top + log.scrollTop,
							height: rect.height,
						};
					})
					.filter((slot) => slot.index >= 0);
				return {
					found: slots.some((slot) => slot.key === targetKey),
					scrollTop: log.scrollTop,
					scrollHeight: log.scrollHeight,
					clientHeight: log.clientHeight,
					first: slots[0] ?? null,
					last: slots[slots.length - 1] ?? null,
				};
			},
			{ targetKey },
		);
		if (state.found) return marker ? ensureMarkerVisible(page, targetKey, marker) : null;
		if (!state.first || !state.last) break;
		const next =
			targetIndex > state.last.index
				? state.last.top + state.last.height - state.clientHeight * 0.25
				: state.scrollTop + state.clientHeight * 0.5;
		await page.evaluate(
			({ next }) => {
				const log = document.querySelector<HTMLElement>('[aria-label="Histórico da conversa"]');
				if (!log) throw new Error("histórico ausente");
				log.scrollTop = Math.max(0, Math.min(log.scrollHeight, next));
				// scrollTop programático nem sempre dispara `scroll`; o
				// virtualizador só recalcula a janela com o evento.
				log.dispatchEvent(new Event("scroll", { bubbles: true }));
			},
			{ next },
		);
	}
	throw new Error(`não foi possível renderizar a mensagem ${targetIndex} (${targetKey})`);
}

test("histórico de ~29 MiB atravessa host/main/preload/renderer sem omitir, truncar ou duplicar", async () => {
	test.setTimeout(300_000);
	const dir = mkdtempSync(join(tmpdir(), "omp-long-history-"));
	const fixturePath = join(dir, "entries.json");
	const sessionPath = join(dir, "session.jsonl");
	const fixture = buildLongFixture();
	const payload = { entries: fixture.entries, leafId: fixture.leafId };
	const fixtureJson = JSON.stringify(payload);
	writeFileSync(fixturePath, fixtureJson, "utf8");
	// O fixture precisa ser maior que o antigo teto de 8 MiB e realmente Unicode.
	const fixtureBytes = Buffer.byteLength(fixtureJson, "utf8");
	expect(fixtureBytes).toBeGreaterThan(24 * 1024 * 1024);
	expect(fixtureBytes).toBeGreaterThan(fixtureJson.length);

	const expectedHashes = fixture.messages.map((message) =>
		hashString(JSON.stringify(stable(canonicalMessage(message)))),
	);
	const markers: Record<string, string> = {
		first: fixture.firstMarker,
		last: fixture.lastMarker,
		middle: fixture.middleMarker,
		middleTail: fixture.middleTail,
		argsTail: fixture.argsTail,
		resultTail: fixture.resultTail,
		detailsTail: fixture.detailsTail,
		deepTail: fixture.deepTail,
		prompt: fixture.promptText,
		verified: "Verificado.",
		omitted: OMITTED_TEXT,
	};

	let l: Launched | undefined;
	try {
		l = await launch("stream", {
			FAKE_OMP_ENTRIES: fixturePath,
			FAKE_OMP_SESSION_FILE: sessionPath,
		});
		await l.page.getByText("workspace", { exact: true }).first().click();
		await l.page.getByRole("button", { name: "Criar sessão" }).click();
		await expect(l.page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });
		await expect(l.page.getByText(fixture.lastMarker, { exact: false }).first()).toBeVisible({
			timeout: 90_000,
		});

		// A coluna padrão (744 px) deixa as mensagens altas; a varredura
		// determinística do teste usa a largura ampla.
		await l.page.getByRole("button", { name: "Configurações" }).click();
		await l.page.getByRole("tab", { name: "Geral" }).click();
		await l.page.getByLabel("Largura da conversa").selectOption("wide");
		await l.page.keyboard.press("Escape");
		await l.page.waitForTimeout(300);

		const info = await openSessionInfo(l.page);
		const initial = await probeSnapshot(
			l.page,
			info,
			expectedHashes,
			TOTAL,
			markers,
			fixture.toolId,
			MIDDLE_INDEX,
			TOOL_INDEX,
		);
		expect(initial.count).toBe(TOTAL);
		expect(initial.mismatchIndex, `conteúdo divergiu no índice ${initial.mismatchIndex}: ${initial.mismatchCanonical ?? ""}`).toBe(-1);
		expect(initial.hashes).toEqual(expectedHashes);
		expect(initial.roles).toEqual(fixture.messages.map((message) => message.role));
		expect(initial.keys).toHaveLength(TOTAL);
		expect(new Set(initial.keys).size).toBe(TOTAL);
		expect(initial.duplicateKeys).toBe(0);
		expect(initial.first?.content).toEqual([{ type: "text", text: fixture.firstMarker }]);
		expect(initial.last?.content).toEqual([{ type: "text", text: fixture.lastMarker }]);
		expect(initial.markerCounts.first).toBe(1);
		expect(initial.markerCounts.last).toBe(1);
		expect(initial.markerCounts.middle).toBe(1);
		expect(initial.markerCounts.middleTail).toBe(1);
		expect(initial.markerCounts.argsTail).toBe(1);
		expect(initial.markerCounts.resultTail).toBe(1);
		expect(initial.markerCounts.detailsTail).toBe(1);
		expect(initial.markerCounts.deepTail).toBe(1);
		expect(initial.markerCounts.omitted).toBe(0);
		expect(initial.omitted).toBe(false);

		const fixtureTool = initial.tools[fixture.toolId];
		expect(fixtureTool?.toolCallId).toBe(fixture.toolId);
		expect(fixtureTool?.name).toBe("edit");
		expect(fixtureTool?.status).toBe("done");
		expect(fixtureTool?.intent).toBe(`editar ${fixture.run}`);
		expect(fixtureTool?.arguments).toEqual(fixture.toolArgs);
		expect(fixtureTool?.resultText).toBe(fixture.toolResultText);
		expect(fixtureTool?.details).toEqual(fixture.toolDetails);
		expect(fixtureTool?.resultTruncated).not.toBe(true);

		// --- DOM: fundo (última) e topo (primeira) na lista virtual ----------
		await scrollLog(l.page, "bottom");
		const lastText = l.page.locator(".message--assistant .message__body", { hasText: fixture.lastMarker });
		await expect(lastText).toHaveCount(1);
		const bottomGeometry = await ensureMarkerVisible(l.page, initial.keys[initial.keys.length - 1], fixture.lastMarker);
		expect(bottomGeometry.fullyVisible).toBe(true);
		await captureWindow(l, "test-results/history-complete-bottom.png", { phase: "bottom", geometry: bottomGeometry });

		// Ferramenta perto do fim: args/result/details completos no DOM.
		if (!initial.toolKey) throw new Error("chave da mensagem da ferramenta ausente");
		await scrollToMessage(l.page, initial.toolKey, TOOL_INDEX, `arquivo-unicode-${fixture.run}.txt`);
		const card = l.page.locator("details.tool-card").filter({ hasText: `arquivo-unicode-${fixture.run}.txt` });
		await expect(card).toHaveCount(1);
		const cardOpen = await card.evaluate((element) => (element as HTMLDetailsElement).open);
		if (!cardOpen) await card.locator("summary.tool-card__header").click();
		await expect(card).toHaveAttribute("open", "");
		const argsDetails = card.locator("details.tool-card__details").filter({ hasText: "Argumentos" });
		const detailsDetails = card.locator("details.tool-card__details").filter({ hasText: "Detalhes" });
		await expect(argsDetails).toHaveCount(1);
		await expect(detailsDetails).toHaveCount(1);
		if (!(await argsDetails.evaluate((element) => (element as HTMLDetailsElement).open))) {
			await argsDetails.locator("summary").click();
		}
		if (!(await detailsDetails.evaluate((element) => (element as HTMLDetailsElement).open))) {
			await detailsDetails.locator("summary").click();
		}
		await expect(argsDetails.locator("pre")).toContainText(fixture.argsTail);
		await expect(detailsDetails.locator("pre")).toContainText(fixture.detailsTail);
		await expect(detailsDetails.locator("pre")).toContainText(fixture.deepTail);
		const output = card.locator(".tool-card__output pre");
		await expect(output).toBeVisible();
		await expect(output).not.toContainText(fixture.resultTail);
		await card.getByRole("button", { name: /Mostrar saída completa/ }).click();
		await expect(output).toContainText(fixture.resultTail);
		// O card expandido (args/details/saída completa) tem altura muito maior
		// que as mensagens e distorce a média usada para achar o índice 200.
		// Colapsa antes de voltar ao meio; o conteúdo já foi verificado acima.
		if (await card.evaluate((element) => (element as HTMLDetailsElement).open)) {
			await card.locator("summary.tool-card__header").click();
		}
		await expect(card).not.toHaveAttribute("open", "");

		// Mensagem pesada do meio: o texto inteiro (inclusive o fim) está no DOM.
		if (!initial.targetKey) throw new Error("chave da mensagem do meio ausente");
		const middleGeometry = await scrollToMessage(l.page, initial.targetKey, MIDDLE_INDEX, fixture.middleMarker);
		if (!middleGeometry) throw new Error("geometria do marcador do meio ausente");
		const middleSlot = l.page.locator(`[data-msg-key="${initial.targetKey}"]`);
		await expect(middleSlot).toHaveCount(1);
		await expect(middleSlot).toContainText(fixture.middleMarker);
		await expect(middleSlot).toContainText(fixture.middleTail);
		expect(middleGeometry.fullyVisible).toBe(true);
		await captureWindow(l, "test-results/history-complete-middle.png", { phase: "middle", geometry: middleGeometry });

		await scrollLog(l.page, "top");
		const firstText = l.page.locator(".message--user .message__user-text", { hasText: fixture.firstMarker });
		await expect(firstText).toHaveCount(1);
		const firstGeometry = await ensureMarkerVisible(l.page, initial.keys[0], fixture.firstMarker);
		expect(firstGeometry.scrollTop).toBe(0);
		expect(firstGeometry.fullyVisible).toBe(true);
		await captureWindow(l, "test-results/history-complete-top.png", { phase: "top", geometry: firstGeometry });
		expect(await l.page.locator("body").innerText()).not.toContain(OMITTED_TEXT);

		// --- Reload do renderer: o host continua vivo e o snapshot é reaplicado.
		await l.page.reload();
		await l.page.waitForLoadState("domcontentloaded");
		await l.page.getByText("workspace", { exact: true }).first().click();
		await expect(l.page.locator("textarea").first()).toBeVisible({ timeout: 60_000 });
		await expect(l.page.getByText(fixture.lastMarker, { exact: false }).first()).toBeVisible({
			timeout: 90_000,
		});
		const reloadedInfo = await openSessionInfo(l.page);
		const reloaded = await probeSnapshot(
			l.page,
			reloadedInfo,
			expectedHashes,
			TOTAL,
			markers,
			fixture.toolId,
			MIDDLE_INDEX,
			TOOL_INDEX,
		);
		expect(reloaded.count).toBe(TOTAL);
		expect(reloaded.mismatchIndex, `conteúdo divergiu após reload no índice ${reloaded.mismatchIndex}: ${reloaded.mismatchCanonical ?? ""}`).toBe(-1);
		expect(reloaded.hashes).toEqual(expectedHashes);
		expect(reloaded.duplicateKeys).toBe(0);
		expect(reloaded.markerCounts.first).toBe(1);
		expect(reloaded.markerCounts.last).toBe(1);
		expect(reloaded.markerCounts.middle).toBe(1);
		expect(reloaded.markerCounts.omitted).toBe(0);
		await scrollLog(l.page, "bottom");
		await expect(l.page.locator(".message--assistant .message__body", { hasText: fixture.lastMarker })).toHaveCount(1);
		const reloadLastGeometry = await ensureMarkerVisible(l.page, reloaded.keys[reloaded.keys.length - 1], fixture.lastMarker);
		expect(reloadLastGeometry.fullyVisible).toBe(true);
		await captureWindow(l, "test-results/history-complete-reload-bottom.png", { phase: "reload-bottom", geometry: reloadLastGeometry });
		await scrollLog(l.page, "top");
		await expect(l.page.locator(".message--user .message__user-text", { hasText: fixture.firstMarker })).toHaveCount(1);
		const reloadFirstGeometry = await ensureMarkerVisible(l.page, reloaded.keys[0], fixture.firstMarker);
		expect(reloadFirstGeometry.fullyVisible).toBe(true);

		// --- Sync pós-settle: get_entries devolve fixture + mensagens vivas ---
		// Volta ao fundo para a lista acompanhar as mensagens vivas.
		await scrollLog(l.page, "bottom");
		const box = l.page.locator("textarea").first();
		await box.fill(fixture.promptText);
		await box.press("Enter");
		await expect(l.page.getByText("Verificado.", { exact: false }).first()).toBeVisible({ timeout: 60_000 });
		// O callback do expect.poll não herda o narrowing de `l`: captura a Page.
		const page = l.page;
		await expect
			.poll(
				async () =>
					snapshotSummary(page, reloadedInfo, {
						prompt: fixture.promptText,
						verified: "Verificado.",
						first: fixture.firstMarker,
						last: fixture.lastMarker,
					}),
				{ timeout: 90_000, intervals: [500, 1000, 2000] },
			)
			.toMatchObject({ count: TOTAL + 3, prompt: 1, verified: 1, first: 1, last: 1 });

		const synced = await probeSnapshot(
			l.page,
			reloadedInfo,
			expectedHashes,
			TOTAL,
			markers,
			fixture.toolId,
			MIDDLE_INDEX,
			TOOL_INDEX,
		);
		expect(synced.count).toBe(TOTAL + 3);
		expect(synced.mismatchIndex, `conteúdo divergiu no sync no índice ${synced.mismatchIndex}: ${synced.mismatchCanonical ?? ""}`).toBe(-1);
		expect(synced.extra).toHaveLength(3);
		expect(synced.extra[0]).toMatchObject({ role: "user", text: fixture.promptText });
		expect(synced.extra[1]).toMatchObject({ role: "toolResult", toolCallId: "tool-1", toolName: "read", text: "runner-ok" });
		expect(synced.extra[2].role).toBe("assistant");
		expect(synced.extra[2].text).toContain("Verificado.");
		expect(synced.extra[2].toolCalls).toEqual([
			{ id: "tool-1", name: "read", arguments: { path: "smoke-omp.txt" } },
		]);
		expect(synced.markerCounts.first).toBe(1);
		expect(synced.markerCounts.last).toBe(1);
		expect(synced.markerCounts.middle).toBe(1);
		expect(synced.markerCounts.prompt).toBe(1);
		expect(synced.markerCounts.verified).toBe(1);
		expect(synced.markerCounts.omitted).toBe(0);
		const liveTool = synced.tools["tool-1"];
		expect(liveTool).toMatchObject({
			toolCallId: "tool-1",
			name: "read",
			status: "done",
			resultText: "runner-ok",
			arguments: { path: "smoke-omp.txt" },
		});
		expect(synced.tools[fixture.toolId]?.arguments).toEqual(fixture.toolArgs);
		expect(synced.tools[fixture.toolId]?.details).toEqual(fixture.toolDetails);

		await scrollLog(l.page, "bottom");
		await expect(l.page.locator(".message--user .message__user-text", { hasText: fixture.promptText })).toHaveCount(1);
		await expect(l.page.locator(".message--assistant .message__body", { hasText: "Verificado." })).toHaveCount(1);
		await expect(l.page.locator(".message--assistant .message__body", { hasText: fixture.lastMarker })).toHaveCount(1);
		// O sync prova o card vivo; o último marcador já foi provado fullyVisible
		// no bottom e no reload-bottom. Aqui a interseção registra o contexto.
		const syncLastGeometry = await markerGeometry(l.page, synced.keys[TOTAL - 1], fixture.lastMarker);
		expect(syncLastGeometry.intersects).toBe(true);
		const liveCard = l.page.locator("details.tool-card").filter({ hasText: "smoke-omp.txt" });
		await expect(liveCard).toHaveCount(1);
		if (!(await liveCard.evaluate((element) => (element as HTMLDetailsElement).open))) {
			await liveCard.locator("summary.tool-card__header").click();
		}
		await expect(liveCard.locator(".tool-card__output pre")).toContainText("runner-ok");
		const liveKey = await liveCard.evaluate((element) => element.closest("[data-msg-key]")?.getAttribute("data-msg-key") ?? "");
		if (!liveKey) throw new Error("chave do card vivo ausente");
		const syncGeometry = await ensureMarkerVisible(l.page, liveKey, "smoke-omp.txt");
		expect(syncGeometry.fullyVisible).toBe(true);
		await captureWindow(l, "test-results/history-complete-sync-bottom.png", {
			phase: "sync-bottom",
			geometry: syncGeometry,
			lastMarkerGeometry: syncLastGeometry,
		});
		await scrollLog(l.page, "top");
		await expect(l.page.locator(".message--user .message__user-text", { hasText: fixture.firstMarker })).toHaveCount(1);
		const syncFirstGeometry = await ensureMarkerVisible(l.page, synced.keys[0], fixture.firstMarker);
		expect(syncFirstGeometry.fullyVisible).toBe(true);
		expect(l.errors.filter((error) => /185|Maximum update depth/.test(error))).toEqual([]);
	} finally {
		if (l) await quit(l);
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		} catch {
			/* Windows pode manter o arquivo aberto até o host encerrar */
		}
	}
});

function writeSmallFixture(dir: string, messages: Array<Record<string, unknown>>): string {
	const entries = messages.map((message, index) => ({
		type: "message",
		id: `e${index + 1}`,
		parentId: index === 0 ? null : `e${index}`,
		timestamp: new Date(1_700_000_000_000 + index).toISOString(),
		message,
	}));
	const file = join(dir, "entries.json");
	writeFileSync(file, JSON.stringify({ entries, leafId: `e${messages.length}` }), "utf8");
	return file;
}

test("fallback paginado do get_messages_page abre a sessão com todas as mensagens na ordem", async () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-paged-history-"));
	const messages: Array<Record<string, unknown>> = Array.from({ length: 5 }, (_, index) => ({
		role: index % 2 === 0 ? "user" : "assistant",
		content: [{ type: "text", text: `PAGED-${index}` }],
		timestamp: 1_700_000_000_000 + index,
	}));
	const expectedTexts = messages.map((message) => {
		const content = Array.isArray(message.content) ? message.content : [];
		const first = content[0];
		return first && typeof first === "object" && "text" in first ? String(first.text ?? "") : "";
	});
	const fixturePath = writeSmallFixture(dir, messages);
	let l: Launched | undefined;
	try {
		l = await launch("basic", {
			FAKE_OMP_ENTRIES: fixturePath,
			FAKE_OMP_ENTRIES_FAIL: "1",
			FAKE_OMP_PAGE_SIZE: "2",
		});
		await l.page.getByText("workspace", { exact: true }).first().click();
		await l.page.getByRole("button", { name: "Criar sessão" }).click();
		await expect(l.page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });
		await expect(l.page.getByText("PAGED-4", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		const info = await openSessionInfo(l.page);
		const snapshot = await l.page.evaluate(
			async ({ workspaceId, sessionId }) => {
				const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
					Boolean(value) && typeof value === "object" && !Array.isArray(value);
				const api = window.ompDesktop;
				const result = await api.invoke({ op: "session.snapshot", workspaceId, sessionId });
				if (!result.ok) throw new Error(`session.snapshot falhou: ${JSON.stringify(result.error)}`);
				const data = result.data;
				const state = isPlainRecord(data) && isPlainRecord(data.state) ? data.state : undefined;
				const rawMessages = state && Array.isArray(state.messages) ? state.messages : [];
				return rawMessages.filter(isPlainRecord).map((message) => ({
					key: String(message.key ?? ""),
					role: String(message.role ?? ""),
					text: (Array.isArray(message.content) ? message.content : [])
						.filter(isPlainRecord)
						.filter((block) => block.type === "text")
						.map((block) => String(block.text ?? ""))
						.join("\n"),
				}));
			},
			info,
		);
		expect(snapshot.map((message) => message.text)).toEqual(expectedTexts);
		expect(snapshot.map((message) => message.role)).toEqual(messages.map((message) => message.role));
		expect(new Set(snapshot.map((message) => message.key)).size).toBe(messages.length);
		const rendered = await l.page.locator(".message__user-text, .message__body").allInnerTexts();
		expect(rendered.map((text) => text.trim())).toEqual(expectedTexts);
		expect(l.errors.filter((error) => /185|Maximum update depth/.test(error))).toEqual([]);
	} finally {
		if (l) await quit(l);
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});

test("get_entries FRAME_TOO_LARGE falha a criação sem abrir sessão vazia", async () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-frame-too-large-"));
	const fixturePath = writeSmallFixture(dir, [
		{ role: "user", content: [{ type: "text", text: "NAO-DEVE-ABRIR" }], timestamp: 1_700_000_000_000 },
	]);
	let l: Launched | undefined;
	try {
		l = await launch("basic", {
			FAKE_OMP_ENTRIES: fixturePath,
			FAKE_OMP_ENTRIES_FAIL: "frame_too_large",
		});
		await l.page.getByText("workspace", { exact: true }).first().click();
		await l.page.getByRole("button", { name: "Criar sessão" }).click();
		const alert = l.page.getByRole("alert").first();
		await expect(alert).toContainText("Não foi possível criar a sessão", { timeout: 30_000 });
		await expect(alert).toContainText(/grande demais|transporte/i);
		await expect(l.page.locator("textarea")).toHaveCount(0);
		await expect(l.page.locator(".message")).toHaveCount(0);
		await expect(l.page.getByRole("button", { name: "Criar sessão" })).toBeVisible();
	} finally {
		if (l) await quit(l);
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
