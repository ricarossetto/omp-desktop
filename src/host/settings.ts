/**
 * Configuração do OMP, sem segredos.
 *
 * - Leitura: `omp config list --json` (valores efetivos, redigidos pelo OMP) e
 *   `--scope=global|project` (somente o que cada camada escreve). O esquema de
 *   tipos/enums vem do registro instalado do OMP, nunca é inventado aqui.
 * - `global` no snapshot é a camada CRUA: só as chaves que o arquivo global
 *   define. `modelRoles`/`presets` são os efetivos (global + projeto) e servem
 *   apenas para exibição — editar/gravar usa sempre a camada crua.
 * - Gravação global: `omp config set <key> <json>` com revalidação da camada
 *   global (`expectedValue` exato ou `expectedMissing`), dentro de uma fila por
 *   chave para que duas gravações concorrentes não comparem contra o mesmo
 *   estado antigo. Divergência → CONFIG_CONFLICT.
 * - Gravação de projeto: só `modelRoles`, via
 *   `Settings.setProjectModelRole()`/`clearProjectModelRole()`. Tombstones
 *   (`role: null`) não contam como papel definido.
 * - Presets são lidos em runtime; aplicar é feito na sessão (prompt).
 */
import { isDeepStrictEqual } from "node:util";
import { all, lookup, type Setting } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { ModelCatalogDto, ModelCatalogEntry } from "../shared/contracts";
import { isRecord } from "../shared/session-state";
import {
	parseJsonOutput,
	resolveOmpPath,
	runOmp,
	type RunOmpOptions,
	type RunOmpResult,
} from "./omp-cli";
import { sanitizeForRenderer } from "./sanitize";

export interface SettingsSchemaEntry {
	type: string;
	description?: string;
	values?: string[];
	secret?: boolean;
}

export interface ModelPresetView {
	modelRoles: Record<string, string>;
	defaultThinkingLevel?: string;
}

export interface SettingsSnapshot {
	/** Camada global crua: apenas as chaves que o arquivo global define. */
	global: Record<string, unknown>;
	/** Camada de projeto crua. */
	project: Record<string, unknown>;
	/** Valores efetivos (todas as camadas), para exibição. */
	effective: Record<string, unknown>;
	schema: Record<string, SettingsSchemaEntry>;
	/** Presets efetivos (global + projeto); somente exibição. */
	presets: Record<string, ModelPresetView>;
	/** Papéis efetivos (global + projeto); somente exibição. */
	modelRoles: Record<string, string>;
	updatedAt: number;
}

export class SettingsError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SettingsError";
	}
}

interface ConfigLayerEntry {
	value?: unknown;
	redacted?: true;
	type?: string;
	description?: string;
}

/** Limites do catálogo: acima disso a tela não é utilizável e o payload é hostil. */
export const MAX_MODEL_CATALOG_ENTRIES = 5_000;
export const MAX_MODEL_CATALOG_BYTES = 8 * 1024 * 1024;
/** Catálogo muda pouco; evita repetir `omp models ls` a cada abertura de tela. */
const MODEL_CATALOG_TTL_MS = 60_000;

/**
 * `config/all-settings` registra as 580+ definições e puxa o grafo de todos os
 * domínios. O host é longo e a tela de configurações pode nunca abrir, então o
 * módulo é carregado só na primeira leitura (import estático aqui atrasaria o
 * boot do host sem necessidade).
 */
let allSettingsPromise: Promise<void> | undefined;
let schemaPromise: Promise<Record<string, SettingsSchemaEntry>> | undefined;

async function ensureSettingsLoaded(): Promise<void> {
	if (!allSettingsPromise) {
		allSettingsPromise = import("@oh-my-pi/pi-coding-agent/config/all-settings").then(() => undefined);
		allSettingsPromise.catch(() => {
			allSettingsPromise = undefined;
		});
	}
	return allSettingsPromise;
}

function settingToSchemaEntry(setting: Setting<unknown>): SettingsSchemaEntry {
	const description = setting.ui?.description;
	return {
		type: setting.type,
		description: typeof description === "string" && description.length > 0 ? description : undefined,
		values: setting.enumValues ? [...setting.enumValues] : undefined,
		secret: setting.isCredential,
	};
}

