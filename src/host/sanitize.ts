/**
 * Projeção de dados do OMP para o renderer.
 *
 * Separa duas coisas que não podem ser confundidas:
 * - Campos de TRANSPORTE (providerPayload, headers, apiKey, tokens, baseUrl com
 *   credenciais) são removidos/redigidos.
 * - CONTEÚDO de conversa (texto, thinking, imagens, `arguments`/`content`/
 *   `details` de ferramentas) é preservado literalmente e por referência, sem
 *   limite de profundidade: uma ferramenta pode ler um arquivo com chaves
 *   `headers`/`secret` e isso é dado, não segredo.
 *
 * Nenhuma redaction por prefixo (`sk-...`) é aplicada a texto: isso corromperia
 * mensagens do usuário. Segredos só em campos de transporte e nos logs.
 */
import type { AttachmentDto, RuntimeStatus } from "../shared/contracts";
import { isRecord } from "../shared/session-state";

/**
 * Chaves de metadados de transporte/credencial. Não inclui nomes genéricos
 * (`token`, `auth`, `secret`, `password`) para não corromper argumentos de
 * ferramenta nem conteúdo de arquivo mostrado na conversa.
 */
const DROP_KEYS: Record<string, true> = {
	providerPayload: true,
	providerMetadata: true,
	providerFile: true,
	providerFileReference: true,
	headers: true,
	requestHeaders: true,
	responseHeaders: true,
	apiKey: true,
	api_key: true,
	apikey: true,
	authorization: true,
	accessToken: true,
	access_token: true,
	refreshToken: true,
	refresh_token: true,
	idToken: true,
	id_token: true,
	clientSecret: true,
	client_secret: true,
};

/** Chaves de topo que só existem para o dump da TUI e incham o transporte. */
const DROP_TOP_LEVEL: Record<string, true> = { systemPrompt: true, dumpTools: true, raw: true };

/**
 * Subárvores que carregam CONTEÚDO, não transporte: a projeção para de
 * remover chaves a partir daqui.
 */
const CONTENT_KEYS: Record<string, true> = {
	arguments: true,
	args: true,
	content: true,
	details: true,
	partialResult: true,
	result: true,
	update: true,
	toolCall: true,
	toolResult: true,
};

const MAX_DEPTH = 16;

/** Chave de transporte, exata ou aninhada em mapas de configuração (`providers.x.apiKey`). */
function droppedTransportKey(key: string): boolean {
	if (DROP_KEYS[key] === true) return true;
	const dot = key.lastIndexOf(".");
	if (dot < 0) return false;
	return DROP_KEYS[key.slice(dot + 1)] === true;
}

function isBaseUrlKey(key: string): boolean {
	return key === "baseUrl" || key.endsWith(".baseUrl");
}

function scrubbedBaseUrl(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		const url = new URL(value);
		if (url.username || url.password) return "[redigido: credenciais na URL]";
		return value;
	} catch {
		return value;
	}
}

function scrub(value: unknown, depth: number, topLevel: boolean, content: boolean): unknown {
	// Subárvore de CONTEÚDO é dado de conversa, não transporte: a política de
	// segredo não se aplica dentro dela e o valor atravessa por referência,
	// sem limite de profundidade nem cópia destrutiva.
	if (content) return value;
	if (depth > MAX_DEPTH) return "[limite de profundidade]";
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.map((item) => scrub(item, depth + 1, false, false));
	}
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (droppedTransportKey(key)) continue;
			if (topLevel && DROP_TOP_LEVEL[key] === true) continue;
			if (isBaseUrlKey(key)) {
				out[key] = scrubbedBaseUrl(item);
				continue;
			}
			out[key] = scrub(item, depth + 1, false, CONTENT_KEYS[key] === true);
		}
		return out;
	}
	return undefined;
}

/** Sanitiza um frame RPC (objeto já parseado). */
export function sanitizeFrame<T = unknown>(frame: T): T {
	return scrub(frame, 0, true, false) as T;
}

