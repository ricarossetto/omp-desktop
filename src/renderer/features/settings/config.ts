/**
 * Normalização e validação das configurações do OMP para a UI.
 * Nada aqui lê credenciais: o host entrega apenas valores projetados.
 */
import type { MessageKey } from "../../i18n/pt-BR";
import { errorCode, isRecord, unwrapRpcData } from "../agents/ui-utils";

export type SettingScope = "global" | "project";

export interface SettingSchema {
	type: string;
	description?: string;
	values?: string[];
}

export interface PresetView {
	name: string;
	modelRoles: Record<string, string>;
	defaultThinkingLevel?: string;
}

export interface SettingsSnapshot {
	/** Camada global crua (valores como o OMP gravou, sem herdar projeto). */
	global: Record<string, unknown>;
	/** Somente o que a camada de projeto define. */
	project: Record<string, unknown>;
	/** Presets efetivos (global + projeto), somente para exibição. */
	presets: Record<string, PresetView>;
	/**
	 * Presets crus da camada global, usados como `expectedValue` ao salvar.
	 * Nunca misture com os efetivos: gravar um preset de projeto no global é
	 * exatamente o conflito que esta separação evita.
	 */
	presetsRaw: Record<string, unknown>;
	modelRoles: Record<string, string>;
	projectModelRoles: Record<string, string>;
	schema: Record<string, SettingSchema>;
	hasSchema: boolean;
	updatedAt?: number;
}

export interface ModelOption {
	provider: string;
	id: string;
	name: string;
	image: boolean;
	reasoning: boolean;
}

export interface LoginProviderView {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
}

export interface LogoutAccountView {
	credentialId: number;
	provider: string;
	label: string;
	detail?: string;
	type?: string;
	active?: boolean;
}

export interface UsageWindowView {
	label: string;
	usedPercent?: number;
	resetsAt?: number;
}

export interface UsageAccountView {
	credentialId?: number;
	label?: string;
	detail?: string;
	active?: boolean;
	windows: UsageWindowView[];
}

export interface UsageProviderView {
	providerId: string;
	label?: string;
	accounts: UsageAccountView[];
}

export interface UsageView {
	providers: UsageProviderView[];
	updatedAt?: number;
	unknown: boolean;
}

function stringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string" && entry.trim()) result[key] = entry;
	}
	return result;
}

function unwrapSettingEntries(map: unknown): {
	values: Record<string, unknown>;
	schema: Record<string, SettingSchema>;
} {
	const values: Record<string, unknown> = {};
	const schema: Record<string, SettingSchema> = {};
	if (!isRecord(map)) return { values, schema };
	for (const [key, entry] of Object.entries(map)) {
		if (
			isRecord(entry) &&
			typeof entry.type === "string" &&
			("value" in entry || entry.redacted === true)
		) {
			if (entry.redacted !== true) values[key] = entry.value;
			schema[key] = {
				type: entry.type,
				description: typeof entry.description === "string" ? entry.description : undefined,
				values: Array.isArray(entry.values)
					? entry.values.filter((item): item is string => typeof item === "string")
					: undefined,
			};
			continue;
		}
		values[key] = entry;
	}
	return { values, schema };
}

function normalizeSchemaMap(raw: unknown): Record<string, SettingSchema> {
	const result: Record<string, SettingSchema> = {};
	if (!isRecord(raw)) return result;
	for (const [key, entry] of Object.entries(raw)) {
		if (isRecord(entry) && typeof entry.type === "string") {
			result[key] = {
				type: entry.type,
				description: typeof entry.description === "string" ? entry.description : undefined,
				values: Array.isArray(entry.values)
					? entry.values.filter((item): item is string => typeof item === "string")
					: undefined,
			};
		} else if (typeof entry === "string") {
			result[key] = { type: entry };
		}
	}
	return result;
}

function normalizePreset(name: string, raw: unknown): PresetView | null {
	const record = isRecord(raw) && isRecord(raw.value) ? raw.value : raw;
	if (!isRecord(record)) return null;
	const modelRoles = stringMap(record.modelRoles);
	const defaultThinkingLevel =
		typeof record.defaultThinkingLevel === "string" ? record.defaultThinkingLevel : undefined;
	if (Object.keys(modelRoles).length === 0 && !defaultThinkingLevel) return null;
	return { name, modelRoles, defaultThinkingLevel };
}