export async function settingsSchema(): Promise<Record<string, SettingsSchemaEntry>> {
	if (!schemaPromise) {
		schemaPromise = ensureSettingsLoaded().then(() => {
			const schema: Record<string, SettingsSchemaEntry> = {};
			for (const setting of all()) schema[setting.id] = settingToSchemaEntry(setting);
			return schema;
		});
		schemaPromise.catch(() => {
			schemaPromise = undefined;
		});
	}
	return schemaPromise;
}

async function lookupSetting(key: string): Promise<Setting<unknown> | undefined> {
	await ensureSettingsLoaded();
	return lookup(key);
}

function layerValues(raw: unknown): Record<string, unknown> {
	if (!isRecord(raw)) return {};
	const values: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(raw)) {
		if (!isRecord(entry)) continue;
		const typed = entry as ConfigLayerEntry;
		if (typed.redacted === true) continue;
		if ("value" in typed) values[key] = typed.value;
	}
	return values;
}

function recordOfStrings(raw: unknown): Record<string, string> {
	if (!isRecord(raw)) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

function presetsFrom(raw: unknown): Record<string, ModelPresetView> {
	if (!isRecord(raw)) return {};
	const out: Record<string, ModelPresetView> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (!isRecord(value)) continue;
		const preset: ModelPresetView = { modelRoles: recordOfStrings(value.modelRoles) };
		// Chave ausente não vira `defaultThinkingLevel: undefined`: o renderer
		// compara/grava o preset como veio e um `undefined` explícito viraria
		// diferença falsa no CONFIG_CONFLICT.
		if (typeof value.defaultThinkingLevel === "string") {
			preset.defaultThinkingLevel = value.defaultThinkingLevel;
		}
		out[name] = preset;
	}
	return out;
}

export interface SettingsReadContext {
	/** Caminho explícito do OMP; quando ausente, resolvido no PATH a cada uso. */
	ompPath?: string;
	/** Ambiente extra repassado ao OMP (testes/fixtures); produção herda o do host. */
	env?: Record<string, string | undefined>;
}

interface SaveInput {
	cwd: string;
	scope: "global" | "project";
	key: string;
	value: unknown;
	expectedValue?: unknown;
	expectedMissing?: boolean;
}

interface SaveResult {
	saved: true;
	key: string;
	value: unknown;
}

type Expectation = { missing: true } | { missing: false; value: unknown };

/**
 * `expectedValue` é obrigatório; a ausência da chave é declarada por
 * `expectedMissing`, nunca inferida de `undefined` (que some no JSON).
 */
function expectationOf(input: SaveInput): Expectation {
	if (input.expectedMissing === true) {
		if (input.expectedValue !== undefined) {
			throw new SettingsError(
				"INVALID_REQUEST",
				"expectedMissing e expectedValue são mutuamente exclusivos; recarregue as configurações.",
			);
		}
		return { missing: true };
	}
	if (input.expectedValue === undefined) {
		throw new SettingsError(
			"INVALID_REQUEST",
			"O valor esperado da configuração é obrigatório para evitar sobrescrever mudanças externas. Recarregue as configurações.",
		);
	}
	return { missing: false, value: input.expectedValue };
}

function assertLayerExpectation(
	layer: Record<string, unknown>,
	key: string,
	expectation: Expectation,
	message: string,
): void {
	const present = Object.hasOwn(layer, key);
	if (expectation.missing) {
		if (present) throw new SettingsError("CONFIG_CONFLICT", message);
		return;
	}
	if (!present || !isDeepStrictEqual(layer[key], expectation.value)) {
		throw new SettingsError("CONFIG_CONFLICT", message);
	}
}

export class SettingsService {
	private readonly saveQueues = new Map<string, Promise<unknown>>();
	private readonly modelsCache = new Map<string, { at: number; value: ModelCatalogDto }>();
	private readonly modelsInFlight = new Map<string, Promise<ModelCatalogDto>>();

	constructor(private readonly readContext: () => SettingsReadContext) {}

