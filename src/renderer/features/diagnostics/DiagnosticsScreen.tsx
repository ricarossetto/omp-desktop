import { useEffect, useState } from "react";
import type { RuntimeStatus } from "@shared/contracts";
import { invoke } from "../../api";
import { useI18n, type MessageKey } from "../../i18n";
import { StatusIcon, type IconKind } from "../agents/StatusIcon";
import { errorText, isRecord, unwrapRpcData } from "../agents/ui-utils";
import "./diagnostics.css";

const PHASE_LABELS: Record<RuntimeStatus["phase"], MessageKey> = {
	"starting-host": "diag.phase.startingHost",
	ready: "diag.phase.ready",
	"omp-missing": "diag.phase.ompMissing",
	"omp-incompatible": "diag.phase.ompIncompatible",
	"host-failed": "diag.phase.hostFailed",
};

const PHASE_ICONS: Record<RuntimeStatus["phase"], IconKind> = {
	"starting-host": "pending",
	ready: "success",
	"omp-missing": "warning",
	"omp-incompatible": "error",
	"host-failed": "error",
};

function isRuntimePhase(value: unknown): value is RuntimeStatus["phase"] {
	return typeof value === "string" && Object.hasOwn(PHASE_LABELS, value);
}

function asRuntimeStatus(raw: unknown): RuntimeStatus | null {
	const value = unwrapRpcData(raw);
	if (!isRecord(value) || !isRuntimePhase(value.phase)) return null;
	return {
		phase: value.phase,
		ompPath: typeof value.ompPath === "string" ? value.ompPath : undefined,
		ompVersion: typeof value.ompVersion === "string" ? value.ompVersion : undefined,
		gitVersion: typeof value.gitVersion === "string" ? value.gitVersion : undefined,
		shell: typeof value.shell === "string" ? value.shell : undefined,
		bunPath: typeof value.bunPath === "string" ? value.bunPath : undefined,
		message: typeof value.message === "string" ? value.message : undefined,
		signed: value.signed === true,
	};
}

function DetailRow({ label, value, missing }: { label: string; value?: string; missing?: boolean }) {
	const { t } = useI18n();
	return (
		<div>
			<dt>{label}</dt>
			<dd className={missing ? "omp-diagnostics-missing" : undefined}>
				{value ?? t("diag.notDetected")}
			</dd>
		</div>
	);
}

export function DiagnosticsScreen({
	status,
	onStatusChange,
}: {
	status: RuntimeStatus;
	onStatusChange?: (status: RuntimeStatus) => void;
}) {
	const { t } = useI18n();
	const [current, setCurrent] = useState<RuntimeStatus>(status);
	const [busy, setBusy] = useState<"select" | "retry" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		setCurrent(status);
	}, [status]);

	const publish = (next: RuntimeStatus) => {
		setCurrent(next);
		onStatusChange?.(next);
	};

	const selectOmp = async () => {
		setBusy("select");
		setError(null);
		setNotice(null);
		try {
			const next = asRuntimeStatus(
				await invoke({ op: "runtime.selectOmp" }),
			);
			if (next) {
				const changedPath = next.ompPath !== current.ompPath;
				publish(next);
				if (next.phase === "ready" && changedPath) {
					setNotice(t("diag.selectedReady"));
				} else if (next.phase === "omp-incompatible") {
					setError(next.message ?? t("diag.incompatibleSelected"));
				} else if (next.phase === "omp-missing") {
					setError(t("diag.missingSelected"));
				}
			} else {
				setError(t("diag.invalidStatus"));
			}
		} catch (failure) {
			setError(t("diag.selectError", { message: errorText(failure) }));
		} finally {
			setBusy(null);
		}
	};

	const retry = async () => {
		setBusy("retry");
		setError(null);
		setNotice(null);
		try {
			const next = asRuntimeStatus(await invoke({ op: "runtime.status" }));
			if (next) publish(next);
			else setError(t("diag.invalidStatus"));
		} catch (failure) {
			setError(t("diag.checkError", { message: errorText(failure) }));
		} finally {
			setBusy(null);
		}
	};

	const missingOmp = current.phase === "omp-missing" || current.phase === "omp-incompatible";

	return (
		<section className="omp-diagnostics" aria-label={t("diag.aria")}>
			<header className="omp-diagnostics-head">
				<div>
					<h1>{t("diag.title")}</h1>
					<p className="omp-muted">{t("diag.lead")}</p>
				</div>
				<div className="omp-row">
					<button
						type="button"
						className="omp-button"
						onClick={() => void selectOmp()}
						disabled={busy !== null}
					>
						{busy === "select" ? t("diag.selecting") : t("diag.selectOmp")}
					</button>
					<button
						type="button"
						className="omp-button omp-button-primary"
						onClick={() => void retry()}
						disabled={busy !== null}
					>
						{busy === "retry" ? t("diag.checking") : t("diag.checkAgain")}
					</button>
				</div>
			</header>

			<div className={`omp-diagnostics-phase omp-phase-${current.phase}`} role="status">
				<StatusIcon kind={PHASE_ICONS[current.phase]} size={20} />
				<div>
					<p className="omp-diagnostics-phase-label">{t(PHASE_LABELS[current.phase])}</p>
					{current.message ? <p className="omp-muted">{current.message}</p> : null}
				</div>
			</div>

			{error ? (
				<div className="omp-message omp-message-error" role="alert">
					<StatusIcon kind="error" />
					<span>{error}</span>
					<button type="button" className="omp-icon-button" onClick={() => setError(null)} aria-label={t("diag.closeError")}>
						×
					</button>
				</div>
			) : null}
			{notice ? (
				<div className="omp-message omp-message-success" role="status">
					<StatusIcon kind="success" />
					<span>{notice}</span>
				</div>
			) : null}

			{missingOmp ? (
				<section className="omp-diagnostics-section" aria-labelledby="omp-install-title">
					<h2 id="omp-install-title">{t("diag.howToFix")}</h2>
					{current.phase === "omp-incompatible" ? (
						<p>{t("diag.incompatibleBody")}</p>
					) : (
						<>
							<p>{t("diag.missingBody")}</p>
							<pre>{t("diag.missingInstall")}</pre>
							<p className="omp-muted">{t("diag.missingAlternative")}</p>
							<p>{t("diag.missingSelect")}</p>
						</>
					)}
				</section>
			) : null}

			<section className="omp-diagnostics-section" aria-labelledby="omp-components-title">
				<h2 id="omp-components-title">{t("diag.components")}</h2>
				<dl className="omp-diagnostics-grid">
					<DetailRow label={t("diag.omp")} value={current.ompPath} missing={!current.ompPath} />
					<DetailRow
						label={t("diag.ompVersion")}
						value={current.ompVersion}
						missing={!current.ompVersion}
					/>
					<DetailRow label={t("diag.bun")} value={current.bunPath} missing={!current.bunPath} />
					<DetailRow label={t("diag.git")} value={current.gitVersion} missing={!current.gitVersion} />
					<DetailRow label={t("diag.shell")} value={current.shell} missing={!current.shell} />
				</dl>
				<p className="omp-muted">{t("diag.gitNote")}</p>
			</section>

			<section className="omp-diagnostics-section omp-diagnostics-signing" aria-labelledby="omp-signing-title">
				<h2 id="omp-signing-title">{t("diag.signingTitle")}</h2>
				<p className="omp-message omp-message-warning" role="status">
					<StatusIcon kind="warning" /> {t("diag.signingBody")}
				</p>
			</section>
		</section>
	);
}

export default DiagnosticsScreen;