/** Aceita o DTO do host e, defensivamente, o shape do `config list --json`. */
export function normalizeSettings(raw: unknown): SettingsSnapshot {
	const value = unwrapRpcData(raw);
	const source = isRecord(value) ? value : {};
	const globalSource = source.global ?? source.effective ?? source.settings ?? {};
	const projectSource = source.project ?? {};
	const globalEntries = unwrapSettingEntries(globalSource);
	const projectEntries = unwrapSettingEntries(projectSource);
	const topSchema = normalizeSchemaMap(source.schema ?? {});

	const globalPresets = globalEntries.values.modelPresets;
	const projectPresets = projectEntries.values.modelPresets;
	// Exibição: o host já manda os efetivos em `presets`; para payloads crus
	// (`config list --json`) caímos para a camada global e depois a de projeto.
	const displayPresets =
		(isRecord(source.presets) && source.presets) ||
		(isRecord(globalPresets) && globalPresets) ||
		(isRecord(projectPresets) && projectPresets) ||
		{};
	// Gravação: somente a camada global. Se ela não define `modelPresets`, o
	// mapa é vazio e o save usa `expectedMissing` — jamais o efetivo.
	const presetsRaw = isRecord(globalPresets) ? globalPresets : {};
	const presets: Record<string, PresetView> = {};
	for (const [name, presetRaw] of Object.entries(displayPresets)) {
		const preset = normalizePreset(name, presetRaw);
		if (preset) presets[name] = preset;
	}

	const topRoles = source.modelRoles;
	const globalRoles = globalEntries.values.modelRoles;
	const projectRoles = projectEntries.values.modelRoles;
	const mergedSchema = { ...globalEntries.schema, ...projectEntries.schema, ...topSchema };
	const hasSchema = Object.keys(mergedSchema).length > 0;

	return {
		global: globalEntries.values,
		project: projectEntries.values,
		presets,
		presetsRaw,
		modelRoles: Object.keys(stringMap(topRoles)).length > 0 ? stringMap(topRoles) : stringMap(globalRoles),
		projectModelRoles: stringMap(projectRoles),
		schema: mergedSchema,
		hasSchema,
		updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : undefined,
	};
}

export function settingValue(snapshot: SettingsSnapshot, key: string): unknown {
	return snapshot.global[key];
}

export function inferSettingType(value: unknown): string {
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "number") return "number";
	if (typeof value === "string") return "string";
	if (Array.isArray(value)) return "array";
	if (isRecord(value)) return "record";
	return "unknown";
}

// ---------------------------------------------------------------------------
// Modelos e raciocínio
// ---------------------------------------------------------------------------

export function normalizeAvailableModels(raw: unknown): ModelOption[] {
	const value = unwrapRpcData(raw);
	const list = isRecord(value) && Array.isArray(value.models) ? value.models : Array.isArray(value) ? value : [];
	const models: ModelOption[] = [];
	for (const entry of list) {
		if (!isRecord(entry)) continue;
		const provider = typeof entry.provider === "string" ? entry.provider : undefined;
		const id = typeof entry.id === "string" ? entry.id : undefined;
		if (!provider || !id) continue;
		models.push({
			provider,
			id,
			name: typeof entry.name === "string" && entry.name ? entry.name : id,
			image: Array.isArray(entry.input) && entry.input.includes("image"),
			reasoning: entry.reasoning === true,
		});
	}
	models.sort((left, right) => {
		const provider = left.provider.localeCompare(right.provider);
		return provider !== 0 ? provider : left.name.localeCompare(right.name, "pt-BR");
	});
	return models;
}

export function normalizeThinkingLevels(raw: unknown): string[] {
	const value = unwrapRpcData(raw);
	const list = isRecord(value) && Array.isArray(value.levels) ? value.levels : Array.isArray(value) ? value : [];
	return list.filter((entry): entry is string => typeof entry === "string");
}

export function modelSelector(model: ModelOption): string {
	return `${model.provider}/${model.id}`;
}

export function splitModelSelector(selector: string | undefined): { provider: string; id: string } | null {
	if (!selector) return null;
	const index = selector.indexOf("/");
	if (index <= 0 || index === selector.length - 1) return null;
	return { provider: selector.slice(0, index), id: selector.slice(index + 1) };
}

export function groupModels(models: readonly ModelOption[]): Array<{ provider: string; models: ModelOption[] }> {
	const groups = new Map<string, ModelOption[]>();
	for (const model of models) {
		const list = groups.get(model.provider) ?? [];
		list.push(model);
		groups.set(model.provider, list);
	}
	return [...groups.entries()].map(([provider, entries]) => ({ provider, models: entries }));
}