	/** Spawn/ENOENT nunca vira INTERNAL: é OMP indisponível. */
	private async run(args: readonly string[], options: RunOmpOptions): Promise<RunOmpResult> {
		const context = this.readContext();
		const configured = context.ompPath ?? resolveOmpPath();
		if (!configured) {
			throw new SettingsError(
				"OMP_UNAVAILABLE",
				"O executável do OMP não foi encontrado. Selecione o executável na tela de diagnóstico.",
			);
		}
		try {
			return await runOmp(configured, args, { ...options, env: context.env });
		} catch (error) {
			throw new SettingsError(
				"OMP_UNAVAILABLE",
				`Não foi possível executar o OMP: ${(error as Error).message}`,
			);
		}
	}

	/**
	 * Lê uma camada e falha alto: camada ilegível NUNCA vira `{}` (comparar
	 * contra um mapa vazio apagaria a proteção de CONFIG_CONFLICT).
	 */
	private async readLayer(
		cwd: string,
		scope: "effective" | "global" | "project",
	): Promise<Record<string, unknown>> {
		const args =
			scope === "effective"
				? ["config", "list", "--json"]
				: ["config", "list", `--scope=${scope}`, "--json"];
		const label =
			scope === "effective" ? "efetiva" : scope === "global" ? "global" : "do projeto";
		const result = await this.run(args, { cwd, timeoutMs: 60_000 });
		if (result.timedOut) {
			throw new SettingsError(
				"INTERNAL",
				`O OMP demorou demais para ler a configuração ${label}. Tente novamente em alguns instantes.`,
			);
		}
		if (result.exitCode !== 0) {
			throw new SettingsError(
				"OMP_UNAVAILABLE",
				`Não foi possível ler a configuração ${label} do OMP: ${summarize(result.stderr, result.stdout)}`,
			);
		}
		const parsed = parseJsonOutput(result.stdout);
		if (!isRecord(parsed)) {
			throw new SettingsError(
				"OMP_UNAVAILABLE",
				`O OMP não devolveu a configuração ${label} esperada (omp config list --json).`,
			);
		}
		return layerValues(parsed);
	}

	/**
	 * Catálogo de `omp models ls --json`. Não exige sessão nem projeto; o
	 * onboarding usa um diretório neutro como cwd. Chamadas concorrentes são
	 * deduplicadas e o resultado fica em cache por um minuto.
	 */
	async listModels(cwd: string): Promise<ModelCatalogDto> {
		const cached = this.modelsCache.get(cwd);
		if (cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS) return cached.value;
		const running = this.modelsInFlight.get(cwd);
		if (running) return running;
		const task = this.fetchModels(cwd)
			.then((value) => {
				this.modelsCache.set(cwd, { at: Date.now(), value });
				return value;
			})
			.finally(() => {
				this.modelsInFlight.delete(cwd);
			});
		this.modelsInFlight.set(cwd, task);
		return task;
	}

	private async fetchModels(cwd: string): Promise<ModelCatalogDto> {
		const result = await this.run(["models", "ls", "--json"], { cwd, timeoutMs: 120_000 });
		if (result.timedOut) {
			throw new SettingsError(
				"INTERNAL",
				"O OMP demorou demais para listar os modelos. Tente novamente em alguns instantes.",
			);
		}
		if (result.exitCode !== 0) {
			throw new SettingsError(
				"OMP_UNAVAILABLE",
				`Não foi possível listar os modelos do OMP: ${summarize(result.stderr, result.stdout)}`,
			);
		}
		if (Buffer.byteLength(result.stdout, "utf8") > MAX_MODEL_CATALOG_BYTES) {
			throw new SettingsError(
				"INTERNAL",
				`O catálogo de modelos do OMP excede ${Math.floor(MAX_MODEL_CATALOG_BYTES / (1024 * 1024))} MiB. Desative provedores que você não usa ou atualize o OMP.`,
			);
		}
		const models = projectModelCatalog(parseJsonOutput(result.stdout));
		if (!models) {
			throw new SettingsError(
				"OMP_UNAVAILABLE",
				"O OMP não devolveu o catálogo de modelos esperado (omp models ls --json).",
			);
		}
		if (models.length > MAX_MODEL_CATALOG_ENTRIES) {
			throw new SettingsError(
				"INTERNAL",
				`O catálogo de modelos do OMP tem ${models.length} entradas; o limite é ${MAX_MODEL_CATALOG_ENTRIES}. Desative provedores que você não usa.`,
			);
		}
		return { models, updatedAt: Date.now() };
	}

