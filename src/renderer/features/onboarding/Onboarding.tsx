import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import type { ModelCatalogEntry, RuntimeStatus } from "@shared/contracts";
import { invoke } from "../../api";
import { Icon } from "../../components/Icon";
import { useI18n, type MessageKey } from "../../i18n";
import { BrandMark } from "../../layout/TitleBar";
import { useActions, useStore } from "../../store/context";
import { activeWorkspace, type ThemeMode } from "../../store/state";
import { StatusIcon } from "../agents/StatusIcon";
import { errorText, isRecord } from "../agents/ui-utils";
import { DiagnosticsScreen } from "../diagnostics/DiagnosticsScreen";
import { OptionalToolsSection } from "../diagnostics/OptionalToolsSection";
import {
	isConfigConflict,
	normalizeSettings,
	normalizeUsage,
	type SettingsSnapshot,
	type UsageView,
} from "../settings/config";
import {
	filterModelCatalog,
	groupModelCatalog,
	selectorMatchesRole,
	withDefaultRole,
} from "./onboarding-model";
import { effectiveOnboardingRuntime, ompStatusKey } from "./onboarding-runtime";
import "./onboarding.css";

const DONE_KEY = "omp-desktop.onboarding.done";

/** A primeira execução aparece uma vez, e só quando ainda não há projeto recente. */
export function onboardingDone(): boolean {
	try {
		return window.localStorage.getItem(DONE_KEY) === "1";
	} catch {
		// Sem localStorage não há como provar que a introdução já foi vista;
		// mostrar de novo é melhor que esconder o assistente para sempre.
		return false;
	}
}

function markDone(): void {
	try {
		window.localStorage.setItem(DONE_KEY, "1");
	} catch {
		// Sem armazenamento local, a tela simplesmente pode aparecer de novo.
	}
}

const STEPS = [
	{ id: "welcome", label: "onb.step.welcome" },
	{ id: "environment", label: "onb.step.environment" },
	{ id: "accounts", label: "onb.step.accounts" },
	{ id: "model", label: "onb.step.model" },
	{ id: "finish", label: "onb.step.finish" },
] as const satisfies ReadonlyArray<{ id: string; label: MessageKey }>;

function stringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string" && entry.length > 0) out[key] = entry;
	}
	return out;
}

function CheckRow({
	icon,
	label,
	value,
	ok,
	action,
}: {
	icon: "cpu" | "command" | "git" | "terminal" | "agent";
	label: string;
	value?: string;
	ok: boolean;
	action?: ReactNode;
}) {
	const { t } = useI18n();
	return (
		<li>
			<span className={ok ? "onb-ok" : "onb-missing"}>
				<Icon name={ok ? "check" : "warning"} className="icon--sm" />
			</span>
			<Icon name={icon} className="onb-check__icon" />
			<div className="onb-check__text">
				<b>{label}</b>
				<span className="mono truncate" title={value ?? t("onb.env.notDetected")}>
					{value ?? t("onb.env.notDetected")}
				</span>
			</div>
			<span className={ok ? "onb-ok" : "onb-missing"}>{ok ? t("onb.env.ready") : t("onb.env.missing")}</span>
			{action}
		</li>
	);
}

