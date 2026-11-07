import { useEffect, useState } from "react";
import type { OmpInstallState, RuntimeStatus } from "@shared/contracts";
import { invoke } from "../../api";
import { useI18n, type MessageKey } from "../../i18n";
import { StatusIcon, type IconKind } from "../agents/StatusIcon";
import { errorText, formatBytes, isRecord, unwrapRpcData } from "../agents/ui-utils";
import { installErrorKey } from "./install-errors";
import { asDependencySnapshot } from "./dependency-status";
import { OptionalToolsSection } from "./OptionalToolsSection";
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

const INSTALL_PHASE_LABELS: Record<
	Extract<OmpInstallState, { state: "installing" }>["phase"],
	MessageKey
> = {
	resolving: "diag.installPhase.resolving",
	downloading: "diag.installPhase.downloading",
	verifying: "diag.installPhase.verifying",
	activating: "diag.installPhase.activating",
};

function isRuntimePhase(value: unknown): value is RuntimeStatus["phase"] {
	return typeof value === "string" && Object.hasOwn(PHASE_LABELS, value);
}

function asInstallState(value: unknown): OmpInstallState | undefined {
	if (!isRecord(value) || typeof value.state !== "string") return undefined;
	if (value.state === "idle") return { state: "idle" };
	if (value.state === "installing") {
		const phase = value.phase;
		if (
			phase !== "resolving" &&
			phase !== "downloading" &&
			phase !== "verifying" &&
			phase !== "activating"
		) {
			return undefined;
		}
		return {
			state: "installing",
			phase,
			receivedBytes: typeof value.receivedBytes === "number" ? value.receivedBytes : undefined,
			totalBytes: typeof value.totalBytes === "number" ? value.totalBytes : undefined,
		};
	}
	if (value.state === "success") {
		if (typeof value.ompPath !== "string" || typeof value.ompVersion !== "string") return undefined;
		return { state: "success", ompPath: value.ompPath, ompVersion: value.ompVersion };
	}
	if (value.state === "error") {
		return {
			state: "error",
			code: typeof value.code === "string" ? value.code : "INTERNAL",
			message: typeof value.message === "string" ? value.message : "",
		};
	}
	return undefined;
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
		install: asInstallState(value.install),
		dependencies: asDependencySnapshot(value.dependencies),
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
	const { t, formatNumber } = useI18n();
	const [current, setCurrent] = useState<RuntimeStatus>(status);
	const [busy, setBusy] = useState<"select" | "retry" | "install" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		setCurrent(status);
	}, [status]);

	const publish = (next: RuntimeStatus) => {
		setCurrent(next);
		onStatusChange?.(next);
	};

	const installErrorText = (state: Extract<OmpInstallState, { state: "error" }>): string => {
		return t(installErrorKey(state.code), { message: state.message });
	};

	const installOmp = async () => {
		setBusy("install");
		setError(null);
		setNotice(null);
		try {
			const next = asRuntimeStatus(await invoke({ op: "runtime.installOmp" }));
			if (!next) {
				setError(t("diag.invalidStatus"));
				return;
			}
			publish(next);
			if (next.install?.state === "success") {
				setNotice(
					t("diag.installSuccess", {
						version: next.install.ompVersion,
						path: next.install.ompPath,
					}),
				);
			} else if (next.install?.state === "error") {
				// A seção de instalação mostra o erro com a ação de tentar de novo.
			} else if (next.phase === "ready") {
				setNotice(t("diag.selectedReady"));
			}
		} catch (failure) {
			setError(t("diag.installError", { message: errorText(failure) }));
		} finally {
			setBusy(null);
		}
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
	const installState = current.install;
	const installing = installState?.state === "installing";
	const installBusy = busy === "install" || installing;
	const installError = installState?.state === "error" ? installState : null;

	return (
		<section className="omp-diagnostics" aria-label={t("diag.aria")}>
			<header className="omp-diagnostics-head">
				<div>
					<h1>{t("diag.title")}</h1>
					<p className="omp-muted">{t("diag.lead")}</p>
				</div>
				<div className="omp-row">
					{missingOmp ? (
						<button
							type="button"
							className="omp-button omp-button-primary"
							onClick={() => void installOmp()}
							disabled={busy !== null || installBusy}
						>
							{installBusy ? t("diag.installing") : t("diag.installOmp")}
						</button>
					) : null}
					<button
						type="button"
						className="omp-button"
						onClick={() => void selectOmp()}
						disabled={busy !== null || installBusy}
					>
						{busy === "select" ? t("diag.selecting") : t("diag.selectOmp")}
					</button>
					<button
						type="button"
						className="omp-button"
						onClick={() => void retry()}
						disabled={busy !== null || installBusy}
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

			{installState?.state === "installing" ? (
				<section className="omp-diagnostics-section omp-install-progress" aria-labelledby="omp-install-progress-title">
					<h2 id="omp-install-progress-title">{t("diag.installProgressTitle")}</h2>
					<p role="status">{t(INSTALL_PHASE_LABELS[installState.phase])}</p>
					{typeof installState.receivedBytes === "number" &&
					typeof installState.totalBytes === "number" &&
					installState.totalBytes > 0 ? (
						<>
							<progress
								className="omp-install-progress__bar"
								max={installState.totalBytes}
								value={installState.receivedBytes}
								aria-label={t("diag.installProgressAria")}
							/>
							<p className="omp-muted">
								{t("diag.installProgressBytes", {
									received: formatBytes(installState.receivedBytes) ?? String(installState.receivedBytes),
									total: formatBytes(installState.totalBytes) ?? String(installState.totalBytes),
									percent: formatNumber(
										Math.floor((installState.receivedBytes / installState.totalBytes) * 100),
									) ?? "0",
								})}
							</p>
						</>
					) : null}
				</section>
			) : null}

			{installError ? (
				<div className="omp-message omp-message-error" role="alert">
					<StatusIcon kind="error" />
					<span>{installErrorText(installError)}</span>
					<button
						type="button"
						className="omp-button"
						onClick={() => void installOmp()}
						disabled={busy !== null || installBusy}
					>
						{t("diag.installRetry")}
					</button>
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
							<button
								type="button"
								className="omp-button omp-button-primary"
								onClick={() => void installOmp()}
								disabled={busy !== null || installBusy}
							>
								{installBusy ? t("diag.installing") : t("diag.installOmpAction")}
							</button>
							<p className="omp-muted">{t("diag.missingManual")}</p>
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

			<OptionalToolsSection
				runtime={current}
				onDependencies={(snapshot) => publish({ ...current, dependencies: snapshot })}
			/>

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
