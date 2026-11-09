/**
 * Fake do processo OMP para os testes do host e do Playwright.
 *
 * Fala o mesmo JSONL do `omp --mode rpc-ui` (ready, negotiate v2, responses por
 * id, eventos de mensagem/ferramenta, prompt_result, session_settled, diálogos
 * `ask`, subagentes, crash, queda e frame grande).
 *
 * Como usar:
 *   - `OmpTransport`/host: defina `OMP_DESKTOP_OMP_PATH` (ou `--omp-path`) para
 *     este arquivo `.ts`; o host o executa com o próprio Bun e passa
 *     `--mode rpc-ui`. `--resume <arquivo>` vira a sessão aberta (uma sessão
 *     distinta por arquivo, como no OMP real).
 *   - Controle por variáveis de ambiente:
 *       FAKE_OMP_SCENARIO=basic|stream|partial|ask|dialogs|crash|subagent|huge|no_v2|badchunk|echo
 *       FAKE_OMP_SESSION_FILE=<caminho .jsonl>
 *       FAKE_OMP_SESSION_ID=<id fixo; padrão derivado do --resume>
 *       FAKE_OMP_ENTRIES=<json com {entries,leafId}>
 *       FAKE_OMP_ENTRIES_FAIL=1 (host cai no paginado) | frame_too_large (falha explícita, sem fallback)
 *       FAKE_OMP_PAGE_SIZE=<n>   (get_messages_page pagina em N mensagens por cursor)
 *       FAKE_OMP_PAGE_REPEAT_CURSOR=1   (repete o cursor; testa a detecção do host)
 *       FAKE_OMP_PAGE_TOTAL_MISMATCH=1  (totalMessages inconsistente)
 *       FAKE_OMP_PAGE_EMPTY=1           (página vazia com cursor)
 *       FAKE_OMP_PAGE_INCOMPLETE=1      (termina antes do total, sem cursor)
 *       FAKE_OMP_RECORD=<arquivo onde registrar prompts, diálogos e chamadas CLI>
 *       FAKE_OMP_PROTOCOL=1   (força v1)
 *       FAKE_OMP_MAX_FRAME=<bytes>
 *       FAKE_OMP_CONFIG_FILE=<json da camada global>
 *       FAKE_OMP_PROJECT_CONFIG_FILE=<json da camada de projeto; padrão <cwd>/.omp/config.yml>
 *       FAKE_OMP_CONFIG_FAIL=list|set
 *       FAKE_OMP_MODELS=empty|error|huge
 *       FAKE_OMP_USAGE=error|used_limit
 */
import { YAML } from "bun";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";


if (process.argv.includes("--version")) {
	console.log("omp/18.16.0");
	process.exit(0);
}

const scenario = process.env.FAKE_OMP_SCENARIO ?? "basic";
const supportsV2 = process.env.FAKE_OMP_PROTOCOL !== "1";
const resumeIndex = process.argv.indexOf("--resume");
const resumePath = resumeIndex >= 0 ? process.argv[resumeIndex + 1] : undefined;
const sessionFile =
	resumePath ??
	process.env.FAKE_OMP_SESSION_FILE ??
	// PID sozinho não basta: o Windows reutiliza PIDs e um processo novo
	// carregaria o histórico deixado por outro teste. O sufixo aleatório
	// garante um arquivo novo por processo; `--resume` e FAKE_OMP_SESSION_FILE
	// continuam tendo precedência (restauração e harness explícito).
	path.join(os.tmpdir(), `fake-omp-${process.pid}-${randomUUID()}.jsonl`);
const recordPath = process.env.FAKE_OMP_RECORD;
const maxFrameBytes = Number(process.env.FAKE_OMP_MAX_FRAME ?? 1024 * 1024);
// No OMP real o id vem do arquivo da sessão: estável entre reinícios (permite
// reanexar a aba) e distinto por arquivo.
const sessionId =
	process.env.FAKE_OMP_SESSION_ID ?? `fake-session-${path.basename(sessionFile, path.extname(sessionFile))}`;

let negotiated = false;
let chunkCounter = 0;
let promptCount = 0;
const askPromptIds = new Map<string, string>();

function record(entry: unknown): void {
	if (!recordPath) return;
	try {
		fs.appendFileSync(recordPath, `${JSON.stringify(entry)}\n`, "utf8");
	} catch {
		/* teste sem arquivo */
	}
}

// O harness usa o argv para provar flags repassadas pelo host (approval-mode).
record({ type: "argv", argv: process.argv.slice(2) });

// ---------------------------------------------------------------------------
// Modo CLI (`omp config`, `omp models ls`, `omp usage`), usado pelo host sem
// sessão RPC. Mantém o estado em FAKE_OMP_CONFIG_FILE para que `config set`
// apareça no `config list` seguinte, como no OMP real.
// ---------------------------------------------------------------------------

const cliConfigPath = process.env.FAKE_OMP_CONFIG_FILE;
const cliProjectConfigPath = process.env.FAKE_OMP_PROJECT_CONFIG_FILE;

interface FakeCliConfig {
	[key: string]: unknown;
}