// ---------------------------------------------------------------------------
// Papéis, presets e opções avançadas
// ---------------------------------------------------------------------------

export function roleNames(snapshot: SettingsSnapshot): string[] {
	return [
		...new Set([
			...Object.keys(globalModelRoles(snapshot)),
			...Object.keys(snapshot.projectModelRoles),
			// Papéis só efetivos continuam visíveis para edição; o valor global
			// mostrado começa vazio, nunca com o efetivo herdado.
			...Object.keys(snapshot.modelRoles),
		]),
	].sort((left, right) => left.localeCompare(right, "pt-BR"));
}

/** Papéis da camada global (não confundir com o efetivo que inclui projeto). */
export function globalModelRoles(snapshot: SettingsSnapshot): Record<string, string> {
	return stringMap(snapshot.global.modelRoles);
}

/**
 * Valor esperado para `settings.save` segundo a camada que será gravada.
 * Chave ausente vira `expectedMissing: true` (nunca `{}` nem o efetivo).
 */
export function expectedLayerValue(
	snapshot: SettingsSnapshot,
	scope: SettingScope,
	key: string,
): { expectedValue?: unknown; expectedMissing?: true } {
	const layer = scope === "project" ? snapshot.project : snapshot.global;
	if (!Object.hasOwn(layer, key)) return { expectedMissing: true };
	if (scope === "project" && key === "modelRoles") {
		// O host normaliza tombstones (`role: null`) antes de comparar.
		return { expectedValue: snapshot.projectModelRoles };
	}
	return { expectedValue: layer[key] };
}

export function effectiveRole(snapshot: SettingsSnapshot, role: string): string | undefined {
	return snapshot.projectModelRoles[role] ?? globalModelRoles(snapshot)[role] ?? snapshot.modelRoles[role];
}

export function withRole(
	roles: Record<string, string>,
	role: string,
	value: string | null,
): Record<string, string> {
	const next = { ...roles };
	if (value) next[role] = value;
	else delete next[role];
	return next;
}

/** Remove chaves `undefined` recursivamente: o JSON do OMP não as aceita. */
function stripUndefined(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripUndefined).filter((entry) => entry !== undefined);
	}
	if (isRecord(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			const cleaned = stripUndefined(entry);
			if (cleaned !== undefined) out[key] = cleaned;
		}
		return out;
	}
	return value;
}

export function presetMapForSave(
	snapshot: SettingsSnapshot,
	preset: PresetView,
	previousName?: string,
): Record<string, unknown> {
	const next: Record<string, unknown> = {};
	for (const [name, raw] of Object.entries(snapshot.presetsRaw)) {
		if (previousName && previousName !== preset.name && name === previousName) continue;
		next[name] = stripUndefined(raw);
	}
	const entry: Record<string, unknown> = { modelRoles: preset.modelRoles };
	if (preset.defaultThinkingLevel) entry.defaultThinkingLevel = preset.defaultThinkingLevel;
	next[preset.name] = entry;
	return next;
}

export function validatesPreset(
	preset: PresetView,
): { ok: true } | { ok: false; error: MessageKey } {
	const name = preset.name.trim();
	if (!name) return { ok: false, error: "settings.validation.presetName" };
	if (name.length > 100) return { ok: false, error: "settings.validation.presetNameLong" };
	if (Object.keys(preset.modelRoles).length === 0 && !preset.defaultThinkingLevel) {
		return { ok: false, error: "settings.validation.presetEmpty" };
	}
	return { ok: true };
}

export const ADVANCED_OPTION_LABELS: Record<string, MessageKey> = {
	"task.agentModelOverrides": "settings.advanced.option.agentModelOverrides",
	"retry.usageAwareFallback": "settings.advanced.option.usageAwareFallback",
	"retry.usageReservePct": "settings.advanced.option.usageReservePct",
	"retry.fallbackChains": "settings.advanced.option.fallbackChains",
	"task.softRequestBudget": "settings.advanced.option.softRequestBudget",
	"task.agentSoftRequestBudget": "settings.advanced.option.agentSoftRequestBudget",
	"tools.approval": "settings.advanced.option.approval",
	"tools.approvalMode": "settings.advanced.option.approvalMode",
};

const ADVANCED_OPTION_KEYS = Object.keys(ADVANCED_OPTION_LABELS);

export interface AdvancedOption {
	key: string;
	label: MessageKey;
	description?: string;
	type: string;
	values?: string[];
	value: unknown;
	projectOverride: unknown;
	hasProjectOverride: boolean;
}

