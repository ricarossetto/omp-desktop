import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SessionViewState } from "@shared/session-types";
import { invoke } from "../../api";
import { LOCALES, LOCALE_LABELS, isLocale, useI18n, type MessageKey } from "../../i18n";
import { useActions, useStore } from "../../store/context";
import { FONT_SCALES, isThemeMode } from "../../store/state";
import { StatusIcon } from "../agents/StatusIcon";
import { errorCode, errorText, unwrapRpcData } from "../agents/ui-utils";
import { AccountsTab } from "../accounts/AccountsTab";
import { OptionalToolsSection } from "../diagnostics/OptionalToolsSection";
import { AboutTab } from "./AboutTab";
import { ApprovalsTab } from "./ApprovalsTab";
import { ShortcutsTab } from "./ShortcutsTab";
import { ModelPicker, ThinkingLevelControl } from "./ModelPicker";
import {
	advancedOptions,
	effectiveRole,
	expectedLayerValue,
	globalModelRoles,
	groupModels,
	isConfigConflict,
	modelSelector,
	normalizeAvailableModels,
	normalizeSettings,
	normalizeThinkingLevels,
	parseSettingInput,
	presetMapForSave,
	roleNames,
	serializeSettingValue,
	settingValue,
	splitModelSelector,
	validatesPreset,
	withRole,
	type AdvancedOption,
	type ModelOption,
	type PresetView,
	type SettingScope,
	type SettingsSnapshot,
} from "./config";
import "./settings.css";

export type SettingsTab =
	| "models"
	| "accounts"
	| "general"
	| "approvals"
	| "shortcuts"
	| "about";

export interface SettingsScreenProps {
	workspaceId: string;
	sessionId?: string;
	state?: SessionViewState;
	initialTab?: SettingsTab;
}

interface SaveResult {
	ok: boolean;
	error?: string;
}

interface PresetDraft {
	originalName?: string;
	name: string;
	modelRoles: Record<string, string>;
	defaultThinkingLevel?: string;
}

const TAB_LABELS: Record<SettingsTab, MessageKey> = {
	models: "settings.tab.models",
	accounts: "settings.tab.accounts",
	general: "settings.tab.general",
	approvals: "approval.settingsTab",
	shortcuts: "settings.tab.shortcuts",
	about: "settings.tab.about",
};

function uniquePresetName(snapshot: SettingsSnapshot, base: string): string {
	if (!Object.hasOwn(snapshot.presetsRaw, base)) return base;
	let index = 2;
	while (Object.hasOwn(snapshot.presetsRaw, `${base}-${index}`)) index += 1;
	return `${base}-${index}`;
}