/** Chaves que o OMP real conhece (subconjunto exercitado pelo app). */
const KNOWN_CONFIG_KEYS = new Set([
	"modelRoles",
	"modelPresets",
	"defaultThinkingLevel",
	"task.agentModelOverrides",
	"retry.usageAwareFallback",
	"retry.usageReservePct",
	"retry.fallbackChains",
	"task.softRequestBudget",
	"task.agentSoftRequestBudget",
	"tools.approval",
	"tools.approvalMode",
]);

function isConfigRecord(value: unknown): value is FakeCliConfig {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readCliConfig(): FakeCliConfig {
	const fallback: FakeCliConfig = {
		modelRoles: { default: "fake/fake-model" },
		modelPresets: {},
	};
	if (!cliConfigPath) return fallback;
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(cliConfigPath, "utf8"));
		return isConfigRecord(parsed) ? parsed : fallback;
	} catch {
		return fallback;
	}
}

function writeCliConfig(config: FakeCliConfig): void {
	if (!cliConfigPath) return;
	fs.writeFileSync(cliConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Override JSON de teste ou o `.omp/config.yml` que o Settings real grava. */
function projectConfigPath(): string {
	return cliProjectConfigPath ?? path.join(process.cwd(), ".omp", "config.yml");
}

function readProjectConfig(): FakeCliConfig {
	try {
		const file = projectConfigPath();
		const text = fs.readFileSync(file, "utf8");
		const parsed: unknown = file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
		return isConfigRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function writeProjectConfig(config: FakeCliConfig): void {
	const file = projectConfigPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (file.endsWith(".json")) {
		fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		return;
	}
	fs.writeFileSync(file, YAML.stringify(config, null, 2), "utf8");
}

/**
 * Aceita tanto valores crus (formato do config.yml real) quanto entradas
 * `{value,type}` (fixtures antigas) e devolve sempre o valor cru.
 */
function unwrapEntry(value: unknown): unknown {
	return isConfigRecord(value) && "value" in value && typeof value.type === "string"
		? value.value
		: value;
}

function plainConfig(config: FakeCliConfig): FakeCliConfig {
	const out: FakeCliConfig = {};
	for (const [key, value] of Object.entries(config)) out[key] = unwrapEntry(value);
	return out;
}

function entriesOf(config: FakeCliConfig): Record<string, unknown> {
	const layer: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		layer[key] = {
			value,
			type:
				Array.isArray(value)
					? "array"
					: value !== null && typeof value === "object"
						? "record"
						: typeof value,
			description: `Configuração fake: ${key}`,
		};
	}
	return layer;
}

/** Efetivo = global + projeto, com mapas aninhados mesclados como no OMP real. */
function mergeConfig(global: FakeCliConfig, project: FakeCliConfig): FakeCliConfig {
	const merged: FakeCliConfig = { ...global };
	for (const [key, value] of Object.entries(project)) {
		const base = merged[key];
		merged[key] =
			isConfigRecord(base) && isConfigRecord(value) ? { ...base, ...value } : value;
	}
	return merged;
}

function configLayer(scope: "effective" | "global" | "project"): Record<string, unknown> {
	const global = plainConfig(readCliConfig());
	if (scope === "global") return entriesOf(global);
	const project = plainConfig(readProjectConfig());
	if (scope === "project") return entriesOf(project);
	return entriesOf(mergeConfig(global, project));
}

function scopeOf(args: readonly string[]): "global" | "project" | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--scope=project") return "project";
		if (arg === "--scope=global") return "global";
		if (arg === "--scope") {
			const next = args[index + 1];
			if (next === "project" || next === "global") return next;
		}
	}
	return undefined;
}

function modelCatalog(): unknown {
	return {
		models: [
			{
				provider: "fake",
				kind: "chat",
				id: "fake-model",
				selector: "fake/fake-model",
				name: "Fake Model",
				contextWindow: 200_000,
				maxTokens: 16_384,
				reasoning: true,
				thinking: ["low", "medium", "high"],
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				pricingStatus: "known",
			},
			{
				provider: "fake",
				kind: "chat",
				id: "fast-model",
				selector: "fake/fast-model",
				name: "Fast Model",
				contextWindow: 128_000,
				maxTokens: 8_192,
				reasoning: false,
				thinking: null,
				input: ["text"],
				cost: { input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.5 },
				pricingStatus: "known",
			},
			{
				provider: "outro",
				kind: "chat",
				id: "smart-model",
				selector: "outro/smart-model",
				name: "Smart Model",
				contextWindow: 1_000_000,
				maxTokens: 32_768,
				reasoning: true,
				thinking: ["medium", "high"],
				input: ["text", "image"],
				cost: null,
				pricingStatus: "unknown",
			},
		],
	};
}

function usagePayload(usedLimit = false): unknown {
	return {
		generatedAt: 1_700_000_000_000,
		reports: [
			{
				provider: "fake",
				metadata: { email: "dev@example.com", planType: "Pro", credentialId: 1 },
				limits: [
					{
						label: "Janela de 5h",
						amount: usedLimit ? { used: 5, limit: 10 } : { usedFraction: 0.42 },
						window: { label: "Janela de 5h", resetsAt: 1_700_003_600_000 },
					},
					{
						label: "Semana",
						amount: {},
						window: { label: "Semana" },
					},
				],
			},
			{
				provider: "outro",
				metadata: { email: "equipe@example.com", planType: "Free", credentialId: 2 },
				limits: [],
			},
		],
		accountsWithoutUsage: [
			{ provider: "terceiro", label: "sem-uso@example.com", planType: "Free" },
		],
	};
}

/** Executa um comando CLI do fake e encerra; retorna false para o modo RPC. */
function handleCli(args: readonly string[]): boolean {
	// `omp session lease --json -- <ids>`: sem isso o host trata a sessão como
	// “não verificável” e a restauração de abas nunca acontece nos testes.
	if (args[0] === "session" && args[1] === "lease") {
		record({ type: "session_lease" });
		console.log(JSON.stringify({ held: [], unknown: [] }));
		return true;
	}
	if (args[0] === "config") {
		const action = args[1];
		if (action === "list") {
			const scope = scopeOf(args) ?? "effective";
			record({ type: "config_list", scope });
			if (process.env.FAKE_OMP_CONFIG_FAIL === "list") {
				process.stderr.write("fake-omp: falha simulada em config list\n");
				process.exitCode = 1;
				return true;
			}
			process.stdout.write(`${JSON.stringify(configLayer(scope))}\n`);
			return true;
		}
		if (action === "set") {
			const positional: string[] = [];
			let scope: "global" | "project" = "global";
			for (let index = 2; index < args.length; index++) {
				const arg = args[index];
				if (arg === "--scope=project") {
					scope = "project";
					continue;
				}
				if (arg === "--scope=global") {
					scope = "global";
					continue;
				}
				if (arg === "--scope") {
					const next = args[index + 1];
					if (next === "project" || next === "global") {
						scope = next;
						index++;
						continue;
					}
				}
				positional.push(arg);
			}
			const key = positional[0];
			const rawValue = positional[1];
			if (!key || rawValue === undefined) {
				process.stderr.write("fake-omp: config set exige chave e valor\n");
				process.exitCode = 1;
				return true;
			}
			if (!KNOWN_CONFIG_KEYS.has(key)) {
				process.stderr.write(`fake-omp: chave de configuração desconhecida: ${key}\n`);
				process.exitCode = 1;
				return true;
			}
			if (process.env.FAKE_OMP_CONFIG_FAIL === "set") {
				process.stderr.write("fake-omp: falha simulada em config set\n");
				process.exitCode = 1;
				return true;
			}
			let value: unknown = rawValue;
			try {
				value = JSON.parse(rawValue);
			} catch {
				/* valor literal */
			}
			if (scope === "project") {
				const config = readProjectConfig();
				config[key] = value;
				writeProjectConfig(config);
			} else {
				const config = readCliConfig();
				config[key] = value;
				writeCliConfig(config);
			}
			record({ type: "config_set", key, value, scope });
			return true;
		}
		process.stderr.write(`fake-omp: ação de config desconhecida: ${String(action)}\n`);
		process.exitCode = 1;
		return true;
	}
	if (args[0] === "models" && args[1] === "ls") {
		record({ type: "models_ls" });
		const mode = process.env.FAKE_OMP_MODELS ?? "default";
		if (mode === "error") {
			process.stderr.write("fake-omp: falha simulada em models ls\n");
			process.exitCode = 1;
			return true;
		}
		if (mode === "empty") {
			process.stdout.write(`${JSON.stringify({ models: [] })}\n`);
			return true;
		}
		if (mode === "huge") {
			const models = Array.from({ length: 5_001 }, (_, index) => ({
				provider: "fake",
				id: `model-${index}`,
				selector: `fake/model-${index}`,
				name: `Model ${index}`,
			}));
			process.stdout.write(`${JSON.stringify({ models })}\n`);
			return true;
		}
		process.stdout.write(`${JSON.stringify(modelCatalog())}\n`);
		return true;
	}
	if (args[0] === "usage") {
		record({ type: "usage" });
		const mode = process.env.FAKE_OMP_USAGE ?? "default";
		if (mode === "error") {
			process.stderr.write("fake-omp: falha simulada em usage\n");
			process.exitCode = 1;
			return true;
		}
		process.stdout.write(`${JSON.stringify(usagePayload(mode === "used_limit"))}\n`);
		return true;
	}
	return false;
}

if (handleCli(process.argv.slice(2))) {
	process.exit(process.exitCode ?? 0);
}

// Só o modo RPC é uma sessão. O OMP real grava o arquivo da sessão e o host
// checa a existência ao restaurar abas; sem isso, a aba seria descartada como
// “arquivo removido”. Comandos CLI (`config`, `models`, `usage`) não podem
// criar nem carregar histórico.
try {
	if (!fs.existsSync(sessionFile)) {
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, "");
	}
} catch {
	/* diretório somente leitura: segue sem arquivo */
}