/**
 * Somente opções conhecidas e presentes no esquema/valores efetivos.
 * Nunca inventa chaves que o OMP instalado não anunciou.
 */
export function advancedOptions(snapshot: SettingsSnapshot): AdvancedOption[] {
	const options: AdvancedOption[] = [];
	for (const key of ADVANCED_OPTION_KEYS) {
		const schema = snapshot.schema[key];
		const inGlobal = Object.hasOwn(snapshot.global, key);
		const inProject = Object.hasOwn(snapshot.project, key);
		if (!schema && !inGlobal && !inProject) continue;
		const value = snapshot.global[key];
		const projectOverride = snapshot.project[key];
		options.push({
			key,
			label: ADVANCED_OPTION_LABELS[key],
			description: schema?.description,
			type: schema?.type ?? inferSettingType(value ?? projectOverride),
			values: schema?.values,
			value,
			projectOverride,
			hasProjectOverride: inProject,
		});
	}
	return options;
}

export function serializeSettingValue(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: MessageKey };

/** Valida o texto do editor genérico segundo o tipo anunciado pelo OMP. */
export function parseSettingInput(
	type: string,
	input: string | boolean,
	values?: readonly string[],
): ParseResult {
	switch (type) {
		case "boolean": {
			if (typeof input === "boolean") return { ok: true, value: input };
			if (input === "true") return { ok: true, value: true };
			if (input === "false") return { ok: true, value: false };
			return { ok: false, error: "settings.validation.boolean" };
		}
		case "number": {
			const text = String(input).trim();
			if (!text) return { ok: false, error: "settings.validation.numberRequired" };
			const parsed = Number(text);
			if (!Number.isFinite(parsed)) return { ok: false, error: "settings.validation.numberInvalid" };
			return { ok: true, value: parsed };
		}
		case "string": {
			return { ok: true, value: String(input) };
		}
		case "enum": {
			const text = String(input).trim();
			if (!text) return { ok: false, error: "settings.validation.enumRequired" };
			if (values && values.length > 0) {
				return values.includes(text)
					? { ok: true, value: text }
					: { ok: false, error: "settings.validation.enumAllowed" };
			}
			return { ok: true, value: text };
		}
		case "array": {
			try {
				const parsed: unknown = JSON.parse(String(input));
				return Array.isArray(parsed)
					? { ok: true, value: parsed }
					: { ok: false, error: "settings.validation.array" };
			} catch {
				return { ok: false, error: "settings.validation.arrayInvalid" };
			}
		}
		case "record": {
			try {
				const parsed: unknown = JSON.parse(String(input));
				return isRecord(parsed)
					? { ok: true, value: parsed }
					: { ok: false, error: "settings.validation.record" };
			} catch {
				return { ok: false, error: "settings.validation.recordInvalid" };
			}
		}
		default:
			return { ok: false, error: "settings.validation.unknownType" };
	}
}

export function isConfigConflict(error: unknown): boolean {
	return errorCode(error) === "CONFIG_CONFLICT";
}

// ---------------------------------------------------------------------------
// Contas e uso
// ---------------------------------------------------------------------------

export function normalizeLoginProviders(raw: unknown): LoginProviderView[] {
	const value = unwrapRpcData(raw);
	const list = isRecord(value) && Array.isArray(value.providers) ? value.providers : [];
	const providers: LoginProviderView[] = [];
	for (const entry of list) {
		if (!isRecord(entry)) continue;
		if (typeof entry.id !== "string" || !entry.id) continue;
		providers.push({
			id: entry.id,
			name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
			available: entry.available !== false,
			authenticated: entry.authenticated === true,
		});
	}
	return providers.sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
}

export function normalizeLogoutAccounts(raw: unknown): LogoutAccountView[] {
	const value = unwrapRpcData(raw);
	const list = isRecord(value) && Array.isArray(value.accounts) ? value.accounts : [];
	const accounts: LogoutAccountView[] = [];
	for (const entry of list) {
		if (!isRecord(entry)) continue;
		if (typeof entry.credentialId !== "number" || typeof entry.provider !== "string") continue;
		accounts.push({
			credentialId: entry.credentialId,
			provider: entry.provider,
			label: typeof entry.label === "string" ? entry.label : `${entry.provider} · ${entry.credentialId}`,
			detail: typeof entry.detail === "string" ? entry.detail : undefined,
			type: typeof entry.type === "string" ? entry.type : undefined,
			active: entry.active === true,
		});
	}
	return accounts;
}

