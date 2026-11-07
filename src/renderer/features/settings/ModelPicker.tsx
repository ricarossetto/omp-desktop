import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { rpcCommandSchema } from "@shared/contracts";
import type { SessionViewState } from "@shared/session-types";
import { invoke } from "../../api";
import { useI18n } from "../../i18n";
import { StatusIcon } from "../agents/StatusIcon";
import { errorText, unwrapRpcData } from "../agents/ui-utils";
import {
	groupModels,
	modelSelector,
	normalizeAvailableModels,
	normalizeThinkingLevels,
	splitModelSelector,
	type ModelOption,
} from "./config";
import "./model-picker.css";

export interface ModelPickerProps {
	workspaceId: string;
	sessionId: string;
	state?: SessionViewState;
	onClose: () => void;
}

export interface ThinkingLevelControlProps {
	workspaceId: string;
	sessionId: string;
	state?: SessionViewState;
	levels?: string[];
}

const CONTRACT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function isContractThinkingLevel(level: string): boolean {
	return (CONTRACT_THINKING_LEVELS as readonly string[]).includes(level);
}

/**
 * Nível de raciocínio: só oferece o que `get_available_thinking_levels`
 * anunciou. Em falha, restaura a escolha anterior e explica.
 */
export function ThinkingLevelControl({ workspaceId, sessionId, state, levels: provided }: ThinkingLevelControlProps) {
	const { t } = useI18n();
	const [levels, setLevels] = useState<string[]>(provided ?? []);
	const [loading, setLoading] = useState(!provided);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [pending, setPending] = useState<string | null>(null);
	const [notice, setNotice] = useState<{ level: "success" | "error"; text: string } | null>(null);
	const current = state?.meta?.thinkingLevel;
	const [selected, setSelected] = useState(current ?? "");
	const selectId = useId();
	const selectedRef = useRef(selected);

	useEffect(() => {
		setSelected(current ?? "");
	}, [current]);

	useEffect(() => {
		selectedRef.current = selected;
	}, [selected]);

	const loadLevels = useCallback(async () => {
		setLoading(true);
		setLoadError(null);
		try {
			const raw = await invoke({
				op: "session.rpc",
				workspaceId,
				sessionId,
				command: { type: "get_available_thinking_levels" },
			});
			setLevels(normalizeThinkingLevels(unwrapRpcData(raw)));
		} catch (error) {
			setLoadError(errorText(error));
		} finally {
			setLoading(false);
		}
	}, [sessionId, workspaceId]);

	useEffect(() => {
		if (provided && provided.length > 0) {
			setLevels(provided);
			setLoading(false);
			return;
		}
		void loadLevels();
	}, [loadLevels, provided]);

	const applyLevel = async (next: string) => {
		const previous = selectedRef.current;
		if (!next || next === previous) return;
		setPending(next);
		setNotice(null);
		setSelected(next);
		try {
			const command = rpcCommandSchema.parse({ type: "set_thinking_level", level: next });
			await invoke({ op: "session.rpc", workspaceId, sessionId, command });
			setNotice({ level: "success", text: t("thinking.changed", { level: next }) });
		} catch (error) {
			setSelected(previous);
			setNotice({
				level: "error",
				text: t("thinking.changeError", {
					level: previous || t("thinking.previous"),
					message: errorText(error),
				}),
			});
		} finally {
			setPending(null);
		}
	};

	const selectableCurrent = current && levels.includes(current) && isContractThinkingLevel(current) ? current : "";
	const available = levels.filter(level => level.length > 0 && isContractThinkingLevel(level));
	const unsupported = levels.filter(level => level.length > 0 && !isContractThinkingLevel(level));
	const selectValue =
		pending ?? (selected && available.includes(selected) ? selected : selectableCurrent);

	return (
		<div className="omp-thinking">
			<div className="omp-thinking-head">
				<label htmlFor={selectId}>{t("thinking.label")}</label>
				{current ? <span className="omp-muted">{t("thinking.current", { level: current })}</span> : null}
			</div>
			<select
				id={selectId}
				value={selectValue}
				disabled={loading || pending !== null || available.length === 0}
				onChange={event => void applyLevel(event.target.value)}
			>
				{!selectValue ? <option value="">{t("thinking.select")}</option> : null}
				{available.map(level => (
					<option key={level} value={level}>
						{level}
					</option>
				))}
			</select>
			{loading ? <p className="omp-muted">{t("thinking.loading")}</p> : null}
			{current && !levels.includes(current) && !loading ? (
				<p className="omp-muted">{t("thinking.notInList", { level: current })}</p>
			) : null}
			{current && levels.includes(current) && !isContractThinkingLevel(current) && !loading ? (
				<p className="omp-muted">{t("thinking.contractUnsupported", { level: current })}</p>
			) : null}
			{unsupported.length > 0 && !loading ? (
				<p className="omp-muted">{t("thinking.unsupportedList", { levels: unsupported.join(", ") })}</p>
			) : null}
			{loadError ? (
				<p className="omp-message omp-message-error" role="alert">
					<StatusIcon kind="error" /> {t("thinking.loadError", { message: loadError })}
					<button type="button" className="omp-button omp-button-small" onClick={() => void loadLevels()}>
						{t("common.retry")}
					</button>
				</p>
			) : null}
			{notice ? (
				<p
					className={`omp-message omp-message-${notice.level}`}
					role={notice.level === "error" ? "alert" : "status"}
				>
					<StatusIcon kind={notice.level === "success" ? "success" : "error"} /> {notice.text}
				</p>
			) : null}
		</div>
	);
}