	async list(cwd: string): Promise<SettingsSnapshot> {
		const [effective, global, project, schema] = await Promise.all([
			this.readLayer(cwd, "effective"),
			this.readLayer(cwd, "global"),
			this.readLayer(cwd, "project"),
			settingsSchema(),
		]);
		const snapshot: SettingsSnapshot = {
			global,
			project,
			effective,
			schema,
			presets: presetsFrom(effective.modelPresets),
			modelRoles: recordOfStrings(effective.modelRoles),
			updatedAt: Date.now(),
		};
		// Nenhum segredo/baseUrl com credenciais/token de transporte sai do host,
		// mesmo que uma configuração externa os contenha.
		return sanitizeForRenderer(snapshot);
	}

	async save(input: SaveInput): Promise<SaveResult> {
		// Fila por chave: a leitura da camada acontece DENTRO do lock, então duas
		// gravações concorrentes nunca comparam contra o mesmo estado antigo.
		const queueKey = `${input.scope}:${input.key}`;
		const previous = this.saveQueues.get(queueKey) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(() => this.saveUnlocked(input));
		this.saveQueues.set(queueKey, run);
		try {
			return await run;
		} finally {
			if (this.saveQueues.get(queueKey) === run) this.saveQueues.delete(queueKey);
		}
	}

	private async saveUnlocked(input: SaveInput): Promise<SaveResult> {
		const expectation = expectationOf(input);
		if (input.scope === "project") return this.saveProject(input, expectation);
		return this.saveGlobal(input, expectation);
	}

	private async saveGlobal(input: SaveInput, expectation: Expectation): Promise<SaveResult> {
		const setting = await lookupSetting(input.key);
		if (!setting) {
			throw new SettingsError(
				"INVALID_REQUEST",
				`A configuração "${input.key}" não existe nesta versão do OMP. Recarregue as configurações.`,
			);
		}
		if (setting.isCredential) {
			throw new SettingsError(
				"INVALID_REQUEST",
				"Credenciais não são editáveis por esta tela; use a tela de contas ou o terminal do OMP.",
			);
		}
		const parsed = parseSettingValue(setting, input.value);
		const current = await this.readLayer(input.cwd, "global");
		assertLayerExpectation(
			current,
			input.key,
			expectation,
			"A configuração global mudou desde que esta tela foi aberta. Recarregue antes de salvar novamente.",
		);
		const result = await this.run(["config", "set", input.key, JSON.stringify(parsed)], {
			cwd: input.cwd,
			timeoutMs: 60_000,
		});
		if (result.timedOut) {
			throw new SettingsError(
				"INTERNAL",
				`O OMP demorou demais para salvar "${input.key}". Tente novamente em alguns instantes.`,
			);
		}
		if (result.exitCode !== 0) {
			throw new SettingsError(
				"INTERNAL",
				`O OMP recusou salvar "${input.key}": ${summarize(result.stderr, result.stdout)}`,
			);
		}
		return { saved: true, key: input.key, value: parsed };
	}