function usedFractionFromAmount(amount: unknown): number | undefined {
	if (!isRecord(amount)) return undefined;
	if (typeof amount.usedFraction === "number" && Number.isFinite(amount.usedFraction)) {
		return amount.usedFraction;
	}
	if (typeof amount.remainingFraction === "number" && Number.isFinite(amount.remainingFraction)) {
		return 1 - amount.remainingFraction;
	}
	if (typeof amount.used === "number" && typeof amount.limit === "number" && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && typeof amount.used === "number") return amount.used / 100;
	return undefined;
}

function percentFromFraction(fraction: number | undefined): number | undefined {
	if (fraction === undefined || !Number.isFinite(fraction)) return undefined;
	return fraction * 100;
}

/** Normaliza `account.usage` (DTO do host) e o payload bruto do `omp usage --json`. */
export function normalizeUsage(raw: unknown): UsageView {
	const value = unwrapRpcData(raw);
	if (!isRecord(value)) return { providers: [], unknown: true };

	if (Array.isArray(value.providers)) {
		const providers: UsageProviderView[] = [];
		for (const providerEntry of value.providers) {
			if (!isRecord(providerEntry) || typeof providerEntry.providerId !== "string") continue;
			const accounts: UsageAccountView[] = [];
			for (const accountEntry of Array.isArray(providerEntry.accounts) ? providerEntry.accounts : []) {
				if (!isRecord(accountEntry)) continue;
				const windows: UsageWindowView[] = [];
				for (const windowEntry of Array.isArray(accountEntry.windows) ? accountEntry.windows : []) {
					if (!isRecord(windowEntry)) continue;
					windows.push({
						// Rótulo ausente fica vazio; a UI traduz o fallback.
						label: typeof windowEntry.label === "string" ? windowEntry.label : "",
						usedPercent:
							typeof windowEntry.usedPercent === "number" && Number.isFinite(windowEntry.usedPercent)
								? windowEntry.usedPercent
								: undefined,
						resetsAt: typeof windowEntry.resetsAt === "number" ? windowEntry.resetsAt : undefined,
					});
				}
				accounts.push({
					credentialId:
						typeof accountEntry.credentialId === "number" ? accountEntry.credentialId : undefined,
					label: typeof accountEntry.label === "string" ? accountEntry.label : undefined,
					detail: typeof accountEntry.detail === "string" ? accountEntry.detail : undefined,
					// O host omite `active` quando o OMP não informa; não invente false.
					active: typeof accountEntry.active === "boolean" ? accountEntry.active : undefined,
					windows,
				});
			}
			providers.push({
				providerId: providerEntry.providerId,
				label: typeof providerEntry.label === "string" ? providerEntry.label : undefined,
				accounts,
			});
		}
		const unknown =
			value.unknown === true ||
			providers.length === 0 ||
			providers.every(provider => provider.accounts.length === 0);
		return {
			providers,
			updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : undefined,
			unknown,
		};
	}

	// Payload bruto do `omp usage --json` (reports[].limits[]).
	if (Array.isArray(value.reports)) {
		const providers: UsageProviderView[] = [];
		for (const report of value.reports) {
			if (!isRecord(report) || typeof report.provider !== "string") continue;
			const label =
				typeof report.email === "string"
					? report.email
					: isRecord(report.scope) && typeof report.scope.accountId === "string"
						? report.scope.accountId
						: undefined;
			const windows: UsageWindowView[] = [];
			for (const limit of Array.isArray(report.limits) ? report.limits : []) {
				if (!isRecord(limit)) continue;
				const window = isRecord(limit.window) ? limit.window : undefined;
				const usedPercent = percentFromFraction(usedFractionFromAmount(limit.amount));
				windows.push({
					label:
						window && typeof window.label === "string"
							? window.label
							: typeof limit.label === "string"
								? limit.label
								: "",
					usedPercent,
					resetsAt: window && typeof window.resetsAt === "number" ? window.resetsAt : undefined,
				});
			}
			providers.push({
				providerId: report.provider,
				label: report.provider,
				accounts: [{ label, windows }],
			});
		}
		return {
			providers,
			updatedAt:
				typeof value.generatedAt === "number"
					? value.generatedAt
					: typeof value.updatedAt === "number"
						? value.updatedAt
						: undefined,
			unknown: providers.length === 0,
		};
	}

	return {
		providers: [],
		updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : undefined,
		unknown: true,
	};
}
