import { useEffect, useState } from "react";
import type {
	DependencyRuntimeSnapshot,
	DependencyRuntimeState,
	RuntimeStatus,
} from "@shared/contracts";
import type {
	DependencyInstallPhase,
	DependencyKind,
} from "@shared/dependency-install-types";
import { invoke } from "../../api";
import { Icon } from "../../components/Icon";
import { useI18n, type MessageKey } from "../../i18n";
import { StatusIcon } from "../agents/StatusIcon";
import { formatBytes } from "../agents/ui-utils";
import { localizeError } from "../errors/error-messages";
import { dependencyErrorKey } from "./dependency-errors";
import { manualInstructions, runtimePlatform } from "./dependency-platform";
import "./optional-tools.css";

const PHASE_KEYS: Record<DependencyInstallPhase, MessageKey> = {
	resolving: "dep.phase.resolving",
	downloading: "dep.phase.downloading",
	verifying: "dep.phase.verifying",
	extracting: "dep.phase.extracting",
	activating: "dep.phase.activating",
};

const KIND_LABEL: Record<DependencyKind, MessageKey> = {
	git: "dep.git.name",
	node: "dep.node.name",
};

const KIND_PURPOSE: Record<DependencyKind, MessageKey> = {
	git: "dep.git.purpose",
	node: "dep.node.purpose",
};

const KIND_ICON: Record<DependencyKind, "git" | "terminal"> = {
	git: "git",
	node: "terminal",
};

function isInstalling(
	state: DependencyRuntimeState | undefined,
): state is Extract<DependencyRuntimeState, { state: "installing" }> {
	return state?.state === "installing";
}

function isInstalled(
	state: DependencyRuntimeState | undefined,
): state is Extract<DependencyRuntimeState, { state: "installed" }> {
	return state?.state === "installed";
}

function isError(
	state: DependencyRuntimeState | undefined,
): state is Extract<DependencyRuntimeState, { state: "error" }> {
	return state?.state === "error";
}

/**
 * Seção reutilizável de Git/Node opcionais (Diagnóstico, introdução e
 * Configurações). O renderer só envia o `kind`; URL, versão, comando e pasta
 * ficam no main. Nenhuma instalação começa sem um clique explícito e uma
 * confirmação, e nada aqui bloqueia o app ou o OMP.
 */