function PresetEditor({
	snapshot,
	draft,
	models,
	levels,
	busy,
	error,
	onChange,
	onCancel,
	onSave,
}: {
	snapshot: SettingsSnapshot;
	draft: PresetDraft;
	models: ModelOption[];
	levels: string[];
	busy: boolean;
	error: string | null;
	onChange: (next: PresetDraft) => void;
	onCancel: () => void;
	onSave: () => void;
}) {
	const { t } = useI18n();
	const knownRoles = useMemo(
		() => [...new Set([...roleNames(snapshot), ...Object.keys(draft.modelRoles)])],
		[draft.modelRoles, snapshot],
	);
	const missingRoles = roleNames(snapshot).filter(role => !(role in draft.modelRoles));
	const [roleToAdd, setRoleToAdd] = useState("");

	const setRole = (role: string, selector: string) => {
		const next = { ...draft.modelRoles };
		if (selector.trim()) next[role] = selector.trim();
		else delete next[role];
		onChange({ ...draft, modelRoles: next });
	};

	return (
		<div className="omp-preset-editor" role="group" aria-label={t("settings.preset.editorLabel")}>
			<div className="omp-preset-editor-head">
				<h3>{draft.originalName ? t("settings.preset.editTitle") : t("settings.preset.newTitle")}</h3>
				<span className="omp-muted">{t("settings.preset.saveHint")}</span>
			</div>
			<label className="omp-field">
				<span>{t("settings.preset.name")}</span>
				<input
					value={draft.name}
					onChange={event => onChange({ ...draft, name: event.target.value })}
					maxLength={100}
					disabled={busy}
				/>
			</label>
			<label className="omp-field">
				<span>{t("settings.preset.defaultThinking")}</span>
				<select
					value={draft.defaultThinkingLevel ?? ""}
					onChange={event =>
						onChange({ ...draft, defaultThinkingLevel: event.target.value || undefined })
					}
					disabled={busy || levels.length === 0}
				>
					<option value="">{t("settings.preset.inherit")}</option>
					{levels.map(level => (
						<option key={level} value={level}>
							{level}
						</option>
					))}
					{draft.defaultThinkingLevel && !levels.includes(draft.defaultThinkingLevel) ? (
						<option value={draft.defaultThinkingLevel}>
							{t("settings.preset.configured", { level: draft.defaultThinkingLevel })}
						</option>
					) : null}
				</select>
			</label>
			{levels.length === 0 ? (
				<p className="omp-muted">{t("settings.preset.levelsUnavailable")}</p>
			) : null}

			<div className="omp-preset-roles">
				{knownRoles.length === 0 ? (
					<p className="omp-muted">{t("settings.preset.noRoles")}</p>
				) : null}
				{knownRoles.map(role => (
					<div key={role} className="omp-preset-role-row">
						<label>
							<span>{role}</span>
							<input
								list="omp-preset-model-list"
								value={draft.modelRoles[role] ?? ""}
								onChange={event => setRole(role, event.target.value)}
								placeholder={t("settings.preset.modelPlaceholder")}
								disabled={busy}
							/>
						</label>
						<button
							type="button"
							className="omp-button omp-button-small"
							onClick={() => setRole(role, "")}
							disabled={busy || !(role in draft.modelRoles)}
						>
							{t("settings.preset.removeRole")}
						</button>
					</div>
				))}
				<datalist id="omp-preset-model-list">
					{models.map(model => (
						<option key={modelSelector(model)} value={modelSelector(model)}>
							{model.name}
						</option>
					))}
				</datalist>
			</div>

			{missingRoles.length > 0 ? (
				<div className="omp-row">
					<label className="omp-field omp-field-inline">
						<span>{t("settings.preset.addRole")}</span>
						<select value={roleToAdd} onChange={event => setRoleToAdd(event.target.value)} disabled={busy}>
							<option value="">{t("settings.preset.select")}</option>
							{missingRoles.map(role => (
								<option key={role} value={role}>
									{role}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						className="omp-button omp-button-small"
						disabled={busy || !roleToAdd}
						onClick={() => {
							if (!roleToAdd) return;
							const inherited = effectiveRole(snapshot, roleToAdd) ?? "";
							onChange({ ...draft, modelRoles: { ...draft.modelRoles, [roleToAdd]: inherited } });
							setRoleToAdd("");
						}}
					>
						{t("settings.preset.add")}
					</button>
				</div>
			) : null}

			{error ? (
				<p className="omp-message omp-message-error" role="alert">
					<StatusIcon kind="error" /> {error}
				</p>
			) : null}

			<div className="omp-row">
				<button type="button" className="omp-button omp-button-primary" onClick={onSave} disabled={busy}>
					{busy ? t("settings.saving") : t("settings.preset.save")}
				</button>
				<button type="button" className="omp-button" onClick={onCancel} disabled={busy}>
					{t("common.cancel")}
				</button>
			</div>
		</div>
	);
}

function AdvancedRow({
	option,
	expected,
	save,
}: {
	option: AdvancedOption;
	expected: { expectedValue?: unknown; expectedMissing?: true };
	save: (request: {
		scope: SettingScope;
		key: string;
		value: unknown;
		expectedValue?: unknown;
		expectedMissing?: true;
	}) => Promise<SaveResult>;
}) {
	const { t } = useI18n();
	const [draft, setDraft] = useState<string | boolean>(() =>
		option.type === "boolean" ? option.value === true : serializeSettingValue(option.value),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	// Valor que acabamos de gravar: o refresh do snapshot não pode apagar o
	// aviso de sucesso, mas uma mudança externa real ainda o limpa.
	const savedValueRef = useRef<string | null>(null);

	useEffect(() => {
		setDraft(option.type === "boolean" ? option.value === true : serializeSettingValue(option.value));
		setError(null);
		if (
			savedValueRef.current !== null &&
			serializeSettingValue(option.value) !== savedValueRef.current
		) {
			setSaved(false);
		}
	}, [option.type, option.value]);

	const errorTextFor = (key: MessageKey): string => {
		if (key === "settings.validation.enumAllowed") {
			return t(key, { values: (option.values ?? []).join(", ") });
		}
		if (key === "settings.validation.unknownType") {
			return t(key, { type: option.type });
		}
		return t(key);
	};

	const commit = async () => {
		const parsed = parseSettingInput(option.type, draft, option.values);
		if (!parsed.ok) {
			setError(errorTextFor(parsed.error));
			return;
		}
		setBusy(true);
		setError(null);
		setSaved(false);
		const result = await save({
			scope: "global",
			key: option.key,
			value: parsed.value,
			...expected,
		});
		setBusy(false);
		if (result.ok) {
			savedValueRef.current = serializeSettingValue(parsed.value);
			setSaved(true);
		} else setError(result.error ?? t("settings.saveFailed"));
	};

	const id = `omp-advanced-${option.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
	const enumValues = option.values ?? [];

	return (
		<div className="omp-advanced-row">
			<div className="omp-advanced-head">
				<label htmlFor={id}>{t(option.label)}</label>
				<span className="omp-scope-badge">global</span>
				<span className="omp-muted omp-advanced-key">{option.key}</span>
			</div>
			{option.description ? <p className="omp-muted">{option.description}</p> : null}
			{option.hasProjectOverride ? (
				<p className="omp-message omp-message-warning" role="status">
					<StatusIcon kind="warning" />{" "}
					{t("settings.advanced.projectOverride", {
						value: serializeSettingValue(option.projectOverride) || "—",
					})}
				</p>
			) : null}
			{option.type === "boolean" ? (
				<label className="omp-checkbox" htmlFor={id}>
					<input
						id={id}
						type="checkbox"
						checked={draft === true}
						onChange={event => setDraft(event.target.checked)}
						disabled={busy}
					/>
					<span>{draft === true ? t("settings.advanced.enabled") : t("settings.advanced.disabled")}</span>
				</label>
			) : option.type === "enum" && enumValues.length > 0 ? (
				<select
					id={id}
					value={String(draft)}
					onChange={event => setDraft(event.target.value)}
					disabled={busy}
				>
					{!String(draft) ? (
						<option value="">{t("settings.advanced.select")}</option>
					) : null}
					{!enumValues.includes(String(draft)) && String(draft) ? (
						<option value={String(draft)}>
							{t("settings.advanced.current", { value: String(draft) })}
						</option>
					) : null}
					{enumValues.map(value => (
						<option key={value} value={value}>
							{value}
						</option>
					))}
				</select>
			) : option.type === "record" || option.type === "array" ? (
				<textarea
					id={id}
					rows={4}
					value={String(draft)}
					onChange={event => setDraft(event.target.value)}
					disabled={busy}
					spellCheck={false}
				/>
			) : option.type === "number" ? (
				<input
					id={id}
					type="number"
					step="any"
					value={String(draft)}
					onChange={event => setDraft(event.target.value)}
					disabled={busy}
				/>
			) : option.type === "unknown" ? (
				<p className="omp-muted">{t("settings.advanced.notEditable")}</p>
			) : (
				<input
					id={id}
					value={String(draft)}
					onChange={event => setDraft(event.target.value)}
					disabled={busy}
				/>
			)}
			{option.type === "enum" && enumValues.length === 0 ? (
				<p className="omp-hint">{t("settings.advanced.enumUnknown")}</p>
			) : null}
			{error ? (
				<p className="omp-message omp-message-error" role="alert">
					<StatusIcon kind="error" /> {error}
				</p>
			) : null}
			{saved ? (
				<p className="omp-message omp-message-success" role="status">
					<StatusIcon kind="success" /> {t("settings.advanced.saved")}
				</p>
			) : null}
			<div className="omp-row">
				<button
					type="button"
					className="omp-button omp-button-small"
					onClick={() => void commit()}
					disabled={busy || option.type === "unknown"}
				>
					{busy ? t("settings.saving") : t("settings.advanced.save")}
				</button>
			</div>
		</div>
	);
}

export function SettingsScreen({ workspaceId, sessionId, state, initialTab }: SettingsScreenProps) {
	const { t, formatDate } = useI18n();
	const actions = useActions();
	const theme = useStore((value) => value.theme);
	const locale = useStore((value) => value.locale);
	const accent = useStore((value) => value.accent);
	const density = useStore((value) => value.density);
	const fontScale = useStore((value) => value.fontScale);
	const tabLayout = useStore((value) => value.tabLayout);
	const timelineWidth = useStore((value) => value.timelineWidth);
	const reduceMotion = useStore((value) => value.reduceMotion);
	const runtime = useStore((value) => value.runtime);
	const [tab, setTab] = useState<SettingsTab>(initialTab ?? "models");
	const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [conflict, setConflict] = useState<string | null>(null);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [levels, setLevels] = useState<string[]>([]);
	const [roleBusy, setRoleBusy] = useState<string | null>(null);
	const [roleError, setRoleError] = useState<string | null>(null);
	const [presetBusy, setPresetBusy] = useState<string | null>(null);
	const [presetMessage, setPresetMessage] = useState<{ level: "success" | "warning" | "error"; text: string } | null>(
		null,
	);
	const [draft, setDraft] = useState<PresetDraft | null>(null);
	const [draftBusy, setDraftBusy] = useState(false);
	const [draftError, setDraftError] = useState<string | null>(null);
	const [modelsTick, setModelsTick] = useState(0);
	const [accountsMounted, setAccountsMounted] = useState(initialTab === "accounts");
	const workspaceRef = useRef(workspaceId);

	useEffect(() => {
		if (initialTab) setTab(initialTab);
	}, [initialTab]);

	useEffect(() => {
		workspaceRef.current = workspaceId;
		setSnapshot(null);
		setLoading(true);
		setDraft(null);
		setActionError(null);
		setConflict(null);
		setRoleError(null);
		setPresetMessage(null);
		setDraftError(null);
		setModelsError(null);
	}, [workspaceId]);

	useEffect(() => {
		if (tab === "accounts") setAccountsMounted(true);
	}, [tab]);

	const refresh = useCallback(
		async (quiet = false) => {
			if (!quiet) setLoading(true);
			try {
				const raw = await invoke({ op: "settings.list", workspaceId });
				if (workspaceRef.current !== workspaceId) return;
				setSnapshot(normalizeSettings(raw));
				setLoadError(null);
			} catch (error) {
				if (workspaceRef.current !== workspaceId) return;
				setLoadError(errorText(error));
			} finally {
				if (!quiet && workspaceRef.current === workspaceId) setLoading(false);
			}
		},
		[workspaceId],
	);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!sessionId) {
			setModels([]);
			setLevels([]);
			// Sem sessão não há erro de catálogo válido: limpe ao trocar de contexto.
			setModelsError(null);
			return;
		}
		let cancelled = false;
		setModelsError(null);
		invoke({ op: "session.rpc", workspaceId, sessionId, command: { type: "get_available_models" } })
			.then(raw => {
				if (!cancelled) setModels(normalizeAvailableModels(unwrapRpcData(raw)));
			})
			.catch(error => {
				if (!cancelled) setModelsError(errorText(error));
			});
		invoke({
			op: "session.rpc",
			workspaceId,
			sessionId,
			command: { type: "get_available_thinking_levels" },
		})
			.then(raw => {
				if (!cancelled) setLevels(normalizeThinkingLevels(unwrapRpcData(raw)));
			})
			.catch(() => {
				if (!cancelled) setLevels([]);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId, workspaceId, modelsTick]);

	const saveSetting = useCallback(
		async (request: {
			scope: SettingScope;
			key: string;
			value: unknown;
			expectedValue?: unknown;
			expectedMissing?: true;
		}): Promise<SaveResult> => {
			try {
				await invoke({ op: "settings.save", workspaceId, ...request });
				await refresh(true);
				return { ok: true };
			} catch (error) {
				const message = errorText(error);
				if (isConfigConflict(error)) {
					setConflict(t("settings.conflict"));
					await refresh(true);
				} else {
					setActionError(message);
				}
				return { ok: false, error: message };
			}
		},
		[refresh, workspaceId],
	);

	const globalRoles = snapshot ? globalModelRoles(snapshot) : {};
	const activeModel = state?.meta?.model;
	const optionList = snapshot ? advancedOptions(snapshot) : [];
	const presetEntries = snapshot ? Object.values(snapshot.presets).sort((a, b) => a.name.localeCompare(b.name)) : [];

	const changeRole = async (scope: SettingScope, role: string, selector: string) => {
		if (!snapshot) return;
		const map = scope === "project" ? snapshot.projectModelRoles : globalRoles;
		const next = withRole(map, role, selector || null);
		setRoleBusy(`${scope}:${role}`);
		setRoleError(null);
		const result = await saveSetting({
			scope,
			key: "modelRoles",
			value: next,
			...expectedLayerValue(snapshot, scope, "modelRoles"),
		});
		setRoleBusy(null);
		if (!result.ok) setRoleError(result.error ?? t("settings.roles.saveError"));
	};

	const applyPreset = async (preset: PresetView) => {
		if (!sessionId) return;
		setPresetBusy(preset.name);
		setPresetMessage(null);
		try {
			const raw = await invoke({
				op: "settings.applyPreset",
				workspaceId,
				sessionId,
				name: preset.name,
			});
			const data = unwrapRpcData(raw);
			const appliedName =
				typeof data === "object" && data !== null && "preset" in data && typeof data.preset === "string"
					? data.preset
					: preset.name;
			setPresetMessage({
				level: "success",
				text: t("settings.presets.applied", { name: appliedName }),
			});
			await refresh(true);
		} catch (error) {
			if (errorCode(error) === "UNSUPPORTED") {
				setPresetMessage({
					level: "warning",
					text: t("settings.presets.unsupported"),
				});
			} else {
				setPresetMessage({
					level: "error",
					text: t("settings.presets.applyError", { message: errorText(error) }),
				});
			}
		} finally {
			setPresetBusy(null);
		}
	};

	const openNewPreset = () => {
		if (!snapshot) return;
		const effectiveRoles: Record<string, string> = {};
		for (const role of roleNames(snapshot)) {
			const value = effectiveRole(snapshot, role);
			if (value) effectiveRoles[role] = value;
		}
		setDraft({
			name: uniquePresetName(snapshot, t("settings.presets.defaultName")),
			modelRoles: effectiveRoles,
			defaultThinkingLevel: undefined,
		});
		setDraftError(null);
	};

	const openEditPreset = (preset: PresetView) => {
		setDraft({
			originalName: preset.name,
			name: preset.name,
			modelRoles: { ...preset.modelRoles },
			defaultThinkingLevel: preset.defaultThinkingLevel,
		});
		setDraftError(null);
	};

	const saveDraft = async () => {
		if (!snapshot || !draft) return;
		const preset: PresetView = {
			name: draft.name.trim(),
			modelRoles: Object.fromEntries(
				Object.entries(draft.modelRoles).filter(([, selector]) => selector.trim().length > 0),
			),
			defaultThinkingLevel: draft.defaultThinkingLevel,
		};
		const valid = validatesPreset(preset);
		if (!valid.ok) {
			setDraftError(t(valid.error));
			return;
		}
		const invalidRole = Object.entries(preset.modelRoles).find(
			([, selector]) => splitModelSelector(selector) === null,
		);
		if (invalidRole) {
			setDraftError(
				t("settings.presets.invalidRole", {
					role: invalidRole[0],
					value: invalidRole[1],
				}),
			);
			return;
		}
		if (preset.name !== draft.originalName && Object.hasOwn(snapshot.presetsRaw, preset.name)) {
			setDraftError(t("settings.presets.duplicate"));
			return;
		}
		setDraftBusy(true);
		setDraftError(null);
		const result = await saveSetting({
			scope: "global",
			key: "modelPresets",
			value: presetMapForSave(snapshot, preset, draft.originalName),
			...expectedLayerValue(snapshot, "global", "modelPresets"),
		});
		setDraftBusy(false);
		if (result.ok) {
			setDraft(null);
			setPresetMessage({ level: "success", text: t("settings.presets.saved", { name: preset.name }) });
		} else {
			setDraftError(result.error ?? t("settings.presets.saveError"));
		}
	};

	const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "ArrowLeft" &&
			event.key !== "ArrowRight" &&
			event.key !== "ArrowUp" &&
			event.key !== "ArrowDown"
		) {
			return;
		}
		event.preventDefault();
		const order: SettingsTab[] = [
			"models",
			"accounts",
			"general",
			"approvals",
			"shortcuts",
			"about",
		];
		const index = order.indexOf(tab);
		const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
		const next = order[(index + step + order.length) % order.length];
		setTab(next);
		document.getElementById(`omp-settings-tab-${next}`)?.focus();
	};

	if (!snapshot) {
		return (
			<section className="omp-settings" aria-label={t("settings.title")}>
				<header className="omp-settings-head">
					<h1>{t("settings.title")}</h1>
				</header>
				{loading ? (
					<p className="omp-muted" role="status">
						{t("common.loading")}
					</p>
				) : (
					<div className="omp-settings-empty" role="alert">
						<StatusIcon kind="error" size={20} />
						<h2>{t("settings.loadErrorTitle")}</h2>
						<p>{loadError ?? t("error.unexpected")}</p>
						<button type="button" className="omp-button" onClick={() => void refresh()}>
							{t("common.retry")}
						</button>
					</div>
				)}
			</section>
		);
	}

	return (
		<section className="omp-settings" aria-label={t("settings.title")}>
			<header className="omp-settings-head">
				<div>
					<h1>{t("settings.title")}</h1>
					<p className="omp-muted">
						{t("settings.lead")}
						{snapshot.updatedAt
							? ` ${t("settings.updatedAt", {
									date: formatDate(snapshot.updatedAt) ?? t("common.unavailable"),
								})}`
							: ""}
					</p>
				</div>
				<div className="omp-row">
					<button
						type="button"
						className="omp-button omp-button-small"
						onClick={() => void refresh()}
						disabled={loading}
					>
						{loading ? t("settings.refreshing") : t("common.reload")}
					</button>
				</div>
			</header>

			<div className="omp-settings-layout">
			<div
				className="omp-settings-tabs omp-settings-nav"
				role="tablist"
				aria-label={t("settings.tabsLabel")}
				aria-orientation="vertical"
				onKeyDown={onTabKeyDown}
			>
				{(["models", "accounts", "general", "approvals", "shortcuts", "about"] as const).map(value => (
					<button
						key={value}
						id={`omp-settings-tab-${value}`}
						type="button"
						role="tab"
						aria-selected={tab === value}
						aria-controls={`omp-settings-panel-${value}`}
						tabIndex={tab === value ? 0 : -1}
						onClick={() => setTab(value)}
						className={tab === value ? "is-active" : undefined}
					>
						{t(TAB_LABELS[value])}
					</button>
				))}
			</div>

			<div className="omp-settings-panels">
			{conflict ? (
				<div className="omp-message omp-message-warning" role="alert">
					<StatusIcon kind="warning" />
					<span>{conflict}</span>
					<button type="button" className="omp-button omp-button-small" onClick={() => setConflict(null)}>
						{t("settings.understood")}
					</button>
				</div>
			) : null}
			{actionError ? (
				<div className="omp-message omp-message-error" role="alert">
					<StatusIcon kind="error" />
					<span>{actionError}</span>
					<button
						type="button"
						className="omp-icon-button"
						onClick={() => setActionError(null)}
						aria-label={t("settings.closeError")}
					>
						×
					</button>
				</div>
			) : null}
			{loadError ? (
				<div className="omp-message omp-message-error" role="alert">
					<StatusIcon kind="error" /> {t("settings.lastReadError", { message: loadError })}
				</div>
			) : null}

			<div
				id="omp-settings-panel-models"
				role="tabpanel"
				aria-labelledby="omp-settings-tab-models"
				className="omp-settings-panel"
				hidden={tab !== "models"}
			>
					<section className="omp-settings-section" aria-labelledby="omp-active-model-title">
						<div className="omp-section-head">
							<h2 id="omp-active-model-title">{t("settings.activeModel.title")}</h2>
							<span className="omp-scope-badge">runtime</span>
						</div>
						<div className="omp-active-model">
							<div>
								<p className="omp-active-model-name">
									{activeModel
										? activeModel.name || `${activeModel.provider}/${activeModel.id}`
										: t("settings.activeModel.unknown")}
								</p>
								<p className="omp-muted">
									{activeModel
										? `${activeModel.provider}/${activeModel.id}`
										: t("settings.activeModel.unknownDetail")}
								</p>
							</div>
							<button
								type="button"
								className="omp-button omp-button-primary"
								onClick={() => setPickerOpen(true)}
								disabled={!sessionId}
							>
								{t("settings.activeModel.choose")}
							</button>
						</div>
						{sessionId ? (
							<ThinkingLevelControl workspaceId={workspaceId} sessionId={sessionId} state={state} />
						) : (
							<p className="omp-muted">{t("settings.activeModel.sessionRequired")}</p>
						)}
						<p className="omp-hint">{t("settings.activeModel.hint")}</p>
					</section>

					<section className="omp-settings-section" aria-labelledby="omp-roles-title">
						<div className="omp-section-head">
							<h2 id="omp-roles-title">{t("settings.roles.title")}</h2>
							<p className="omp-muted">{t("settings.roles.lead")}</p>
						</div>
						{modelsError ? (
							<p className="omp-message omp-message-warning" role="status">
								<StatusIcon kind="warning" /> {t("settings.roles.modelsError", { message: modelsError })}
							</p>
						) : null}
						{roleError ? (
							<p className="omp-message omp-message-error" role="alert">
								<StatusIcon kind="error" /> {roleError}
							</p>
						) : null}
						{roleNames(snapshot).length === 0 ? (
							<div className="omp-settings-empty">
								<StatusIcon kind="empty" size={20} />
								<p>{t("settings.roles.empty")}</p>
								<p className="omp-muted">{t("settings.roles.emptyHint")}</p>
							</div>
						) : (
							<ul className="omp-role-list">
								{roleNames(snapshot).map(role => {
									const globalValue = globalRoles[role] ?? "";
									const projectValue = snapshot.projectModelRoles[role] ?? "";
									const effective = effectiveRole(snapshot, role);
									return (
										<li key={role} className="omp-role-card">
											<div className="omp-role-head">
												<span className="omp-role-name">{role}</span>
												<span className="omp-muted">
													{t("settings.roles.effective", {
														value: effective ?? t("settings.roles.undefined"),
													})}
												</span>
											</div>
											<div className="omp-role-controls">
												<label>
													<span>{t("settings.roles.global")}</span>
													<select
														value={globalValue}
														onChange={event => void changeRole("global", role, event.target.value)}
														disabled={!sessionId || models.length === 0 || roleBusy !== null}
														aria-label={t("settings.roles.globalAria", { role })}
													>
														<option value="">{t("settings.roles.removeRole")}</option>
														{globalValue && !models.some(model => modelSelector(model) === globalValue) ? (
															<option value={globalValue}>
																{t("settings.roles.configured", { selector: globalValue })}
															</option>
														) : null}
														{models.map(model => (
															<option key={modelSelector(model)} value={modelSelector(model)}>
																{model.name} ({model.provider})
															</option>
														))}
													</select>
												</label>
												<label>
													<span>{t("settings.roles.project")}</span>
													<select
														value={projectValue}
														onChange={event => void changeRole("project", role, event.target.value)}
														disabled={!sessionId || models.length === 0 || roleBusy !== null}
														aria-label={t("settings.roles.projectAria", { role })}
													>
														<option value="">{t("settings.roles.inheritGlobal")}</option>
														{projectValue && !models.some(model => modelSelector(model) === projectValue) ? (
															<option value={projectValue}>
																{t("settings.roles.configured", { selector: projectValue })}
															</option>
														) : null}
														{models.map(model => (
															<option key={modelSelector(model)} value={modelSelector(model)}>
																{model.name} ({model.provider})
															</option>
														))}
													</select>
												</label>
												<span className="omp-scope-badge">
													{roleBusy === `global:${role}` || roleBusy === `project:${role}`
														? t("settings.roles.saving")
														: projectValue
															? t("settings.roles.projectBadge")
															: t("settings.roles.globalBadge")}
												</span>
											</div>
										</li>
									);
								})}
							</ul>
						)}
						<div className="omp-row">
							<button
								type="button"
								className="omp-button omp-button-small"
								onClick={() => {
									setModelsTick(value => value + 1);
								}}
								disabled={!sessionId}
							>
								{t("settings.roles.reloadModels")}
							</button>
							{!sessionId ? <span className="omp-muted">{t("settings.roles.sessionRequired")}</span> : null}
						</div>
					</section>

					<section className="omp-settings-section" aria-labelledby="omp-presets-title">
						<div className="omp-section-head">
							<h2 id="omp-presets-title">{t("settings.presets.title")}</h2>
							<p className="omp-muted">{t("settings.presets.lead")}</p>
						</div>
						{presetMessage ? (
							<p
								className={`omp-message omp-message-${presetMessage.level}`}
								role={presetMessage.level === "error" ? "alert" : "status"}
							>
								<StatusIcon
									kind={
										presetMessage.level === "success"
											? "success"
											: presetMessage.level === "warning"
												? "warning"
												: "error"
									}
								/>{" "}
								{presetMessage.text}
							</p>
						) : null}
						{presetEntries.length === 0 ? (
							<div className="omp-settings-empty">
								<StatusIcon kind="empty" size={20} />
								<p>{t("settings.presets.empty")}</p>
							</div>
						) : (
							<ul className="omp-preset-list">
								{presetEntries.map(preset => (
									<li key={preset.name} className="omp-preset-card">
										<div>
											<p className="omp-preset-name">{preset.name}</p>
											<p className="omp-muted">
												{Object.keys(preset.modelRoles).length === 1
													? t("settings.presets.roleCountOne")
													: t("settings.presets.roleCount", {
															count: Object.keys(preset.modelRoles).length,
														})}
												{preset.defaultThinkingLevel
													? t("settings.presets.thinking", {
															level: preset.defaultThinkingLevel,
														})
													: ""}
											</p>
										</div>
										<div className="omp-row">
											<button
												type="button"
												className="omp-button omp-button-small"
												onClick={() => void applyPreset(preset)}
												disabled={!sessionId || presetBusy !== null}
												title={!sessionId ? t("settings.presets.sessionRequiredTitle") : undefined}
											>
												{presetBusy === preset.name ? t("settings.presets.applying") : t("settings.presets.apply")}
											</button>
											<button
												type="button"
												className="omp-button omp-button-small"
												onClick={() => openEditPreset(preset)}
												disabled={presetBusy !== null}
											>
												{t("settings.presets.edit")}
											</button>
										</div>
									</li>
								))}
							</ul>
						)}
						<div className="omp-row">
							<button
								type="button"
								className="omp-button omp-button-small"
								onClick={openNewPreset}
								disabled={draft !== null}
							>
								{t("settings.presets.create")}
							</button>
							{!sessionId ? (
								<span className="omp-muted">{t("settings.presets.sessionRequired")}</span>
							) : null}
						</div>
						{draft ? (
							<PresetEditor
								snapshot={snapshot}
								draft={draft}
								models={models}
								levels={levels}
								busy={draftBusy}
								error={draftError}
								onChange={setDraft}
								onCancel={() => {
									setDraft(null);
									setDraftError(null);
								}}
								onSave={() => void saveDraft()}
							/>
						) : null}
					</section>
			</div>

			<div
				id="omp-settings-panel-accounts"
				role="tabpanel"
				aria-labelledby="omp-settings-tab-accounts"
				className="omp-settings-panel"
				hidden={tab !== "accounts"}
			>
				{accountsMounted ? (
					<AccountsTab
						key={`${workspaceId}:${sessionId ?? "no-session"}`}
						workspaceId={workspaceId}
						sessionId={sessionId}
					/>
				) : null}
			</div>

			<div
				id="omp-settings-panel-general"
				role="tabpanel"
				aria-labelledby="omp-settings-tab-general"
				className="omp-settings-panel"
				hidden={tab !== "general"}
			>
					<section className="omp-settings-section" aria-labelledby="omp-appearance-title">
						<div className="omp-section-head">
							<h2 id="omp-appearance-title">{t("settings.general.appearanceTitle")}</h2>
							<p className="omp-muted">{t("settings.general.appearanceLead")}</p>
						</div>
						<div className="omp-appearance-grid">
							<label className="omp-field">
								<span>{t("settings.general.theme")}</span>
								<select
									data-testid="settings-theme"
									aria-label={t("settings.general.theme")}
									value={theme}
									onChange={(event) => {
										const next = event.target.value;
										if (isThemeMode(next)) actions.setTheme(next);
									}}
								>
									<option value="system">{t("settings.general.themeSystem")}</option>
									<option value="dark">{t("settings.general.themeDark")}</option>
									<option value="light">{t("settings.general.themeLight")}</option>
									<option value="aurora">{t("settings.general.themeAurora")}</option>
									<option value="phosphor">{t("settings.general.themePhosphor")}</option>
									<option value="daylight">{t("settings.general.themeDaylight")}</option>
								</select>
							</label>
							<label className="omp-field">
								<span>{t("settings.general.accent")}</span>
								<div className="omp-row">
									<input
										type="color"
										className="omp-color-input"
										value={accent ?? "#8af0c8"}
										aria-label={t("settings.general.accent")}
										onChange={(event) => actions.setAccent(event.target.value)}
									/>
									<button
										type="button"
										className="omp-button omp-button-small"
										disabled={!accent}
										onClick={() => actions.setAccent(null)}
									>
										{t("settings.general.accentReset")}
									</button>
								</div>
								<span className="omp-hint">{t("settings.general.accentHint")}</span>
							</label>
							<label className="omp-field">
								<span>{t("settings.general.density")}</span>
								<select
									value={density}
									aria-label={t("settings.general.density")}
									onChange={(event) =>
										actions.setDensity(
											event.target.value === "compact" ? "compact" : "comfortable",
										)
									}
								>
									<option value="comfortable">
										{t("settings.general.densityComfortable")}
									</option>
									<option value="compact">{t("settings.general.densityCompact")}</option>
								</select>
							</label>
							<label className="omp-field">
								<span>{t("settings.general.fontScale")}</span>
								<select
									value={String(fontScale)}
									aria-label={t("settings.general.fontScale")}
									onChange={(event) => actions.setFontScale(Number(event.target.value))}
								>
									{FONT_SCALES.map((value) => (
										<option key={value} value={value}>
											{Math.round(value * 100)}%
										</option>
									))}
								</select>
							</label>
							<label className="omp-field">
								<span>{t("settings.general.tabLayout")}</span>
								<select
									value={tabLayout}
									aria-label={t("settings.general.tabLayout")}
									onChange={(event) =>
										actions.setTabLayout(
											event.target.value === "vertical" ? "vertical" : "horizontal",
										)
									}
								>
									<option value="horizontal">
										{t("settings.general.tabLayoutHorizontal")}
									</option>
									<option value="vertical">
										{t("settings.general.tabLayoutVertical")}
									</option>
								</select>
							</label>
							<label className="omp-field">
								<span>{t("settings.general.timelineWidth")}</span>
								<select
									value={timelineWidth}
									aria-label={t("settings.general.timelineWidth")}
									onChange={(event) => {
										const value = event.target.value;
										if (
											value === "focused" ||
											value === "comfortable" ||
											value === "wide"
										) {
											actions.setTimelineWidth(value);
										}
									}}
								>
									<option value="focused">
										{t("settings.general.timelineFocused")}
									</option>
									<option value="comfortable">
										{t("settings.general.timelineComfortable")}
									</option>
									<option value="wide">{t("settings.general.timelineWide")}</option>
								</select>
							</label>
							<label className="omp-field">
								<span>{t("settings.general.reduceMotion")}</span>
								<select
									value={reduceMotion}
									aria-label={t("settings.general.reduceMotion")}
									onChange={(event) => {
										const value = event.target.value;
										if (value === "system" || value === "on" || value === "off") {
											actions.setReduceMotion(value);
										}
									}}
								>
									<option value="system">
										{t("settings.general.reduceMotionSystem")}
									</option>
									<option value="on">{t("settings.general.reduceMotionOn")}</option>
									<option value="off">{t("settings.general.reduceMotionOff")}</option>
								</select>
							</label>
							<label className="omp-field">
								<span>{t("settings.general.language")}</span>
								<select
									data-testid="settings-language"
									aria-label={t("settings.general.language")}
									value={locale}
									onChange={(event) => {
										const next = event.target.value;
										if (isLocale(next)) actions.setLocale(next);
									}}
								>
									{LOCALES.map((code) => (
										<option key={code} value={code}>
											{LOCALE_LABELS[code]}
										</option>
									))}
								</select>
								<span className="omp-hint">{t("settings.general.languageHint")}</span>
							</label>
						</div>
						<div className="omp-row">
							<button
								type="button"
								className="omp-button omp-button-small"
								onClick={() => {
									actions.closeSettings();
									window.dispatchEvent(new CustomEvent("omp:onboarding"));
								}}
							>
								{t("settings.general.reopenOnboarding")}
							</button>
							<span className="omp-muted">{t("settings.general.reopenOnboardingHint")}</span>
						</div>
					</section>

					<div className="omp-settings-section">
						<OptionalToolsSection
							runtime={runtime}
							onDependencies={(snapshot) => actions.applyDependencies(snapshot)}
						/>
					</div>

					<section className="omp-settings-section" aria-labelledby="omp-origins-title">
						<div className="omp-section-head">
							<h2 id="omp-origins-title">{t("settings.general.originsTitle")}</h2>
						</div>
						<dl className="omp-origin-list">
							<div>
								<dt>
									<span className="omp-scope-badge">runtime</span>
								</dt>
								<dd>{t("settings.general.originRuntime")}</dd>
							</div>
							<div>
								<dt>
									<span className="omp-scope-badge">global</span>
								</dt>
								<dd>{t("settings.general.originGlobal")}</dd>
							</div>
							<div>
								<dt>
									{/* Nome técnico do escopo do OMP, igual em qualquer idioma. */}
									<span className="omp-scope-badge">project</span>
								</dt>
								<dd>{t("settings.general.originProject")}</dd>
							</div>
						</dl>
						{snapshot.updatedAt ? (
							<p className="omp-muted">
								{t("settings.general.lastRead", {
									date: formatDate(snapshot.updatedAt) ?? t("common.unavailable"),
								})}
							</p>
						) : null}
					</section>

					<section className="omp-settings-section" aria-labelledby="omp-advanced-title">
						<div className="omp-section-head">
							<h2 id="omp-advanced-title">{t("settings.general.advancedTitle")}</h2>
							<p className="omp-muted">{t("settings.general.advancedLead")}</p>
						</div>
						{optionList.length === 0 ? (
							<div className="omp-settings-empty">
								<StatusIcon kind="empty" size={20} />
								<p>{t("settings.general.advancedEmpty")}</p>
							</div>
						) : (
							<div className="omp-advanced-list">
								{optionList.map(option => (
									<AdvancedRow
										key={`${option.key}:${settingValue(snapshot, option.key) === undefined ? "unset" : "set"}`}
										option={option}
										expected={expectedLayerValue(snapshot, "global", option.key)}
										save={saveSetting}
									/>
								))}
							</div>
						)}
					</section>

					<section className="omp-settings-section" aria-labelledby="omp-model-list-title">
						<div className="omp-section-head">
							<h2 id="omp-model-list-title">{t("settings.general.modelsTitle")}</h2>
							<p className="omp-muted">{t("settings.general.modelsLead")}</p>
						</div>
						{models.length === 0 ? (
							<p className="omp-muted">{modelsError ?? t("settings.general.modelsEmpty")}</p>
						) : (
							groupModels(models).map(group => (
								<div key={group.provider} className="omp-model-summary-group">
									<h3>{group.provider}</h3>
									<p className="omp-muted">
										{group.models.map(model => model.name).join(", ")}
									</p>
								</div>
							))
						)}
					</section>
			</div>

			<div
				id="omp-settings-panel-approvals"
				role="tabpanel"
				aria-labelledby="omp-settings-tab-approvals"
				className="omp-settings-panel"
				hidden={tab !== "approvals"}
			>
				<ApprovalsTab />
			</div>

			<div
				id="omp-settings-panel-shortcuts"
				role="tabpanel"
				aria-labelledby="omp-settings-tab-shortcuts"
				className="omp-settings-panel"
				hidden={tab !== "shortcuts"}
			>
				<ShortcutsTab />
			</div>

			<div
				id="omp-settings-panel-about"
				role="tabpanel"
				aria-labelledby="omp-settings-tab-about"
				className="omp-settings-panel"
				hidden={tab !== "about"}
			>
				<AboutTab />
			</div>
			</div>
			</div>

			{pickerOpen && sessionId ? (
				<ModelPicker
					workspaceId={workspaceId}
					sessionId={sessionId}
					state={state}
					onClose={() => setPickerOpen(false)}
				/>
			) : null}
		</section>
	);
}

export default SettingsScreen;