async function writeLine(line: string): Promise<void> {
	const result = Bun.stdout.write(line);
	if (typeof result !== "number") await result;
}

const history: unknown[] = [];
/** Grava a mensagem no arquivo da sessão, como o OMP real (permite restaurar histórico). */
function persistMessage(message: unknown): void {
	try {
		fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", message })}\n`, "utf8");
	} catch {
		/* diretório somente leitura */
	}
}
try {
	if (fs.existsSync(sessionFile)) {
		for (const line of fs.readFileSync(sessionFile, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as { message?: unknown };
				if (entry.message) history.push(entry.message);
			} catch {
				/* linha inválida */
			}
		}
	}
} catch {
	/* sem arquivo */
}

interface FixtureHistory {
	entries: Record<string, unknown>[];
	messages: unknown[];
	leafId: string | null;
}

/**
 * FAKE_OMP_ENTRIES é o branch inicial do OMP. As mensagens vivas (prompt,
 * toolResult, assistant) entram em `history`, e get_entries/get_messages_page
 * as concatenam ao fixture: o OMP real devolve o branch completo depois de um
 * turno, não só o arquivo inicial.
 */
function loadFixtureHistory(): FixtureHistory | undefined {
	const file = process.env.FAKE_OMP_ENTRIES;
	if (!file) return undefined;
	try {
		// Arquivo sintético produzido pelos testes; sem dependências do checkout,
		// pois esta fixture também é copiada para diretórios temporários.
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
			entries?: FixtureHistory["entries"];
			leafId?: unknown;
		};
		if (!parsed || !Array.isArray(parsed.entries)) return undefined;
		const entries = parsed.entries.filter(
			(entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry),
		);
		const messages = entries
			.filter((entry) => entry.type === "message" && typeof entry.message === "object" && entry.message !== null && !Array.isArray(entry.message))
			.map((entry) => entry.message);
		const last = entries[entries.length - 1];
		const leafId =
			typeof parsed.leafId === "string"
				? parsed.leafId
				: last && typeof last.id === "string"
					? last.id
					: null;
		return { entries, messages, leafId };
	} catch {
		return undefined;
	}
}