/** Sanitiza um DTO/estado que será devolvido ao renderer. */
export function sanitizeForRenderer<T = unknown>(value: T): T {
	return scrub(value, 0, false, false) as T;
}

/**
 * Projeta um resultado de `session.rpc`: campos de transporte fora, conteúdo
 * intacto. `systemPrompt`/`dumpTools` de `get_state` ficam no topo do objeto e
 * são removidos porque só existem para depuração da TUI.
 */
export function sanitizeRpcResult<T = unknown>(value: T): T {
	return scrub(value, 0, true, false) as T;
}

/** Modelo projetado para seletores: sem baseUrl/credenciais nem campos de wire. */
export interface ModelDto {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
	reasoning?: boolean;
}

export function projectModel(raw: unknown): ModelDto | null {
	if (!isRecord(raw)) return null;
	const provider = typeof raw.provider === "string" ? raw.provider : undefined;
	const id = typeof raw.id === "string" ? raw.id : undefined;
	if (!provider || !id) return null;
	return {
		provider,
		id,
		name: typeof raw.name === "string" ? raw.name : undefined,
		contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : undefined,
		maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : undefined,
		input: Array.isArray(raw.input)
			? raw.input.filter((item): item is string => typeof item === "string")
			: undefined,
		reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
	};
}

export function projectModels(raw: unknown): ModelDto[] {
	const list = isRecord(raw) ? raw.models : raw;
	if (!Array.isArray(list)) return [];
	return list.map(projectModel).filter((model): model is ModelDto => model !== null);
}

/** DTO de conta/cota sem tokens; uso desconhecido continua desconhecido. */
export interface UsageWindowDto {
	label: string;
	usedPercent?: number;
	resetsAt?: number;
	status?: string;
}

export interface UsageAccountDto {
	credentialId?: number;
	label?: string;
	detail?: string;
	planType?: string;
	active?: boolean;
	windows: UsageWindowDto[];
}

export interface UsageProviderDto {
	providerId: string;
	label?: string;
	accounts: UsageAccountDto[];
}

