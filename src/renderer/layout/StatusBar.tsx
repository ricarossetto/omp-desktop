import { useEffect, useRef, useState } from "react";
import { invoke } from "../api";
import { Icon } from "../components/Icon";
import { errorText } from "../features/agents/ui-utils";
import { useI18n, useT, type MessageKey } from "../i18n";
import { useActions, useStore } from "../store/context";
import { sessionHasActiveWork } from "../store/state";
import { statusFor } from "../store/session-status";

const STATUS_KEYS: Record<string, MessageKey> = {
	Iniciando: "shell.statusStarting",
	Pronta: "shell.statusReady",
	Trabalhando: "shell.statusWorking",
	Interrompida: "shell.statusInterrupted",
	"Com erro": "shell.statusError",
	Fechada: "shell.statusClosed",
	"Sem sessão": "shell.statusNone",
	Ressincronizando: "shell.statusResyncing",
	Compactando: "shell.statusCompacting",
	"Trabalho pendente": "shell.statusPendingWork",
};

/**
 * Rodapé da janela: contexto (clicável, com detalhe e compactação), custo
 * estimado e estado da sessão. Valor desconhecido aparece como "Indisponível".
 */
export function StatusBar() {
	const t = useT();
	const { locale, formatNumber, formatPercent } = useI18n();
	const actions = useActions();
	const workspaceId = useStore((state) => state.activeWorkspaceId);
	const sessionId = useStore((state) => state.activeSessionId);
	const view = useStore((state) => (state.activeSessionId ? (state.sessionStates[state.activeSessionId] ?? null) : null));
	const resyncing = useStore((state) => (state.activeSessionId ? state.resyncing[state.activeSessionId] === true : false));
	const [open, setOpen] = useState(false);
	const [compacting, setCompacting] = useState(false);
	const popRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);

	const formatTokens = (value: number | undefined): string | null => {
		if (value === undefined || !Number.isFinite(value)) return null;
		return (
			formatNumber(
				value,
				value >= 1000 ? { notation: "compact", maximumFractionDigits: 1 } : undefined,
			) ?? null
		);
	};

	const percent = view?.meta?.contextPercent;
	const percentValue = percent !== undefined && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
	const percentLabel = percent === undefined ? t("common.unavailable") : (formatPercent(percent) ?? t("common.unavailable"));
	const used = formatTokens(view?.meta?.contextTokens);
	const windowSize = formatTokens(view?.meta?.contextWindow);
	const cost = view?.stats?.costUsd;
	const costLabel =
		cost === undefined || !Number.isFinite(cost)
			? t("common.unavailable")
			: (formatNumber(
					cost,
					cost > 0 && cost < 0.01
						? { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 }
						: { style: "currency", currency: "USD" },
				) ?? t("common.unavailable"));
	const status = statusFor(view, resyncing);
	const statusKey = STATUS_KEYS[status.label];
	const statusLabel = statusKey ? t(statusKey) : status.label;
	const dialogCount = view?.pendingDialogs.length ?? 0;
	const busy = view ? sessionHasActiveWork(view) : false;

	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (!popRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				setOpen(false);
				buttonRef.current?.focus();
			}
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	const compact = async () => {
		if (!workspaceId || !sessionId) return;
		setCompacting(true);
		try {
			await invoke({ op: "session.rpc", workspaceId, sessionId, command: { type: "compact" } });
			actions.notify("info", t("shell.compactedNotice"));
			setOpen(false);
		} catch (error) {
			actions.notify("error", t("shell.compactFailed", { error: errorText(error, locale) }));
		} finally {
			setCompacting(false);
		}
	};

	return (
		<footer className="statusbar" aria-label={t("shell.statusLabel")}>
			<button
				ref={buttonRef}
				type="button"
				className="statusbar__btn"
				aria-expanded={open}
				aria-haspopup="dialog"
				disabled={!view}
				title={t("shell.contextUsageTitle")}
				onClick={() => setOpen((value) => !value)}
			>
				<span className="statusbar__meter" aria-hidden="true">
					<span style={{ width: `${percentValue ?? 0}%` }} />
				</span>
				{t("shell.context")} <span className="statusbar__value">{percentLabel}</span>
			</button>

			{open && view ? (
				<div ref={popRef} className="statusbar__pop" role="dialog" aria-label={t("shell.contextDialog")}>
					<div className="statusbar__pop-head">
						<strong>{t("shell.context")}</strong>
						<span className="muted">
							{used && windowSize
								? t("shell.contextTokens", { used, total: windowSize })
								: percentLabel}
						</span>
					</div>
					<div className="statusbar__bar" aria-hidden="true">
						<span style={{ width: `${percentValue ?? 0}%` }} />
					</div>
					<p className="muted text-xs">{t("shell.compactHint")}</p>
					<button type="button" className="btn btn--sm" disabled={compacting || busy} onClick={() => void compact()}>
						{compacting ? t("shell.compacting") : t("shell.compact")}
					</button>
					{busy ? <p className="muted text-xs">{t("shell.compactBusy")}</p> : null}
				</div>
			) : null}

			<span className="statusbar__item" title={t("shell.estimatedCostTitle")}>
				{t("shell.estimatedCost")} <span className="statusbar__value">{costLabel}</span>
			</span>

			<span className="statusbar__spacer" />

			{dialogCount > 0 ? (
				<span className="statusbar__item statusbar__item--warning">
					<Icon name="warning" className="icon--sm" />
					{dialogCount === 1 ? t("shell.pendingApproval") : t("shell.pendingApprovals", { count: dialogCount })}
				</span>
			) : null}
			<span className={`badge statusbar__item statusbar__state ${status.className}`} aria-live="polite">
				{status.label === "Trabalhando" || status.label === "Compactando" ? (
					<span className="ring" aria-hidden="true" />
				) : (
					<Icon name={status.icon} className="icon--sm" />
				)}
				{statusLabel}
			</span>
		</footer>
	);
}