export function Onboarding({ onFinish }: { onFinish: () => void }) {
	const actions = useActions();
	const runtime = useStore((state) => state.runtime);
	const theme = useStore((state) => state.theme);
	const workspace = useStore((state) => activeWorkspace(state));
	const { t, formatDate, formatNumber, formatPercent } = useI18n();
	const [step, setStep] = useState(0);
	const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
	const headingRef = useRef<HTMLHeadingElement>(null);

	const [usage, setUsage] = useState<UsageView | null>(null);
	const [usageLoading, setUsageLoading] = useState(false);
	const [usageError, setUsageError] = useState<string | null>(null);
	// Uma tentativa automática por etapa: erro/vazio só volta por clique.
	const [usageAttempted, setUsageAttempted] = useState(false);

	const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
	const [catalogLoading, setCatalogLoading] = useState(false);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [catalogLoaded, setCatalogLoaded] = useState(false);
	// Status devolvido pelo diagnóstico embutido (selecionar OMP/verificar de novo).
	const [runtimeOverride, setRuntimeOverride] = useState<RuntimeStatus | null>(null);
	// O diagnóstico embutido atualiza este override; o checklist não pode ficar
	// preso ao status antigo do store depois de escolher outro omp.exe.
	// Dependências vêm sempre do store (fonte única), então o progresso de
	// Git/Node não regride o OMP capturado no clique.
	const effectiveRuntime = effectiveOnboardingRuntime(runtimeOverride, runtime);
	const linux = effectiveRuntime?.platform === "linux";
	const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
	const [settingsError, setSettingsError] = useState<string | null>(null);
	const [settingsAttempted, setSettingsAttempted] = useState(false);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveMessage, setSaveMessage] = useState<{ level: "success" | "warning" | "error"; text: string } | null>(
		null,
	);

	const finish = () => {
		markDone();
		onFinish();
	};

	useEffect(() => {
		headingRef.current?.focus();
	}, [step]);

	// Só um status OMP novo invalida o override local do diagnóstico. Eventos
	// de progresso de Git/Node mudam `runtime.dependencies`, mas não podem
	// apagar a seleção de omp.exe feita no diagnóstico embutido.
	const runtimeOmpKey = ompStatusKey(runtime);
	useEffect(() => {
		setRuntimeOverride(null);
	}, [runtimeOmpKey]);

	const loadUsage = useCallback(async () => {
		setUsageLoading(true);
		setUsageError(null);
		try {
			const raw = await invoke({ op: "account.usage" });
			setUsage(normalizeUsage(raw));
		} catch (error) {
			setUsageError(errorText(error));
		} finally {
			setUsageLoading(false);
		}
	}, []);

	const loadSettings = useCallback(async () => {
		setSettingsError(null);
		try {
			const raw = await invoke({ op: "settings.list" });
			setSettings(normalizeSettings(raw));
		} catch (error) {
			setSettingsError(errorText(error));
		}
	}, []);

	const loadModels = useCallback(async () => {
		setCatalogLoading(true);
		setCatalogError(null);
		try {
			const raw = await invoke<{ models?: unknown }>({ op: "settings.listModels" });
			const list = Array.isArray(raw?.models) ? raw.models : [];
			const models: ModelCatalogEntry[] = [];
			for (const entry of list) {
				if (!isRecord(entry)) continue;
				if (typeof entry.provider !== "string" || typeof entry.id !== "string") continue;
				models.push({
					provider: entry.provider,
					id: entry.id,
					name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
					selector:
						typeof entry.selector === "string" && entry.selector
							? entry.selector
							: `${entry.provider}/${entry.id}`,
					contextWindow: typeof entry.contextWindow === "number" ? entry.contextWindow : undefined,
					maxTokens: typeof entry.maxTokens === "number" ? entry.maxTokens : undefined,
					reasoning: entry.reasoning === true,
					thinking: Array.isArray(entry.thinking)
						? entry.thinking.filter((level): level is string => typeof level === "string")
						: undefined,
					input: Array.isArray(entry.input)
						? entry.input.filter((kind): kind is string => typeof kind === "string")
						: undefined,
					cost: isRecord(entry.cost)
						? {
								input: typeof entry.cost.input === "number" ? entry.cost.input : undefined,
								output: typeof entry.cost.output === "number" ? entry.cost.output : undefined,
								cacheRead: typeof entry.cost.cacheRead === "number" ? entry.cost.cacheRead : undefined,
								cacheWrite: typeof entry.cost.cacheWrite === "number" ? entry.cost.cacheWrite : undefined,
							}
						: undefined,
				});
			}
			setCatalog(models);
		} catch (error) {
			setCatalogError(errorText(error));
		} finally {
			setCatalogLoading(false);
		}
	}, []);

	useEffect(() => {
		if (step !== 2 || usageAttempted) return;
		setUsageAttempted(true);
		void loadUsage();
	}, [loadUsage, step, usageAttempted]);

	useEffect(() => {
		if (step !== 3) return;
		// Catálogo vazio é resposta válida; só uma tentativa automática.
		if (!catalogLoaded && !catalogLoading) {
			setCatalogLoaded(true);
			void loadModels();
		}
		if (!settingsAttempted && settings === null) {
			setSettingsAttempted(true);
			void loadSettings();
		}
	}, [
		catalogLoaded,
		catalogLoading,
		loadModels,
		loadSettings,
		settings,
		settingsAttempted,
		step,
	]);

	const globalRolesRaw = settings?.global.modelRoles;
	const globalRolesPresent = settings ? Object.hasOwn(settings.global, "modelRoles") : false;
	const currentRoles = useMemo(() => stringRecord(globalRolesRaw), [globalRolesRaw]);
	// Camada global ausente não é o mesmo que mapa vazio: o host compara o valor
	// exato para detectar CONFIG_CONFLICT e exige `expectedMissing` nesse caso.
	const expectedRoles = globalRolesPresent ? globalRolesRaw : undefined;
	const currentDefault = typeof currentRoles.default === "string" ? currentRoles.default : undefined;
	const filtered = useMemo(() => filterModelCatalog(catalog, query), [catalog, query]);
	const groups = useMemo(() => groupModelCatalog(filtered), [filtered]);

	const saveDefault = async () => {
		if (!selected) return;
		setSaving(true);
		setSaveMessage(null);
		try {
			await invoke({
				op: "settings.save",
				scope: "global",
				key: "modelRoles",
				value: withDefaultRole(currentRoles, selected),
				...(globalRolesPresent ? { expectedValue: expectedRoles } : { expectedMissing: true }),
			});
			setSaveMessage({ level: "success", text: t("onb.model.saved", { selector: selected }) });
			await loadSettings();
		} catch (error) {
			if (isConfigConflict(error)) {
				setSaveMessage({ level: "warning", text: t("onb.model.conflict") });
				await loadSettings();
			} else {
				setSaveMessage({
					level: "error",
					text: t("onb.model.saveError", { message: errorText(error) }),
				});
			}
		} finally {
			setSaving(false);
		}
	};

	const themes: Array<{ value: ThemeMode; label: MessageKey }> = [
		{ value: "dark", label: "onb.finish.themeDark" },
		{ value: "light", label: "onb.finish.themeLight" },
		{ value: "system", label: "onb.finish.themeSystem" },
	];
	const themeRefs = useRef<Partial<Record<ThemeMode, HTMLButtonElement | null>>>({});
	const onThemeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.key !== "ArrowLeft" &&
			event.key !== "ArrowRight" &&
			event.key !== "ArrowUp" &&
			event.key !== "ArrowDown"
		) {
			return;
		}
		event.preventDefault();
		const order = themes.map((option) => option.value);
		const index = Math.max(0, order.indexOf(theme));
		const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
		const next = order[(index + delta + order.length) % order.length];
		if (!next) return;
		actions.setTheme(next);
		themeRefs.current[next]?.focus();
	};

	const canOpenSettings = Boolean(workspace?.available);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape") return;
		const target = event.target;
		if (target instanceof HTMLInputElement && target.type === "search") {
			event.preventDefault();
			setQuery("");
			return;
		}
		// Escarpar não fecha a introdução nem descarta o que já foi preenchido.
		event.preventDefault();
	};

	const modelCost = (model: ModelCatalogEntry): string | undefined => {
		const input = model.cost?.input;
		const output = model.cost?.output;
		if (input === undefined && output === undefined) return undefined;
		const parts: string[] = [];
		if (input !== undefined) {
			parts.push(
				t("onb.model.costInput", {
					value: formatNumber(input, { style: "currency", currency: "USD", maximumFractionDigits: 2 }) ?? String(input),
				}),
			);
		}
		if (output !== undefined) {
			parts.push(
				t("onb.model.costOutput", {
					value:
						formatNumber(output, { style: "currency", currency: "USD", maximumFractionDigits: 2 }) ??
						String(output),
				}),
			);
		}
		return parts.join(" · ");
	};

	return (
		<div className="onb" onKeyDown={onKeyDown}>
			<nav className="onb__nav" aria-label={t("onb.navLabel")}>
				<ol>
					{STEPS.map((item, index) => (
						<li key={item.id}>
							<button
								type="button"
								className={index < step ? "is-done" : undefined}
								aria-current={index === step ? "step" : undefined}
								onClick={() => setStep(index)}
							>
								<span className="onb__dot">
									{index < step ? <Icon name="check" className="icon--sm" /> : index + 1}
								</span>
								{t(item.label)}
							</button>
						</li>
					))}
				</ol>
				<button type="button" className="btn btn--ghost onb__close" onClick={finish}>
					{t("onb.close")}
				</button>
				<p className="muted text-xs onb__nav-note">{t("onb.note")}</p>
			</nav>

			<div className="onb__main">
				<div className="onb__body" key={step}>
					{step === 0 ? (
						<>
							<BrandMark size={64} />
							<h1 ref={headingRef} tabIndex={-1}>
								{t("onb.welcome.title")}
							</h1>
							<p className="onb__lead">{t("onb.welcome.lead")}</p>
							<ul className="onb__points">
								<li>
									<span className="onb__n">1</span>
									<div>
										<b>{t("onb.welcome.point1.title")}</b>
										<span>{t("onb.welcome.point1.body")}</span>
									</div>
								</li>
								<li>
									<span className="onb__n">2</span>
									<div>
										<b>{t("onb.welcome.point2.title")}</b>
										<span>{t("onb.welcome.point2.body")}</span>
									</div>
								</li>
								<li>
									<span className="onb__n">3</span>
									<div>
										<b>{t("onb.welcome.point3.title")}</b>
										<span>{t("onb.welcome.point3.body")}</span>
									</div>
								</li>
							</ul>
							<div className="onb__not">
								<h2>{t("onb.welcome.notTitle")}</h2>
								<ul>
									<li>{t("onb.welcome.not1")}</li>
									<li>{t("onb.welcome.not2")}</li>
									<li>{t("onb.welcome.not3")}</li>
								</ul>
							</div>
							<p className="onb__warning" role="note">
								<Icon name="warning" className="icon--sm" />
								<span>{t(linux ? "onb.welcome.unsignedLinux" : "onb.welcome.unsigned")}</span>
							</p>
						</>
					) : null}

					{step === 1 ? (
						<>
							<h1 ref={headingRef} tabIndex={-1}>
								{t("onb.env.title")}
							</h1>
							<p className="onb__lead">{t("onb.env.lead")}</p>
							<ul className="onb__checks">
								<CheckRow
									icon="cpu"
									label={t("onb.env.omp")}
									ok={Boolean(effectiveRuntime?.ompPath)}
									value={
										effectiveRuntime?.ompPath
											? `${effectiveRuntime.ompPath}${effectiveRuntime.ompVersion ? ` · ${effectiveRuntime.ompVersion}` : ""}`
											: undefined
									}
									action={
										<>
											{!effectiveRuntime?.ompPath ||
											effectiveRuntime?.phase === "omp-incompatible" ? (
												<button
													type="button"
													className="onb__inline-action"
													onClick={() => void actions.installOmp()}
													disabled={effectiveRuntime?.install?.state === "installing"}
												>
													{effectiveRuntime?.install?.state === "installing"
														? t("onb.env.installing")
														: t("onb.env.installOmp")}
												</button>
											) : null}
											<button
												type="button"
												className="onb__inline-action"
												onClick={() => void actions.selectOmp()}
											>
												{t("onb.env.selectOmp")}
											</button>
										</>
									}
								/>
								<CheckRow
									icon="command"
									label={t("onb.env.protocol")}
									ok={Boolean(effectiveRuntime?.ompPath)}
									value={t("onb.env.protocolValue")}
								/>
								<CheckRow
									icon="terminal"
									label={t("onb.env.shell")}
									ok={Boolean(effectiveRuntime?.shell)}
									value={effectiveRuntime?.shell}
									action={
										effectiveRuntime?.shell ? undefined : (
											<button
												type="button"
												className="onb__inline-action"
												onClick={() => setDiagnosticsOpen(true)}
											>
												{t("onb.env.openDiagnostics")}
											</button>
										)
									}
								/>
								<CheckRow
									icon="agent"
									label={t("onb.env.bun")}
									ok={Boolean(effectiveRuntime?.bunPath)}
									value={
										effectiveRuntime?.bunPath
											? `${effectiveRuntime.bunPath} · ${t("dep.included")}`
											: t("dep.included")
									}
								/>
							</ul>
							<OptionalToolsSection
								runtime={effectiveRuntime}
								onDependencies={(snapshot) => actions.applyDependencies(snapshot)}
							/>
							<div className="onb__env-actions">
								<button
									type="button"
									className="onb__inline-action"
									onClick={() => setDiagnosticsOpen((open) => !open)}
								>
									{diagnosticsOpen ? t("onb.env.closeDiagnostics") : t("onb.env.openDiagnostics")}
								</button>
							</div>
							<p className="muted text-xs">{t("onb.env.protocolHint")}</p>
							{diagnosticsOpen && effectiveRuntime ? (
								<div className="onb__diagnostics">
									<DiagnosticsScreen
										status={effectiveRuntime}
										onStatusChange={setRuntimeOverride}
									/>
								</div>
							) : null}
						</>
					) : null}

					{step === 2 ? (
						<>
							<h1 ref={headingRef} tabIndex={-1}>
								{t("onb.accounts.title")}
							</h1>
							<p className="onb__lead">{t("onb.accounts.lead")}</p>
							<div className="onb__accounts-head">
								<p className="muted text-xs">
									{usage?.updatedAt
										? `${t("onb.accounts.updatedAt", {
												date: formatDate(usage.updatedAt) ?? t("common.unavailable"),
											})} · `
										: ""}
									{t("onb.accounts.oauthNote")}
								</p>
								<button
									type="button"
									className="btn btn--sm"
									onClick={() => void loadUsage()}
									disabled={usageLoading}
								>
									{usageLoading ? t("onb.accounts.loading") : t("onb.accounts.refresh")}
								</button>
							</div>
							{usageError ? (
								<div className="onb__message onb__message--error" role="alert">
									<StatusIcon kind="error" />
									<span>{t("onb.accounts.loadError", { message: usageError })}</span>
									<button type="button" className="btn btn--sm" onClick={() => void loadUsage()}>
										{t("common.retry")}
									</button>
								</div>
							) : null}
							{usageLoading && !usage ? <p className="muted">{t("onb.accounts.loading")}</p> : null}
							{usage && (usage.unknown || usage.providers.length === 0) ? (
								<div className="onb__empty">
									<StatusIcon kind="info" size={20} />
									<p>{t("onb.accounts.unknown")}</p>
								</div>
							) : null}
							{usage && !usage.unknown && usage.providers.length > 0 ? (
								<div className="onb__usage">
									{usage.providers.map((provider) => (
										<section key={provider.providerId} className="onb__usage-provider">
											<h2>{provider.label ?? provider.providerId}</h2>
											{provider.accounts.length === 0 ? (
												<p className="muted text-xs">{t("onb.accounts.empty")}</p>
											) : null}
											{provider.accounts.map((account, index) => (
												<div key={`${provider.providerId}-${index}`} className="onb__usage-account">
													<div className="onb__usage-account-head">
														<b>{account.label ?? provider.label ?? provider.providerId}</b>
														{account.active ? <span className="onb__badge">{t("onb.accounts.active")}</span> : null}
													</div>
													{account.detail ? <p className="muted text-xs">{account.detail}</p> : null}
													{account.windows.length === 0 ? (
														<p className="muted text-xs">{t("onb.accounts.noWindows")}</p>
													) : (
														account.windows.map((window, windowIndex) => (
															<div key={`${window.label}-${windowIndex}`} className="onb__usage-window">
																<div className="onb__usage-window-head">
																	<span>{window.label || t("accounts.windowFallback")}</span>
																	<span className="mono">
																		{window.usedPercent === undefined
																			? t("common.unavailable")
																			: formatPercent(window.usedPercent)}
																	</span>
																</div>
																{window.usedPercent === undefined ? null : (
																	<div
																		className="onb__usage-bar"
																		role="meter"
																		aria-valuemin={0}
																		aria-valuemax={100}
																		aria-valuenow={Math.min(100, Math.round(window.usedPercent))}
																		aria-label={t("onb.accounts.windowUsage", {
																			label: window.label || t("accounts.windowFallback"),
																		})}
																	>
																		<span
																			className={`onb__usage-fill${window.usedPercent >= 80 ? " is-high" : ""}`}
																			style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }}
																		/>
																	</div>
																)}
																{window.resetsAt ? (
																	<span className="muted text-xs">
																		{t("onb.accounts.resetsAt", {
																			date: formatDate(window.resetsAt) ?? t("common.unavailable"),
																		})}
																	</span>
																) : null}
															</div>
														))
													)}
												</div>
											))}
										</section>
									))}
								</div>
							) : null}
							<div className="onb__callout">
								<div>
									<b>{t("onb.accounts.addTitle")}</b>
									<p className="muted text-xs">{t("onb.accounts.addBody")}</p>
								</div>
								<button
									type="button"
									className="btn"
									disabled={!canOpenSettings}
									title={canOpenSettings ? undefined : t("onb.accounts.openSettingsHint")}
									onClick={() => window.dispatchEvent(new CustomEvent("omp:onboarding-settings"))}
								>
									{t("onb.accounts.openSettings")}
								</button>
								{!canOpenSettings ? (
									<p className="muted text-xs">{t("onb.accounts.openSettingsHint")}</p>
								) : null}
							</div>
						</>
					) : null}

					{step === 3 ? (
						<>
							<h1 ref={headingRef} tabIndex={-1}>
								{t("onb.model.title")}
							</h1>
							<p className="onb__lead">{t("onb.model.lead")}</p>
							<div className="onb__current-model" role="status">
								<Icon name="cpu" className="icon--sm" />
								<span>
									{currentDefault
										? t("onb.model.current", { selector: currentDefault })
										: t("onb.model.currentUnknown")}
								</span>
							</div>
							{settingsError ? (
								<div className="onb__message onb__message--warning" role="status">
									<StatusIcon kind="warning" />
									<span>{t("onb.model.settingsError", { message: settingsError })}</span>
									<button type="button" className="btn btn--sm" onClick={() => void loadSettings()}>
										{t("common.retry")}
									</button>
								</div>
							) : null}
							<div className="onb__search">
								<Icon name="search" className="icon--sm" />
								<input
									type="search"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder={t("onb.model.searchPlaceholder")}
									aria-label={t("onb.model.search")}
									disabled={catalogLoading}
								/>
								{query.length > 0 ? (
									<button
										type="button"
										className="onb__search-clear"
										aria-label={t("onb.model.clearSearch")}
										onClick={() => setQuery("")}
									>
										<Icon name="close" className="icon--sm" />
									</button>
								) : null}
							</div>
							{catalogError ? (
								<div className="onb__message onb__message--error" role="alert">
									<StatusIcon kind="error" />
									<span>{t("onb.model.loadError", { message: catalogError })}</span>
									<button type="button" className="btn btn--sm" onClick={() => void loadModels()}>
										{t("common.retry")}
									</button>
								</div>
							) : null}
							{catalogLoading ? <p className="muted">{t("onb.model.loading")}</p> : null}
							{!catalogLoading && !catalogError && catalog.length === 0 ? (
								<div className="onb__empty">
									<StatusIcon kind="empty" size={20} />
									<p>{t("onb.model.empty")}</p>
								</div>
							) : null}
							{!catalogLoading && catalog.length > 0 && filtered.length === 0 ? (
								<div className="onb__empty">
									<StatusIcon kind="empty" size={20} />
									<p>{t("onb.model.noMatch", { query })}</p>
								</div>
							) : null}
							{groups.length > 0 ? (
								<div className="onb__models" role="group" aria-label={t("onb.model.title")}>
									{groups.map((group) => (
										<section key={group.provider} className="onb__model-group">
											<h2>{group.provider}</h2>
											<ul>
												{group.models.map((model) => {
													const isCurrent = selectorMatchesRole(model.selector, currentDefault);
													const isSelected = selected === model.selector;
													const cost = modelCost(model);
													return (
														<li key={model.selector}>
															<button
																type="button"
																className={`onb__model${isSelected ? " is-selected" : ""}${isCurrent ? " is-current" : ""}`}
																aria-pressed={isSelected}
																onClick={() => {
																	setSelected(model.selector);
																	setSaveMessage(null);
																}}
															>
																<span className="onb__model-head">
																	<span className="onb__model-name">{model.name}</span>
																	{isCurrent ? (
																		<span className="onb__badge">{t("onb.model.currentBadge")}</span>
																	) : null}
																</span>
																<span className="onb__model-id mono">{model.selector}</span>
																<span className="onb__model-tags">
																	{model.contextWindow !== undefined ? (
																		<span className="onb__tag">
																			{t("onb.model.context", {
																				tokens: formatNumber(model.contextWindow) ?? String(model.contextWindow),
																			})}
																		</span>
																	) : null}
																	{model.reasoning ? (
																		<span className="onb__tag">{t("onb.model.reasoning")}</span>
																	) : null}
																	{model.input?.includes("image") ? (
																		<span className="onb__tag">{t("onb.model.image")}</span>
																	) : null}
																	{model.thinking && model.thinking.length > 0 ? (
																		<span className="onb__tag">
																			{t("onb.model.thinking", { levels: model.thinking.join(", ") })}
																		</span>
																	) : null}
																	{cost ? (
																		<span className="onb__tag onb__tag--cost">
																			{t("onb.model.costLabel")}: {cost}
																		</span>
																	) : null}
																</span>
															</button>
														</li>
													);
												})}
											</ul>
										</section>
									))}
								</div>
							) : null}
							{saveMessage ? (
								<div
									className={`onb__message onb__message--${saveMessage.level}`}
									role={saveMessage.level === "error" ? "alert" : "status"}
								>
									<StatusIcon
										kind={
											saveMessage.level === "success"
												? "success"
												: saveMessage.level === "warning"
													? "warning"
													: "error"
										}
									/>
									<span>{saveMessage.text}</span>
								</div>
							) : null}
							<div className="onb__model-actions">
								<button
									type="button"
									className="btn btn--primary"
									onClick={() => void saveDefault()}
									disabled={
										!selected ||
										saving ||
										!settings ||
										selectorMatchesRole(selected, currentDefault)
									}
								>
									{saving
										? t("onb.model.saving")
										: selected && selectorMatchesRole(selected, currentDefault)
											? t("onb.model.alreadyDefault")
											: t("onb.model.useAsDefault")}
								</button>
								<span className="muted text-xs">
									{t("onb.model.selectHint")}
								</span>
							</div>
						</>
					) : null}

					{step === 4 ? (
						<>
							<h1 ref={headingRef} tabIndex={-1}>
								{t("onb.finish.title")}
							</h1>
							<p className="onb__lead">{t("onb.finish.lead")}</p>
							<div
								className="onb__themes"
								role="radiogroup"
								aria-label={t("onb.finish.theme")}
								onKeyDown={onThemeKeyDown}
							>
								{themes.map((option) => (
									<button
										type="button"
										key={option.value}
										ref={(node) => {
											themeRefs.current[option.value] = node;
										}}
										role="radio"
										aria-checked={theme === option.value}
										tabIndex={theme === option.value ? 0 : -1}
										className={`onb__theme onb__theme--${option.value}`}
										onClick={() => actions.setTheme(option.value)}
									>
										<span className="onb__theme-preview" aria-hidden="true">
											<i />
											<i />
										</span>
										{t(option.label)}
									</button>
								))}
							</div>
							<div className="onb__shortcuts">
								<span>
									{t("onb.finish.shortcutPalette")} <kbd>Ctrl+K</kbd>
								</span>
								<span>
									{t("onb.finish.shortcutModel")} <kbd>Ctrl+M</kbd>
								</span>
								<span>
									{t("onb.finish.shortcutNew")} <kbd>Ctrl+N</kbd>
								</span>
								<span>
									{t("onb.finish.shortcutOpen")} <kbd>Ctrl+Shift+P</kbd>
								</span>
								<span>
									{t("onb.finish.shortcutTerminal")} <kbd>Ctrl+`</kbd>
								</span>
								<span>
									{t("onb.finish.shortcutStop")} <kbd>Esc</kbd>
								</span>
							</div>
							<h2 className="onb__subhead">{t("onb.finish.projectTitle")}</h2>
							<p className="muted text-xs">{t("onb.finish.projectLead")}</p>
							<button
								type="button"
								className="onb__card onb__card--primary"
								onClick={() => {
									finish();
									void actions.pickWorkspace();
								}}
							>
								<span className="onb__card-icon">
									<Icon name="folder-open" />
								</span>
								<span className="onb__card-title">{t("onb.finish.openFolder")}</span>
								<span className="muted">{t("onb.finish.openFolderBody")}</span>
							</button>
							<p className="muted text-xs">{t("onb.finish.note")}</p>
						</>
					) : null}
				</div>

				<div className="onb__foot">
					<button type="button" className="btn btn--ghost onb__close-foot" onClick={finish}>
						{t("onb.close")}
					</button>
					{step > 0 ? (
						<button type="button" className="btn" onClick={() => setStep(step - 1)}>
							{t("onb.back")}
						</button>
					) : (
						<button type="button" className="btn btn--ghost onb__skip" onClick={finish}>
							{t("onb.skip")}
						</button>
					)}
					<span className="onb__spacer" />
					<span className="muted text-xs" aria-live="polite">
						{t("onb.stepOf", { current: step + 1, total: STEPS.length })} · {t("onb.escHint")}
					</span>
					{step < STEPS.length - 1 ? (
						<button type="button" className="btn btn--primary" onClick={() => setStep(step + 1)}>
							{t("onb.continue")}
						</button>
					) : (
						<button type="button" className="btn btn--primary" onClick={finish}>
							{t("onb.finish")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