export interface AccountUsageDto {
	providers: UsageProviderDto[];
	updatedAt?: number;
	unknown: boolean;
	message?: string;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Percentual com uma casa, como as telas de cota do OMP imprimem. */
function percentOfFraction(fraction: number): number {
	return Math.round(fraction * 1000) / 10;
}

/**
 * Precedência espelha `@oh-my-pi/pi-ai` (`resolveUsedFraction`): fração
 * explícita > used/limit > unidade percentual > fração restante invertida.
 */
function percentOf(amount: unknown): number | undefined {
	if (!isRecord(amount)) return undefined;
	const fraction = finiteNumber(amount.usedFraction);
	if (fraction !== undefined) return percentOfFraction(fraction);
	const used = finiteNumber(amount.used);
	const limit = finiteNumber(amount.limit);
	if (used !== undefined && limit !== undefined && limit > 0) {
		return percentOfFraction(used / limit);
	}
	if (amount.unit === "percent" && used !== undefined) return percentOfFraction(used / 100);
	const remaining = finiteNumber(amount.remainingFraction);
	if (remaining !== undefined) return percentOfFraction(Math.max(0, 1 - remaining));
	return undefined;
}

/** Projeta `omp usage --json` em DTO de contas agrupadas por provedor. */
export function projectUsage(raw: unknown): AccountUsageDto {
	if (!isRecord(raw)) return { providers: [], unknown: true, message: "O OMP não devolveu dados de uso." };
	const generatedAt = finiteNumber(raw.generatedAt);
	const byProvider = new Map<string, UsageProviderDto>();
	const providerFor = (providerId: string): UsageProviderDto => {
		const existing = byProvider.get(providerId);
		if (existing) return existing;
		const created: UsageProviderDto = { providerId, label: providerId, accounts: [] };
		byProvider.set(providerId, created);
		return created;
	};

	const reports = Array.isArray(raw.reports) ? raw.reports : [];
	for (const report of reports) {
		if (!isRecord(report)) continue;
		const providerId = stringValue(report.provider) ?? "desconhecido";
		const metadata = isRecord(report.metadata) ? report.metadata : {};
		const limits = Array.isArray(report.limits) ? report.limits : [];
		const windows: UsageWindowDto[] = limits.filter(isRecord).map((limit) => ({
			label:
				stringValue(limit.label) ??
				(isRecord(limit.window) ? (stringValue(limit.window.label) ?? "Janela") : "Janela"),
			usedPercent: percentOf(limit.amount),
			resetsAt: isRecord(limit.window) ? finiteNumber(limit.window.resetsAt) : undefined,
			status: stringValue(limit.status),
		}));
		const credentialId = finiteNumber(metadata.credentialId) ?? finiteNumber(report.credentialId);
		const planType = stringValue(metadata.planType);
		providerFor(providerId).accounts.push({
			credentialId: credentialId === undefined ? undefined : Math.trunc(credentialId),
			// E-mail é o rótulo que o OMP expõe; nunca inclui token/ID de acesso.
			label:
				stringValue(metadata.email) ??
				stringValue(metadata.label) ??
				stringValue(metadata.accountId) ??
				planType,
			detail: planType ?? stringValue(metadata.accountId),
			planType,
			// O OMP não informa "conta ativa" no `usage --json`: inventar `true`
			// faria a UI eleger uma conta. Só propaga quando vier booleano.
			...(typeof report.active === "boolean" ? { active: report.active } : {}),
			windows,
		});
	}
	const withoutUsage = Array.isArray(raw.accountsWithoutUsage) ? raw.accountsWithoutUsage : [];
	for (const entry of withoutUsage) {
		if (!isRecord(entry)) continue;
		const providerId = stringValue(entry.provider) ?? stringValue(entry.id) ?? "desconhecido";
		providerFor(providerId).accounts.push({
			label: stringValue(entry.label) ?? stringValue(entry.account) ?? stringValue(entry.email),
			detail: stringValue(entry.planType),
			planType: stringValue(entry.planType),
			...(typeof entry.active === "boolean" ? { active: entry.active } : {}),
			windows: [],
		});
	}
	const providers = [...byProvider.values()].sort((left, right) => left.providerId.localeCompare(right.providerId));
	const hasWindows = providers.some((provider) => provider.accounts.some((account) => account.windows.length > 0));
	// "Desconhecido" é ausência de PERCENTUAL, não de janela: uma janela sem
	// amount continua desconhecida (nunca vira 0%).
	const hasPercent = providers.some((provider) =>
		provider.accounts.some((account) => account.windows.some((window) => window.usedPercent !== undefined)),
	);
	return {
		providers,
		updatedAt: generatedAt,
		unknown: !hasPercent,
		...(providers.length === 0
			? { message: "O OMP não tem estatísticas de cota para as contas conectadas." }
			: !hasPercent
				? {
						message: hasWindows
							? "As janelas de cota não informaram percentual de uso."
							: "As contas conectadas não informaram janelas de cota.",
					}
				: {}),
	};
}

export function projectAttachment(dto: AttachmentDto): AttachmentDto {
	return {
		attachmentId: dto.attachmentId,
		name: dto.name,
		mimeType: dto.mimeType,
		size: dto.size,
		kind: dto.kind,
	};
}

export function projectRuntimeStatus(raw: Partial<RuntimeStatus>): Partial<RuntimeStatus> {
	return {
		phase: raw.phase,
		ompPath: raw.ompPath,
		ompVersion: raw.ompVersion,
		gitVersion: raw.gitVersion,
		shell: raw.shell,
		bunPath: raw.bunPath,
		message: raw.message,
		signed: false,
	};
}