const fixtureHistory = loadFixtureHistory();
const queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
if (scenario === "virtual-scroll") {
	for (let index = 0; index < 600; index++) {
		history.push({
			role: "user",
			content: [{
				type: "text",
				text: `Mensagem de histórico ${index}\n${"Linha de conteúdo variável para exercitar a medição real.\n".repeat(index % 7 === 0 ? 90 : 1)}`,
			}],
			timestamp: 1_700_000_000_000 + index,
		});
	}
}
/**
 * Fila de escrita: um frame grande vira vários `rpc_chunk`, e chunks de frames
 * diferentes não podem se intercalar (o transporte do OMP trata a sequência
 * interrompida como frame inválido e encerra a sessão). O histórico é
 * atualizado na chamada; só a serialização entra na fila.
 */
let writeQueue: Promise<void> = Promise.resolve();

function sendFrame(frame: unknown): Promise<void> {
	{
		const f = frame as { type?: string; message?: unknown } | null;
		if (f?.type === "message_end" && f.message) {
			history.push(f.message);
			persistMessage(f.message);
		}
	}
	const task = writeQueue.then(() => writeFrame(frame));
	writeQueue = task.catch(() => undefined);
	return task;
}

async function writeFrame(frame: unknown): Promise<void> {
	const json = JSON.stringify(frame);
	const bytes = Buffer.byteLength(json, "utf8") + 1;
	if (negotiated && bytes > maxFrameBytes) {
		const buffer = Buffer.from(json, "utf8");
		const chunkId = `fake-${++chunkCounter}`;
		const payloadBytes = 200 * 1024;
		const count = Math.ceil(buffer.byteLength / payloadBytes);
		for (let index = 0; index < count; index++) {
			const slice = buffer.subarray(index * payloadBytes, (index + 1) * payloadBytes);
			await writeLine(
				`${JSON.stringify({
					type: "rpc_chunk",
					chunkId,
					index,
					count,
					byteLength: buffer.byteLength,
					data: slice.toString("base64"),
				})}\n`,
			);
		}
		return;
	}
	await writeLine(`${json}\n`);
}

function success(id: string | undefined, command: string, data?: unknown): void {
	void sendFrame(
		data === undefined
			? { id, type: "response", command, success: true }
			: { id, type: "response", command, success: true, data },
	);
}

function failure(id: string | undefined, command: string, error: string, code?: string): void {
	void sendFrame({ id, type: "response", command, success: false, error, ...(code ? { code } : {}) });
}