export function OptionalToolsSection({
	runtime,
	onDependencies,
}: {
	runtime: RuntimeStatus | null;
	onDependencies?: (snapshot: DependencyRuntimeSnapshot) => void;
}) {
	const { t, locale, formatNumber } = useI18n();
	const [snapshot, setSnapshot] = useState<DependencyRuntimeSnapshot | undefined>(
		runtime?.dependencies,
	);
	const [confirming, setConfirming] = useState<DependencyKind | null>(null);
	const [busy, setBusy] = useState<DependencyKind | null>(null);
	const [checking, setChecking] = useState(false);
	const [failure, setFailure] = useState<{ kind: DependencyKind; detail: string } | null>(null);
	const [checkFailure, setCheckFailure] = useState<string | null>(null);
	const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
	const platform = runtimePlatform(runtime);

	useEffect(() => {
		setSnapshot(runtime?.dependencies);
	}, [runtime?.dependencies]);

	const publish = (next: DependencyRuntimeSnapshot) => {
		setSnapshot(next);
		onDependencies?.(next);
	};

	const checkAgain = async () => {
		setChecking(true);
		setCheckFailure(null);
		try {
			const next = await invoke<DependencyRuntimeSnapshot>({ op: "runtime.dependencies" });
			if (next && typeof next === "object") publish(next);
		} catch (error) {
			setCheckFailure(localizeError(error, t));
		} finally {
			setChecking(false);
		}
	};

	const install = async (kind: DependencyKind) => {
		setConfirming(null);
		setBusy(kind);
		setFailure(null);
		try {
			const next = await invoke<DependencyRuntimeSnapshot>({
				op: "runtime.installDependency",
				dependency: kind,
			});
			if (next && typeof next === "object") publish(next);
		} catch (error) {
			setFailure({ kind, detail: localizeError(error, t) });
		} finally {
			setBusy(null);
		}
	};

	const openManual = async (kind: DependencyKind) => {
		try {
			await invoke({ op: "runtime.openExternal", url: manualInstructions(platform, kind).url });
		} catch (error) {
			setFailure({ kind, detail: localizeError(error, t) });
		}
	};

	const copyCommand = async (command: string) => {
		try {
			await navigator.clipboard.writeText(command);
			setCopiedCommand(command);
		} catch {
			setFailure({ kind: "git", detail: t("dep.copyFailed") });
		}
	};

	const renderState = (kind: DependencyKind, state: DependencyRuntimeState | undefined) => {
		if (!state) {
			return <span className="omp-optional-tool__badge">{t("dep.status.unknown")}</span>;
		}
		if (isInstalling(state)) {
			return (
				<span className="omp-optional-tool__badge is-installing">
					{t("dep.status.installing")}
				</span>
			);
		}
		if (isInstalled(state)) {
			return <span className="omp-optional-tool__badge is-ok">{t("dep.status.installed")}</span>;
		}
		if (isError(state)) {
			return <span className="omp-optional-tool__badge is-error">{t("dep.status.error")}</span>;
		}
		return <span className="omp-optional-tool__badge">{t("dep.status.missing")}</span>;
	};

	const renderDetails = (kind: DependencyKind, state: DependencyRuntimeState | undefined) => {
		if (isInstalled(state)) {
			return (
				<div className="omp-optional-tool__meta">
					<span className="mono">{t("dep.version", { version: state.version })}</span>
					<span className="mono truncate" title={state.executablePath}>
						{t("dep.location", { path: state.executablePath })}
					</span>
					{kind === "node" ? <span className="omp-muted">{t("dep.node.npm")}</span> : null}
				</div>
			);
		}
		if (isInstalling(state)) {
			const total = state.totalBytes;
			const received = state.receivedBytes;
			return (
				<div className="omp-optional-tool__progress">
					<p role="status">{t(PHASE_KEYS[state.phase])}</p>
					{typeof total === "number" && total > 0 && typeof received === "number" ? (
						<>
							<progress
								className="omp-optional-tool__bar"
								max={total}
								value={received}
								aria-label={t("dep.install", { tool: t(KIND_LABEL[kind]) })}
							/>
							<p className="omp-muted">
								{t("dep.progressBytes", {
									received: formatBytes(received, locale) ?? String(received),
									total: formatBytes(total, locale) ?? String(total),
									percent:
										formatNumber(Math.floor((received / total) * 100)) ?? "0",
								})}
							</p>
						</>
					) : null}
				</div>
			);
		}
		if (isError(state)) {
			return (
				<div className="omp-optional-tool__error" role="alert">
					<StatusIcon kind="error" />
					<div>
						<p>{t(dependencyErrorKey(state.code))}</p>
						{state.message ? (
							<p className="omp-muted text-xs">
								{t("dep.detail", { message: state.message })}
							</p>
						) : null}
					</div>
				</div>
			);
		}
		return null;
	};

	const renderManual = (kind: DependencyKind) => {
		const instructions = manualInstructions(platform, kind);
		if (kind === "git" && platform === "linux") {
			return (
				<div
					className="omp-optional-tool__manual is-open"
					data-testid="manual-git-linux"
				>
					<p>
						<b>{t("dep.nativeGitTitle")}</b>
					</p>
					<p className="omp-muted">{t("dep.nativeGitBody")}</p>
					{instructions.commands.map(({ distro, command }) => (
						<div key={distro} className="omp-optional-tool__command">
							<span className="omp-muted">
								{t(distro === "debian" ? "dep.debianUbuntu" : "dep.archLinux")}
							</span>
							<code className="mono">{command}</code>
							<button
								type="button"
								className="omp-button"
								onClick={() => void copyCommand(command)}
							>
								<Icon name="copy" className="icon--sm" />{" "}
								{copiedCommand === command ? t("dep.copied") : t("dep.copyCommand")}
							</button>
						</div>
					))}
					<button type="button" className="omp-button" onClick={() => void openManual(kind)}>
						<Icon name="external" className="icon--sm" /> {t("dep.openOfficial")}
					</button>
				</div>
			);
		}
		return (
			<details className="omp-optional-tool__manual">
				<summary>{t("dep.manual")}</summary>
				<p className="mono">{t(kind === "git" ? "dep.manualGit" : "dep.manualNode")}</p>
				<button type="button" className="omp-button" onClick={() => void openManual(kind)}>
					<Icon name="external" className="icon--sm" /> {t("dep.openOfficial")}
				</button>
			</details>
		);
	};

	const renderRow = (kind: DependencyKind) => {
		const state = snapshot?.[kind];
		const installing = isInstalling(state) || busy === kind;
		const installed = isInstalled(state);
		const manualOnly = kind === "git" && platform === "linux";
		const showManual = !installed && !installing;
		const rowFailure = failure?.kind === kind ? failure.detail : null;
		return (
			<li key={kind} className="omp-optional-tool" data-dependency={kind}>
				<span className="omp-optional-tool__icon">
					<Icon name={KIND_ICON[kind]} />
				</span>
				<div className="omp-optional-tool__body">
					<div className="omp-optional-tool__head">
						<b>{t(KIND_LABEL[kind])}</b>
						{renderState(kind, state)}
					</div>
					<p className="omp-muted">{t(KIND_PURPOSE[kind])}</p>
					{renderDetails(kind, state)}
					{rowFailure ? (
						<div className="omp-optional-tool__error" role="alert">
							<StatusIcon kind="error" />
							<span>{t("dep.installFailed", { tool: t(KIND_LABEL[kind]), message: rowFailure })}</span>
						</div>
					) : null}
					{confirming === kind ? (
						<div className="omp-optional-tool__consent" role="group" aria-label={t("dep.consentTitle", { tool: t(KIND_LABEL[kind]) })}>
							<p>{t("dep.consentBody", { tool: t(KIND_LABEL[kind]) })}</p>
							<div className="omp-row">
								<button
									type="button"
									className="omp-button omp-button-primary"
									onClick={() => void install(kind)}
								>
									{t("dep.confirm")}
								</button>
								<button type="button" className="omp-button" onClick={() => setConfirming(null)}>
									{t("common.cancel")}
								</button>
							</div>
						</div>
					) : null}
					{showManual ? renderManual(kind) : null}
				</div>
				<div className="omp-optional-tool__actions">
					{!installed && !manualOnly ? (
						<button
							type="button"
							className="omp-button omp-button-primary"
							data-testid={`install-${kind}`}
							onClick={() => setConfirming(kind)}
							disabled={installing || checking || confirming !== null}
						>
							<Icon name="download" className="icon--sm" />{" "}
							{installing ? t("dep.status.installing") : t("dep.install", { tool: t(KIND_LABEL[kind]) })}
						</button>
					) : null}
					<button
						type="button"
						className="omp-button"
						data-testid={`check-${kind}`}
						onClick={() => void checkAgain()}
						disabled={checking || installing}
					>
						<Icon name="refresh" className="icon--sm" /> {t("dep.checkAgain")}
					</button>
				</div>
			</li>
		);
	};

	return (
		<section className="omp-optional-tools" aria-labelledby="omp-optional-tools-title">
			<header className="omp-optional-tools__head">
				<h2 id="omp-optional-tools-title">{t("dep.title")}</h2>
				<p className="omp-muted">{t("dep.lead")}</p>
			</header>
			<ul className="omp-optional-tools__list">
				{renderRow("git")}
				{renderRow("node")}
			</ul>
			{checkFailure ? (
				<div className="omp-message omp-message-error" role="alert">
					<StatusIcon kind="error" />
					<span>{t("dep.checkFailed", { message: checkFailure })}</span>
				</div>
			) : null}
			<p className="omp-muted text-xs">{t("dep.noRestart")}</p>
		</section>
	);
}

export default OptionalToolsSection;