export function ModelPicker({ workspaceId, sessionId, state, onClose }: ModelPickerProps) {
	const { t } = useI18n();
	const [models, setModels] = useState<ModelOption[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [applying, setApplying] = useState<string | null>(null);
	const [notice, setNotice] = useState<{ level: "success" | "error"; text: string } | null>(null);
	const [applied, setApplied] = useState<string | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const onCloseRef = useRef(onClose);

	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	const active = state?.meta?.model;
	const activeSelector = active ? `${active.provider}/${active.id}` : undefined;
	const currentSelector = applied ?? activeSelector;

	useEffect(() => {
		setApplied(null);
	}, [activeSelector]);

	const loadModels = useCallback(async () => {
		setLoading(true);
		setLoadError(null);
		try {
			const raw = await invoke({
				op: "session.rpc",
				workspaceId,
				sessionId,
				command: { type: "get_available_models" },
			});
			setModels(normalizeAvailableModels(unwrapRpcData(raw)));
		} catch (error) {
			setLoadError(errorText(error));
		} finally {
			setLoading(false);
		}
	}, [sessionId, workspaceId]);

	useEffect(() => {
		void loadModels();
	}, [loadModels]);

	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		// A busca fica desabilitada durante o carregamento; nesse caso o foco
		// inicial vai para o primeiro controle do próprio seletor.
		const initial =
			searchRef.current && !searchRef.current.disabled
				? searchRef.current
				: panelRef.current?.querySelector<HTMLElement>("button:not([disabled])");
		initial?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onCloseRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const node = panelRef.current;
			const items = Array.from(
				node?.querySelectorAll<HTMLElement>(
					'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
				) ?? [],
			);
			if (items.length === 0) {
				event.preventDefault();
				node?.focus();
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			const current = document.activeElement;
			if (!node?.contains(current)) {
				event.preventDefault();
				first.focus();
			} else if (event.shiftKey && current === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && current === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			previous?.focus();
		};
	}, []);

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return models;
		return models.filter(model => {
			const haystack = `${model.provider} ${model.id} ${model.name}`.toLowerCase();
			return haystack.includes(needle);
		});
	}, [models, query]);
	const groups = useMemo(() => groupModels(filtered), [filtered]);

	const choose = async (model: ModelOption) => {
		const selector = modelSelector(model);
		if (selector === currentSelector) return;
		setApplying(selector);
		setNotice(null);
		try {
			await invoke({
				op: "session.rpc",
				workspaceId,
				sessionId,
				command: { type: "set_model", provider: model.provider, modelId: model.id },
			});
			setApplied(selector);
			setNotice({ level: "success", text: t("modelPicker.applied", { model: model.name }) });
		} catch (error) {
			const previous = splitModelSelector(currentSelector);
			setNotice({
				level: "error",
				text: t("modelPicker.applyError", {
					previous: previous ? `${previous.provider}/${previous.id}` : t("modelPicker.previousUnknown"),
					message: errorText(error),
				}),
			});
		} finally {
			setApplying(null);
		}
	};

	return (
		<div className="omp-picker-backdrop" role="presentation" onMouseDown={() => onCloseRef.current()}>
			<div
				ref={panelRef}
				className="omp-model-picker"
				role="dialog"
				aria-modal="true"
				aria-labelledby="omp-model-picker-title"
				data-omp-escape-local
				tabIndex={-1}
				onMouseDown={event => event.stopPropagation()}
			>
				<header className="omp-model-picker-head">
					<div>
						<h2 id="omp-model-picker-title">{t("modelPicker.title")}</h2>
						<p className="omp-muted">
							{active ? (
								<>
									{t("modelPicker.activeInSession", {
										name: active.name || `${active.provider}/${active.id}`,
										selector: `${active.provider}/${active.id}`,
									})}
								</>
							) : (
								t("modelPicker.activeUnknown")
							)}
						</p>
					</div>
					<button type="button" className="omp-button omp-button-small" onClick={() => onCloseRef.current()}>
						{t("common.close")}
					</button>
				</header>

				<div className="omp-model-picker-search">
					<label className="omp-field">
						<span>{t("modelPicker.search")}</span>
						<input
							ref={searchRef}
							type="search"
							value={query}
							onChange={event => setQuery(event.target.value)}
							placeholder={t("modelPicker.searchPlaceholder")}
							disabled={loading}
						/>
					</label>
					<button
						type="button"
						className="omp-button omp-button-small"
						onClick={() => void loadModels()}
						disabled={loading}
					>
						{loading ? t("common.loading") : t("modelPicker.reload")}
					</button>
				</div>

				{loadError ? (
					<p className="omp-message omp-message-error" role="alert">
						<StatusIcon kind="error" /> {t("modelPicker.loadError", { message: loadError })}
					</p>
				) : null}
				{notice ? (
					<p
						className={`omp-message omp-message-${notice.level}`}
						role={notice.level === "error" ? "alert" : "status"}
					>
						<StatusIcon kind={notice.level === "success" ? "success" : "error"} /> {notice.text}
					</p>
				) : null}

				<div className="omp-model-picker-body">
					{loading ? <p className="omp-muted">{t("modelPicker.loadingList")}</p> : null}
					{!loading && filtered.length === 0 && !loadError ? (
						<div className="omp-empty">
							<StatusIcon kind="empty" size={20} />
							<p>{models.length === 0 ? t("modelPicker.empty") : t("modelPicker.noMatch")}</p>
							<p className="omp-muted">{t("modelPicker.checkAccounts")}</p>
						</div>
					) : null}
					{groups.map(group => (
						<section key={group.provider} className="omp-model-group" aria-label={group.provider}>
							<h3>{group.provider}</h3>
							<ul>
								{group.models.map(model => {
									const selector = modelSelector(model);
									const isCurrent = selector === currentSelector;
									return (
										<li key={selector}>
											<button
												type="button"
												className={`omp-model-row${isCurrent ? " is-current" : ""}`}
												onClick={() => void choose(model)}
												disabled={applying !== null}
												aria-pressed={isCurrent}
											>
												<span className="omp-model-name">
													{model.name}
													{isCurrent ? <span className="omp-badge">{t("modelPicker.current")}</span> : null}
												</span>
												<span className="omp-model-id">
													{model.provider}/{model.id}
												</span>
												<span className="omp-model-tags">
													{model.reasoning ? <span className="omp-badge">{t("modelPicker.reasoning")}</span> : null}
													{model.image ? <span className="omp-badge">{t("modelPicker.image")}</span> : null}
													{applying === selector ? <span className="omp-muted">{t("modelPicker.applying")}</span> : null}
												</span>
											</button>
										</li>
									);
								})}
							</ul>
						</section>
					))}
				</div>

				<footer className="omp-model-picker-foot">
					<ThinkingLevelControl workspaceId={workspaceId} sessionId={sessionId} state={state} />
					<p className="omp-hint">{t("modelPicker.hint")}</p>
				</footer>
			</div>
		</div>
	);
}

export default ModelPicker;