function state(): Record<string, unknown> {
	const input = (process.env.FAKE_OMP_MODEL_INPUT ?? "text,image")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	const data: Record<string, unknown> = {
		model: { provider: "fake", id: "fake-model", name: "Fake Model", input },
		thinkingLevel: "off",
		isStreaming: false,
		isCompacting: false,
		isSettled: true,
		hasPendingAsyncWork: false,
		messageCount: 0,
		queuedMessages: { steering: [], followUp: [], liveSteered: 0 },
		todoPhases: [],
		goal: null,
		sessionId,
		sessionFile,
		contextUsage: { tokens: 6400, contextWindow: 200000, percent: 3.2 },
	};
	if (scenario === "huge") {
		data.bigString = "Ω漢🙂αβγ".repeat(160_000);
	}
	if (scenario === "leak") {
		data.systemPrompt = ["instruções internas do sistema"];
		data.dumpTools = [{ name: "bash", description: "segredo de ferramenta" }];
		data.apiKey = "sk-fake-nao-pode-sair";
		data.providerPayload = { raw: "payload do provedor" };
	}
	return data;
}

function assistantContent(): unknown[] {
	return [
		{ type: "thinking", thinking: "vou verificar o arquivo" },
		{
			type: "text",
			text: "Verificando.\n\n[smoke-omp.txt](smoke-omp.txt) · [preview.png](preview.png)",
		},
		{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "smoke-omp.txt" }, intent: "ler arquivo" },
	];
}

function assistantMessage(id: string, content: unknown[], stopReason = "endTurn"): Record<string, unknown> {
	return {
		role: "assistant",
		content,
		api: "fake",
		provider: "fake",
		model: "fake-model",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
		stopReason,
		timestamp: Date.now(),
		messageId: id,
	};
}