	private async saveProject(input: SaveInput, expectation: Expectation): Promise<SaveResult> {
		if (input.key !== "modelRoles") {
			throw new SettingsError(
				"UNSUPPORTED",
				"Nesta versão, o escopo de projeto edita somente os papéis de modelo (modelRoles). Use o escopo global para as demais opções.",
			);
		}
		if (!isRecord(input.value)) {
			throw new SettingsError("INVALID_REQUEST", "modelRoles deve ser um mapa de papel → modelo.");
		}
		for (const [role, model] of Object.entries(input.value)) {
			if (typeof model !== "string" || model.trim().length === 0) {
				throw new SettingsError(
					"INVALID_REQUEST",
					`O papel "${role}" precisa apontar para um modelo no formato provider/modelo.`,
				);
			}
		}
		if (!expectation.missing && !isRecord(expectation.value)) {
			throw new SettingsError(
				"INVALID_REQUEST",
				"A expectativa dos papéis do projeto deve ser um mapa de papel → modelo.",
			);
		}
		const currentProject = await this.readLayer(input.cwd, "project");
		// Tombstones (`role: null`) não são papéis definidos: normalizar antes de
		// comparar/limpar evita CONFIG_CONFLICT falso e clear repetido.
		const currentRoles = recordOfStrings(currentProject.modelRoles);
		if (expectation.missing) {
			if (Object.hasOwn(currentProject, "modelRoles")) {
				throw new SettingsError(
					"CONFIG_CONFLICT",
					"Os papéis de modelo do projeto mudaram desde que esta tela foi aberta. Recarregue antes de salvar.",
				);
			}
		} else {
			const expectedRoles = recordOfStrings(expectation.value);
			if (!isDeepStrictEqual(currentRoles, expectedRoles)) {
				throw new SettingsError(
					"CONFIG_CONFLICT",
					"Os papéis de modelo do projeto mudaram desde que esta tela foi aberta. Recarregue antes de salvar.",
				);
			}
		}
		// Import tardio: `config/settings` carrega migrações e um grafo grande que
		// não deve atrasar o boot do host para quem nunca salva papéis de projeto.
		const { Settings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
		const settings = await Settings.loadIsolated({ cwd: input.cwd });
		const desired = recordOfStrings(input.value);
		try {
			for (const role of Object.keys(currentRoles)) {
				if (desired[role] === undefined) settings.clearProjectModelRole(role);
			}
			for (const [role, model] of Object.entries(desired)) {
				settings.setProjectModelRole(role, model);
			}
			await settings.flush();
		} catch (error) {
			throw new SettingsError(
				"INTERNAL",
				`O OMP recusou salvar os papéis do projeto: ${(error as Error).message}`,
			);
		}
		return { saved: true, key: input.key, value: desired };
	}
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const list = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return list.length > 0 ? list : undefined;
}

function projectModelCatalog(raw: unknown): ModelCatalogEntry[] | undefined {
	if (!isRecord(raw) || !Array.isArray(raw.models)) return undefined;
	const models: ModelCatalogEntry[] = [];
	for (const entry of raw.models) {
		if (!isRecord(entry)) continue;
		if (typeof entry.provider !== "string" || !entry.provider) continue;
		if (typeof entry.id !== "string" || !entry.id) continue;
		const cost = isRecord(entry.cost)
			? {
					input: finiteNumber(entry.cost.input),
					output: finiteNumber(entry.cost.output),
					cacheRead: finiteNumber(entry.cost.cacheRead),
					cacheWrite: finiteNumber(entry.cost.cacheWrite),
				}
			: undefined;
		models.push({
			provider: entry.provider,
			id: entry.id,
			name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
			selector:
				typeof entry.selector === "string" && entry.selector
					? entry.selector
					: `${entry.provider}/${entry.id}`,
			contextWindow: finiteNumber(entry.contextWindow),
			maxTokens: finiteNumber(entry.maxTokens),
			reasoning: entry.reasoning === true,
			thinking: stringList(entry.thinking),
			input: stringList(entry.input),
			cost,
		});
	}
	models.sort((left, right) => {
		const provider = left.provider.localeCompare(right.provider);
		return provider !== 0 ? provider : left.name.localeCompare(right.name);
	});
	return models;
}

function parseSettingValue(setting: Setting<unknown>, value: unknown): unknown {
	let text: string;
	try {
		text = typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		throw new SettingsError("INVALID_REQUEST", "O valor informado não pode ser convertido em JSON.");
	}
	if (typeof text !== "string") {
		throw new SettingsError("INVALID_REQUEST", "O valor informado é inválido.");
	}
	try {
		const parsed = setting.parse(text);
		setting.assertWritable(parsed);
		return parsed;
	} catch (error) {
		throw new SettingsError(
			"INVALID_REQUEST",
			`Valor inválido para "${setting.id}": ${(error as Error).message}`,
		);
	}
}

function summarize(stderr: string, stdout: string): string {
	const text = (stderr.trim().length > 0 ? stderr : stdout).trim();
	if (text.length === 0) return "sem detalhes do OMP";
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