async function afterPrompt(id: string | undefined, promptId: string): Promise<void> {
	switch (scenario) {
		case "crash":
			setTimeout(() => process.exit(7), 40);
			return;
		case "ask": {
			const askId = `ask-${promptId}`;
			askPromptIds.set(askId, promptId);
			await sendFrame({
				type: "extension_ui_request",
				id: askId,
				method: "ask",
				questions: [
					{
						id: "q1",
						question: "Qual arquivo?",
						options: [
							{ label: "a.txt", description: "primeiro" },
							{ label: "b.txt", description: "segundo" },
						],
						multi: false,
					},
					{
						id: "q2",
						question: "Quais opções?",
						options: [{ label: "alpha" }, { label: "beta" }],
						multi: true,
					},
				],
			});
			if (process.env.FAKE_OMP_EXIT_AFTER_UI === "1") {
				setTimeout(() => process.exit(11), 40);
			}
			return;
		}
		case "dialogs":
			await sendFrame({
				type: "extension_ui_request",
				id: `select-${promptId}`,
				method: "select",
				title: "Escolha",
				options: ["um", "dois"],
				optionDetails: [{ description: "primeiro" }, { description: "segundo" }],
			});
			await sendFrame({
				type: "extension_ui_request",
				id: `confirm-${promptId}`,
				method: "confirm",
				title: "Confirmar",
				message: "Prosseguir?",
			});
			return;
		case "subagent":
			await sendFrame({
				type: "subagent_lifecycle",
				payload: {
					id: "sub-1",
					agent: "runner",
					agentSource: "builtin",
					status: "started",
					index: 0,
					parentToolCallId: "tool-1",
					sessionFile: `${sessionFile.slice(0, -6)}/sub-1.jsonl`,
				},
			});
			await sendFrame({
				type: "subagent_progress",
				payload: {
					id: "sub-1",
					agent: "runner",
					index: 0,
					parentToolCallId: "tool-1",
					sessionFile: `${sessionFile.slice(0, -6)}/sub-1.jsonl`,
					progress: {
						id: "sub-1",
						index: 0,
						agent: "runner",
						status: "running",
						task: "criar smoke-omp.txt",
						resolvedModel: "fake/runner-model:max",
					},
				},
			});
			break;
		case "unknown_ui":
			await sendFrame({
				type: "extension_ui_request",
				id: `weird-${promptId}`,
				method: "escolhaDesconhecida",
				title: "Método futuro",
			});
			await sendFrame({
				type: "extension_ui_request",
				id: `status-${promptId}`,
				method: "setStatus",
				statusKey: "fake",
				statusText: "ocupado",
			});
			await sendFrame({
				type: "extension_ui_request",
				id: `fake-cancel-${promptId}`,
				method: "cancel",
				targetId: "nada",
			});
			break;
		default:
			break;
	}
	const partial = scenario === "partial";
	if (scenario === "diff") {
		const diff = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-const valor = 1;\n+const valor = 2;\n";
		const messageId = `m-${promptId}`;
		await sendFrame({ type: "message_start", messageId, message: assistantMessage(messageId, []) });
		await sendFrame({
			type: "message_end",
			messageId,
			message: assistantMessage(messageId, [
				{ type: "text", text: "Editei o arquivo." },
				{ type: "toolCall", id: "tool-diff", name: "edit", arguments: { path: "src/app.ts" } },
			]),
		});
		await sendFrame({
			type: "tool_execution_start",
			toolCallId: "tool-diff",
			toolName: "edit",
			args: { path: "src/app.ts" },
			intent: "editar arquivo",
		});
		await sendFrame({
			type: "tool_execution_end",
			toolCallId: "tool-diff",
			toolName: "edit",
			result: { content: [{ type: "text", text: "ok" }], details: { diff } },
			isError: false,
		});
		const resultId = `r-${promptId}`;
		await sendFrame({
			type: "message_start",
			messageId: resultId,
			message: { role: "toolResult", toolCallId: "tool-diff", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { diff }, timestamp: Date.now() },
		});
		await sendFrame({
			type: "message_end",
			messageId: resultId,
			message: { role: "toolResult", toolCallId: "tool-diff", toolName: "edit", content: [{ type: "text", text: "ok" }], details: { diff }, timestamp: Date.now() },
		});
	}
	if (scenario === "longtool") {
		await sendFrame({
			type: "tool_execution_start",
			toolCallId: "tool-long",
			toolName: "bash",
			args: { command: "trabalho" },
			intent: "passo demorado",
		});
		// O passo termina sozinho depois de 3 s: o app deve pausar e abortar aqui.
		setTimeout(() => {
			void (async () => {
				await sendFrame({
					type: "tool_execution_end",
					toolCallId: "tool-long",
					toolName: "bash",
					result: { content: [{ type: "text", text: "passo-concluido" }] },
					isError: false,
				});
				await sendFrame({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
				await sendFrame({
					type: "prompt_result",
					id,
					agentInvoked: true,
					status: "completed",
					sessionSettled: true,
				});
			})();
		}, Number(process.env.FAKE_OMP_TOOL_MS ?? 3000));
	}
	if (scenario === "stream" || partial) {
		const messageId = `m-${promptId}`;
		await sendFrame({ type: "message_start", messageId, message: assistantMessage(messageId, []) });
		// Duas atualizações completas e idênticas: o reducer não pode duplicar.
		const full = assistantMessage(messageId, assistantContent());
		await sendFrame({ type: "message_update", messageId, message: full, assistantMessageEvent: { type: "text_delta" } });
		await sendFrame({ type: "message_update", messageId, message: full, assistantMessageEvent: { type: "text_delta" } });
		await sendFrame({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "smoke-omp.txt" },
			intent: "ler arquivo",
		});
		await sendFrame({
			type: "tool_execution_update",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "smoke-omp.txt" },
			partialResult: { content: [{ type: "text", text: "runner-ok" }] },
		});
		await sendFrame({
			type: "tool_execution_end",
			toolCallId: "tool-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "runner-ok" }] },
			isError: false,
		});
		const resultId = `r-${promptId}`;
		await sendFrame({
			type: "message_start",
			messageId: resultId,
			message: {
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "runner-ok" }],
				isError: false,
				timestamp: Date.now(),
			},
		});
		await sendFrame({
			type: "message_end",
			messageId: resultId,
			message: {
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "read",
				content: [{ type: "text", text: "runner-ok" }],
				isError: false,
				timestamp: Date.now(),
			},
		});
		await sendFrame({
			type: "message_end",
			messageId,
			message: assistantMessage(messageId, [
				{ type: "thinking", thinking: "vou verificar o arquivo" },
				{
					type: "text",
					text: "Verificado.\n\n[smoke-omp.txt](smoke-omp.txt) · [preview.png](preview.png)",
				},
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "smoke-omp.txt" } },
			]),
		});
		await sendFrame({ type: "agent_end", messages: [], isTerminal: !partial, yielded: !partial });
	}
	if (scenario === "subagent") {
		await sendFrame({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
	}
	if (scenario === "longtool") {
		// O ack chega imediatamente; o prompt_result só vem quando o "bash" termina,
		// como no OMP real: a sessão segue ocupada até o prompt terminar.
		return;
	}
	await sendFrame({
		type: "prompt_result",
		id: id ?? promptId,
		agentInvoked: true,
		status: "completed",
		sessionSettled: scenario !== "partial",
	});
	if (scenario === "partial") {
		setTimeout(() => {
			void sendFrame({ type: "session_settled" });
		}, 120);
	}
}

async function handleCommand(command: Record<string, unknown>): Promise<void> {
	const id = typeof command.id === "string" ? command.id : undefined;
	const type = typeof command.type === "string" ? command.type : "";
	record({ type: "command", command: type, id });
	if (type === "prompt") {
		promptCount += 1;
		history.push({ role: "user", content: [{ type: "text", text: String(command.message ?? "") }], timestamp: Date.now() });
		persistMessage(history[history.length - 1]);
		record({ type: "prompt", count: promptCount, message: String(command.message ?? ""), id });
	}
	if (type === "bash" && scenario === "hang") return;
	if (type === "bash" && scenario === "exit") {
		process.exit(9);
	}
	if (type === "bash" && scenario === "badchunk") {
		await writeLine(
			`${JSON.stringify({
				type: "rpc_chunk",
				chunkId: "bad",
				index: 1,
				count: 2,
				byteLength: 2 * 1024 * 1024,
				data: Buffer.from("{}", "utf8").toString("base64"),
			})}\n`,
		);
		return;
	}
	if (type === "bash" && scenario === "echo") {
		const delay = command.command === "a" ? 120 : 0;
		setTimeout(() => {
			success(id, "bash", { echo: id });
		}, delay);
		return;
	}
	switch (type) {
		case "negotiate_protocol":
			if (!supportsV2) {
				failure(id, type, "Unsupported RPC protocol version: 2");
				return;
			}
			negotiated = true;
			success(id, type, { protocolVersion: 2 });
			return;
		case "get_state":
			success(id, type, state());
			return;
		case "get_available_commands":
			success(id, type, {
				commands: [
					{ name: "prompt", source: "builtin" },
					{
						name: "modelpreset",
						source: "builtin",
						subcommands: [{ name: "switch", usage: "/modelpreset switch <name>" }],
					},
					{ name: "revisar", source: "skill", description: "Skill de revisão" },
					{ name: "mcp__docs__buscar", source: "mcp_prompt", description: "Prompt do servidor MCP" },
				],
			});
			return;
		case "get_available_thinking_levels":
			success(id, type, { levels: ["off", "low", "medium"] });
			return;
		case "get_available_models":
			success(id, type, { models: [{ provider: "fake", id: "fake-model", name: "Fake Model" }] });
			return;
		case "compact":
			success(id, type, { summary: "compactado", tokensBefore: 1000, tokensAfter: 200 });
			await sendFrame({ type: "compaction_end", reason: "manual" });
			return;
		case "get_session_stats":
			success(id, type, {
				sessionFile,
				sessionId,
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 1,
				toolResults: 1,
				totalMessages: 3,
				tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
				premiumRequests: 0,
				cost: 0.42,
			});
			return;
		case "get_entries": {
			const entriesFailure = process.env.FAKE_OMP_ENTRIES_FAIL;
			if (entriesFailure === "1") {
				failure(id, type, "get_entries indisponível (fake)");
				return;
			}
			if (entriesFailure === "frame_too_large") {
				failure(id, type, "transport limit: frame too large", "frame_too_large");
				return;
			}
			if (fixtureHistory) {
				const live = history.map((message, index) => ({
					type: "message",
					id: `live-${index + 1}`,
					parentId: index === 0 ? fixtureHistory.leafId : `live-${index}`,
					timestamp: new Date().toISOString(),
					message,
				}));
				const entries = [...fixtureHistory.entries, ...live];
				const last = entries[entries.length - 1];
				const leafId = last && typeof last.id === "string" ? last.id : fixtureHistory.leafId;
				success(id, type, { entries, leafId });
				return;
			}
			{
				const entries = history.map((message, index) => ({
					type: "message",
					id: `e${index + 1}`,
					parentId: index === 0 ? null : `e${index}`,
					timestamp: new Date().toISOString(),
					message,
				}));
				success(id, type, { entries, leafId: entries.length ? `e${entries.length}` : null });
			}
			return;
		}
		case "get_messages_page": {
			const messages = fixtureHistory ? [...fixtureHistory.messages, ...history] : history;
			const pageSize = Number(process.env.FAKE_OMP_PAGE_SIZE ?? 0);
			const totalMessages =
				process.env.FAKE_OMP_PAGE_TOTAL_MISMATCH === "1" ? messages.length + 1 : messages.length;
			if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
				success(id, type, { messages, totalMessages });
				return;
			}
			const cursor = typeof command.cursor === "string" ? command.cursor : undefined;
			const offset = cursor === undefined ? 0 : Number(cursor);
			if (!Number.isSafeInteger(offset) || offset < 0) {
				failure(id, type, "cursor inválido", "invalid_cursor");
				return;
			}
			if (process.env.FAKE_OMP_PAGE_REPEAT_CURSOR === "1") {
				success(id, type, {
					messages: messages.slice(0, pageSize),
					totalMessages,
					nextCursor: "stuck",
				});
				return;
			}
			if (process.env.FAKE_OMP_PAGE_EMPTY === "1" && offset > 0) {
				success(id, type, {
					messages: [],
					totalMessages,
					nextCursor: String(offset + pageSize),
				});
				return;
			}
			const page = messages.slice(offset, offset + pageSize);
			const hasMore = offset + pageSize < messages.length;
			const nextCursor =
				hasMore && process.env.FAKE_OMP_PAGE_INCOMPLETE !== "1"
					? String(offset + pageSize)
					: undefined;
			success(id, type, {
				messages: page,
				totalMessages,
				...(nextCursor ? { nextCursor } : {}),
			});
			return;
		}
		case "get_subagents":
			success(id, type, {
				subagents:
					scenario === "subagent"
						? [
								{
									id: "sub-1",
									index: 0,
									agent: "runner",
									agentSource: "builtin",
									status: "running",
									task: "criar smoke-omp.txt",
									sessionFile: `${sessionFile.slice(0, -6)}/sub-1.jsonl`,
									parentToolCallId: "tool-1",
									lastUpdate: Date.now(),
									progress: {
										id: "sub-1",
										index: 0,
										agent: "runner",
										status: "running",
										resolvedModel: "fake/runner-model:max",
									},
								},
							]
						: [],
			});
			return;
		case "get_subagent_messages":
			success(id, type, {
				sessionFile: command.sessionFile ?? `${sessionFile.slice(0, -6)}/sub-1.jsonl`,
				fromByte: command.fromByte ?? 0,
				nextByte: 128,
				reset: false,
				entries: [],
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "child live" }],
						provider: "fake",
						model: "runner-model",
						timestamp: Date.now(),
					},
				],
			});
			return;
		case "prompt":
			// Simula ack perdido: o OMP recebeu o prompt mas nunca respondeu, e
			// continua vivo (o host deve marcar interrompido, não erro reenviável).
			if (scenario === "slow_ack") return;
			success(id, type, { agentInvoked: true });
			void afterPrompt(id, id ?? `prompt-${Date.now()}`);
			return;
		case "steer":
		case "follow_up":
			success(id, type);
			// O OMP publica a fila depois de aceitar; o chip do compositor vem daqui.
			queue.followUp.push(String(command.message ?? ""));
			await sendFrame({ type: "queue_update", steering: [...queue.steering], followUp: [...queue.followUp], liveSteered: 0 });
			return;
		case "remove_queued_message": {
			const message = String(command.message ?? "");
			const list = command.queue === "steering" ? queue.steering : queue.followUp;
			const index = list.indexOf(message);
			if (index >= 0) list.splice(index, 1);
			success(id, type, { removed: index >= 0 });
			await sendFrame({ type: "queue_update", steering: [...queue.steering], followUp: [...queue.followUp], liveSteered: 0 });
			return;
		}
		case "promote_queued_message": {
			const message = String(command.message ?? "");
			const index = queue.followUp.indexOf(message);
			const promoted = index >= 0;
			if (promoted) queue.followUp.splice(index, 1);
			success(id, type, { promoted });
			await sendFrame({ type: "queue_update", steering: [...queue.steering], followUp: [...queue.followUp], liveSteered: 0 });
			return;
		}
		case "abort":
			success(id, type);
			return;
		case "abort_and_restore_queue":
			success(id, type, { steering: [], followUp: [] });
			return;
		case "fork":
		case "branch":
			success(id, type, { cancelled: false });
			return;
		case "navigate_tree":
			success(id, type, { cancelled: false });
			return;
		case "new_session":
		case "switch_session":
		case "open_session":
			success(id, type, { cancelled: false, resumed: false, sessionId, sessionFile });
			return;
		case "export_html":
			success(id, type, { path: String(command.outputPath ?? "") });
			return;
		case "get_login_providers":
			success(id, type, { providers: [{ id: "fake", name: "Fake", available: true, authenticated: true }] });
			return;
		case "get_logout_accounts":
			success(id, type, { accounts: [] });
			return;
		case "login":
			success(id, type, { providerId: String(command.providerId ?? "fake") });
			return;
		case "logout":
			success(id, type, {});
			return;
		case "get_session_lease":
			success(id, type, { held: [], unknown: [] });
			return;
		case "extension_ui_response": {
			record({ type: "ui_response", response: command });
			const responseId = typeof command.id === "string" ? command.id : "";
			await sendFrame({ type: "notice", level: "info", message: `ui_response:${responseId}` });
			const promptId = askPromptIds.get(responseId);
			askPromptIds.delete(responseId);
			if (promptId) {
				await sendFrame({
					type: "prompt_result",
					id: promptId,
					agentInvoked: true,
					status: "completed",
					sessionSettled: true,
				});
				await sendFrame({ type: "session_settled" });
			}
			return;
		}
		case "set_ask_dialog":
			success(id, type, { enabled: true });
			return;
		case "set_subagent_subscription":
			success(id, type, { level: String(command.level ?? "off") });
			return;
		default:
			success(id, type);
	}
}

async function main(): Promise<void> {
	const ready = {
		type: "ready",
		protocolVersion: 1,
		supportedProtocolVersions: supportsV2 ? [1, 2] : [1],
		maxFrameBytes,
		maxReassembledFrameBytes: 64 * 1024 * 1024,
	};
	await sendFrame(ready);
	const reader = Bun.stdin.stream().getReader();
	const decoder = new TextDecoder("utf-8");
	let carry: Uint8Array = new Uint8Array(0);
	const concat = (left: Uint8Array, right: Uint8Array): Uint8Array => {
		if (left.byteLength === 0) return right;
		if (right.byteLength === 0) return left;
		const next = new Uint8Array(left.byteLength + right.byteLength);
		next.set(left, 0);
		next.set(right, left.byteLength);
		return next;
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		let start = 0;
		for (let index = 0; index < value.byteLength; index++) {
			if (value[index] !== 0x0a) continue;
			const slice = value.subarray(start, index);
			const lineBytes = carry.byteLength > 0 ? concat(carry, slice) : slice;
			carry = new Uint8Array(0);
			start = index + 1;
			const text = decoder.decode(lineBytes).trim();
			if (!text) continue;
			let command: unknown;
			try {
				command = JSON.parse(text);
			} catch {
				continue;
			}
			await handleCommand(command as Record<string, unknown>);
		}
		if (start < value.byteLength) carry = concat(carry, value.subarray(start));
	}
}

void main();
