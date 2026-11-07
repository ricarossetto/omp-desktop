import { DiffEditor } from "@monaco-editor/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitDiffResult, GitFileStatus, GitStatusResult } from "@shared/contracts";
import { invoke, subscribe } from "../../api";
import { useI18n, useT } from "../../i18n";
import { StatusIcon } from "../agents/StatusIcon";
import {
	errorCode,
	errorText,
	formatBytes,
	formatDateTime,
	isRecord,
	unwrapRpcData,
} from "../agents/ui-utils";
import {
	describeGitFile,
	diffLanguageFor,
	displayPath,
	normalizeFileRead,
	normalizeGitDiff,
	normalizeGitStatus,
	sortGitFiles,
	statusSummary,
	type FileReadView,
} from "./git-display";
import { ensureMonaco, MONACO_THEME_DARK, MONACO_THEME_LIGHT } from "./monaco-setup";
import "./changes.css";

ensureMonaco();

type DiffSource = "working" | "index";

interface FileDialogState extends FileReadView {
	title: string;
}

function prefersDarkBackground(): boolean {
	if (typeof document === "undefined") return true;
	const root = document.documentElement;
	const candidates = [
		getComputedStyle(root).getPropertyValue("--bg").trim(),
		getComputedStyle(document.body).backgroundColor,
	];
	for (const candidate of candidates) {
		const hex = candidate.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
		if (hex) {
			const digits = hex[1];
			const expanded =
				digits.length === 3
					? digits
							.split("")
							.map(char => char + char)
							.join("")
					: digits;
			const red = Number.parseInt(expanded.slice(0, 2), 16);
			const green = Number.parseInt(expanded.slice(2, 4), 16);
			const blue = Number.parseInt(expanded.slice(4, 6), 16);
			const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
			return luminance < 0.5;
		}
		const rgb = candidate.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
		if (rgb) {
			const luminance =
				(0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3])) / 255;
			return luminance < 0.5;
		}
	}
	return true;
}

function useMonacoTheme(): string {
	const [dark, setDark] = useState(() => prefersDarkBackground());
	useEffect(() => {
		const update = () => setDark(prefersDarkBackground());
		const observer = new MutationObserver(update);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-theme", "style"],
		});
		if (document.body) {
			observer.observe(document.body, {
				attributes: true,
				attributeFilter: ["class", "data-theme", "style"],
			});
		}
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		media.addEventListener("change", update);
		return () => {
			observer.disconnect();
			media.removeEventListener("change", update);
		};
	}, []);
	return dark ? MONACO_THEME_DARK : MONACO_THEME_LIGHT;
}

function commitHashFrom(data: unknown): string | undefined {
	if (!isRecord(data)) return undefined;
	const nested = isRecord(data.commit) ? data.commit.hash : undefined;
	for (const candidate of [data.hash, data.commit, data.commitId, nested]) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate.slice(0, 12);
	}
	return undefined;
}

function gitStatusSettledEvent(event: { workspaceId: string; name: string; data: unknown }): boolean {
	if (event.name === "session.status") {
		if (!isRecord(event.data)) return false;
		if (typeof event.data.status === "string") return event.data.status === "settled";
		if (isRecord(event.data.state) && typeof event.data.state.status === "string") {
			return event.data.state.status === "settled";
		}
		return false;
	}
	if (event.name === "frame" && isRecord(event.data)) {
		return event.data.type === "session_settled";
	}
	return false;
}

export function ChangesPanel({ workspaceId }: { workspaceId: string }) {
	const t = useT();
	const { locale } = useI18n();
	const [status, setStatus] = useState<GitStatusResult | null>(null);
	const [statusLoading, setStatusLoading] = useState(true);
	const [statusError, setStatusError] = useState<string | null>(null);
	const [updatedAt, setUpdatedAt] = useState<number | null>(null);
	const [refreshTick, setRefreshTick] = useState(0);
	const [source, setSource] = useState<DiffSource>("working");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [diff, setDiff] = useState<GitDiffResult | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);
	const [diffError, setDiffError] = useState<string | null>(null);
	const [sideBySide, setSideBySide] = useState(false);
	const [busyPath, setBusyPath] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [commitMessage, setCommitMessage] = useState("");
	const [commitBusy, setCommitBusy] = useState(false);
	const [commitNotice, setCommitNotice] = useState<{ level: "success" | "error"; text: string } | null>(null);
	const [fileDialog, setFileDialog] = useState<FileDialogState | null>(null);
	const [fileDialogLoading, setFileDialogLoading] = useState(false);
	const [externalBusy, setExternalBusy] = useState(false);
	const dialogRef = useRef<HTMLDivElement>(null);
	const readTokenRef = useRef(0);
	const workspaceRef = useRef(workspaceId);
	const theme = useMonacoTheme();

	const refreshStatus = useCallback(
		async (quiet = false) => {
			if (!quiet) setStatusLoading(true);
			try {
				const raw = await invoke({ op: "git.status", workspaceId });
				if (workspaceRef.current !== workspaceId) return;
				const next = normalizeGitStatus(raw);
				setStatus(next);
				setUpdatedAt(Date.now());
				setStatusError(null);
				setSelectedPath(current =>
					current && next.files.some(file => file.path === current) ? current : null,
				);
				setRefreshTick(value => value + 1);
			} catch (error) {
				if (workspaceRef.current !== workspaceId) return;
				setStatusError(errorText(error, locale));
			} finally {
				if (!quiet && workspaceRef.current === workspaceId) setStatusLoading(false);
			}
		},
		[workspaceId, locale],
	);

	useEffect(() => {
		void refreshStatus();
	}, [refreshStatus]);

	useEffect(() => {
		workspaceRef.current = workspaceId;
		readTokenRef.current += 1;
		setStatus(null);
		setStatusError(null);
		setStatusLoading(true);
		setUpdatedAt(null);
		setSelectedPath(null);
		setDiff(null);
		setFileDialog(null);
		setCommitMessage("");
		setCommitNotice(null);
		setActionError(null);
	}, [workspaceId]);

	// Atualiza quando a sessão fica ociosa; nada de polling contínuo.
	useEffect(() => {
		let timer: number | undefined;
		const unsubscribe = subscribe(event => {
			if (event.workspaceId !== workspaceId) return;
			if (!gitStatusSettledEvent(event)) return;
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = undefined;
				void refreshStatus(true);
			}, 600);
		});
		return () => {
			unsubscribe();
			window.clearTimeout(timer);
		};
	}, [workspaceId, refreshStatus]);

	const files = useMemo(() => (status ? sortGitFiles(status.files, locale) : []), [status, locale]);
	const selectedFile = useMemo(
		() => (selectedPath ? (status?.files.find(file => file.path === selectedPath) ?? null) : null),
		[selectedPath, status],
	);
	const selectedDisplay = selectedFile ? describeGitFile(selectedFile, locale) : null;
	const stagedCount = files.filter(file => describeGitFile(file, locale).staged).length;

	useEffect(() => {
		if (!selectedPath || !status?.isRepo) {
			setDiff(null);
			setDiffError(null);
			setDiffLoading(false);
			return;
		}
		let cancelled = false;
		setDiffLoading(true);
		setDiffError(null);
		invoke({ op: "git.diff", workspaceId, path: selectedPath, source })
			.then(raw => {
				if (cancelled) return;
				setDiff(normalizeGitDiff(raw, selectedPath, source));
			})
			.catch(error => {
				if (cancelled) return;
				setDiff(null);
				setDiffError(errorText(error, locale));
			})
			.finally(() => {
				if (!cancelled) setDiffLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId, selectedPath, source, refreshTick, status?.isRepo, locale]);

	const changeStage = async (file: GitFileStatus, mode: "stage" | "unstage") => {
		setBusyPath(file.path);
		setActionError(null);
		try {
			await invoke({
				op: mode === "stage" ? "git.stage" : "git.unstage",
				workspaceId,
				paths: [file.path],
			});
			await refreshStatus(true);
		} catch (error) {
			setActionError(
				mode === "stage"
					? t("changes.stageFailed", { path: file.path, error: errorText(error, locale) })
					: t("changes.unstageFailed", { path: file.path, error: errorText(error, locale) }),
			);
		} finally {
			setBusyPath(null);
		}
	};

	const commit = async () => {
		const message = commitMessage.trim();
		if (!message) {
			setCommitNotice({ level: "error", text: t("changes.commitMessageRequired") });
			return;
		}
		setCommitBusy(true);
		setCommitNotice(null);
		setActionError(null);
		try {
			const raw = await invoke({ op: "git.commit", workspaceId, message });
			const data = unwrapRpcData(raw);
			const hash = commitHashFrom(data);
			setCommitMessage("");
			setCommitNotice({
				level: "success",
				text: hash ? t("changes.commitCreatedHash", { hash }) : t("changes.commitCreated"),
			});
			await refreshStatus(true);
		} catch (error) {
			const code = errorCode(error);
			setCommitNotice({
				level: "error",
				text: code
					? t("changes.commitFailedCode", { code, error: errorText(error, locale) })
					: t("changes.commitFailed", { error: errorText(error, locale) }),
			});
		} finally {
			setCommitBusy(false);
		}
	};

	const openReadOnly = async (path: string) => {
		const token = readTokenRef.current + 1;
		readTokenRef.current = token;
		setFileDialogLoading(true);
		setFileDialog({ title: path, content: "", truncated: false, binary: false });
		try {
			const raw = await invoke({ op: "files.read", workspaceId, path });
			if (readTokenRef.current !== token) return;
			const view = normalizeFileRead(raw, locale);
			setFileDialog({ ...view, title: path });
		} catch (error) {
			if (readTokenRef.current !== token) return;
			setFileDialog({ title: path, content: "", truncated: false, binary: false, error: errorText(error, locale) });
		} finally {
			if (readTokenRef.current === token) setFileDialogLoading(false);
		}
	};

	const closeFileDialog = useCallback(() => {
		readTokenRef.current += 1;
		setFileDialog(null);
	}, []);

	const openExternal = async (path: string) => {
		setExternalBusy(true);
		setActionError(null);
		try {
			await invoke({ op: "files.openExternal", workspaceId, path });
		} catch (error) {
			setActionError(t("changes.openExternalFailed", { path, error: errorText(error, locale) }));
		} finally {
			setExternalBusy(false);
		}
	};

	const fileDialogOpen = fileDialog !== null;
	const [notRepoBefore, notRepoAfter] = t("changes.notRepoBody").split("{command}");

	useEffect(() => {
		if (!fileDialogOpen) return;
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const node = dialogRef.current;
		const focusable = () =>
			Array.from(
				node?.querySelectorAll<HTMLElement>(
					'button:not([disabled]), [href], textarea, input, select, [tabindex]:not([tabindex="-1"])',
				) ?? [],
			);
		focusable()[0]?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeFileDialog();
				return;
			}
			if (event.key !== "Tab") return;
			const items = focusable();
			if (items.length === 0) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			previous?.focus();
		};
	}, [fileDialogOpen, closeFileDialog]);

	return (
		<aside className="omp-changes-panel" aria-label={t("changes.panelLabel")}>
			<header className="omp-changes-head">
				<div>
					<h2>{t("shell.changesTab")}</h2>
					<p className="omp-muted">
						{status ? statusSummary(status, locale) : t("changes.loadingStatus")}
						{status?.branch ? ` · ${status.branch}` : ""}
					</p>
				</div>
				<div className="omp-changes-head-actions">
					{updatedAt ? (
						<span className="omp-muted" title={t("changes.updatedAt")}>
							{formatDateTime(updatedAt, locale)}
						</span>
					) : null}
					<button
						type="button"
						className="omp-button omp-button-small"
						onClick={() => void refreshStatus()}
						disabled={statusLoading}
					>
						{statusLoading ? t("changes.refreshing") : t("common.refresh")}
					</button>
				</div>
			</header>

			{actionError ? (
				<div className="omp-message omp-message-error" role="alert">
					<StatusIcon kind="error" />
					<span>{actionError}</span>
					<button type="button" className="omp-icon-button" onClick={() => setActionError(null)} aria-label={t("common.dismissError")}>
						×
					</button>
				</div>
			) : null}

			{statusError ? (
				<div className="omp-message omp-message-error" role="alert">
					<StatusIcon kind="error" />
					<span>{t("changes.statusError", { error: statusError })}</span>
					<button type="button" className="omp-button omp-button-small" onClick={() => void refreshStatus()}>
						{t("common.retry")}
					</button>
				</div>
			) : null}

			{statusLoading && !status ? (
				<p className="omp-muted" role="status">
					{t("changes.querying")}
				</p>
			) : null}

			{status && !status.isRepo ? (
				<div className="omp-changes-empty">
					<StatusIcon kind="info" size={20} />
					<h3>{t("changes.notRepoTitle")}</h3>
					<p className="omp-muted">
						{notRepoBefore}
						<code>git init</code>
						{notRepoAfter}
					</p>
				</div>
			) : null}

			{status?.isRepo ? (
				<div className="omp-changes-grid">
					<section className="omp-changes-files" aria-label={t("changes.filesLabel")}>
						{!status.hasHead ? (
							<p className="omp-message omp-message-warning" role="status">
								<StatusIcon kind="warning" /> {t("changes.noHead")}
							</p>
						) : null}
						{files.length === 0 ? (
							<div className="omp-changes-empty">
								<StatusIcon kind="empty" size={20} />
								<p>{t("changes.noChanges")}</p>
							</div>
						) : (
							<ul className="omp-files-list">
								{files.map(file => {
									const view = describeGitFile(file, locale);
									const isSelected = file.path === selectedPath;
									return (
										<li key={file.path} className={isSelected ? "is-selected" : undefined}>
											<button
												type="button"
												className="omp-file-main"
												aria-pressed={isSelected}
												onClick={() => setSelectedPath(file.path)}
												title={displayPath(view)}
											>
												<span className={`omp-file-label omp-tone-${view.tone}`}>
													{view.label}
												</span>
												<span className="omp-file-path">{displayPath(view)}</span>
												<span className="omp-file-badges">
													{view.staged ? <span className="omp-badge">{t("changes.staged")}</span> : null}
													{view.unstaged ? <span className="omp-badge">{t("changes.unstaged")}</span> : null}
													{view.isBinary ? <span className="omp-badge">{t("changes.binary")}</span> : null}
												</span>
											</button>
											<div className="omp-file-actions">
												{view.unstaged ? (
													<button
														type="button"
														className="omp-button omp-button-small"
														disabled={busyPath !== null}
														onClick={() => void changeStage(file, "stage")}
													>
														{busyPath === file.path ? t("changes.staging") : t("changes.stage")}
													</button>
												) : null}
												{view.staged ? (
													<button
														type="button"
														className="omp-button omp-button-small"
														disabled={busyPath !== null}
														onClick={() => void changeStage(file, "unstage")}
													>
														{busyPath === file.path ? t("changes.unstaging") : t("changes.unstage")}
													</button>
												) : null}
											</div>
										</li>
									);
								})}
							</ul>
						)}
					</section>

					<section className="omp-diff-section" aria-label={t("changes.diffLabel")}>
						<div className="omp-diff-toolbar">
							<div className="omp-segmented" role="group" aria-label={t("changes.diffBase")}>
								<button
									type="button"
									aria-pressed={source === "working"}
									onClick={() => setSource("working")}
								>
									{t("changes.workingTree")}
								</button>
								<button
									type="button"
									aria-pressed={source === "index"}
									onClick={() => setSource("index")}
								>
									{t("changes.index")}
								</button>
							</div>
							<div className="omp-row">
								<button
									type="button"
									className="omp-button omp-button-small"
									aria-pressed={sideBySide}
									onClick={() => setSideBySide(value => !value)}
								>
									{sideBySide ? t("changes.inlineDiff") : t("changes.sideBySide")}
								</button>
								{selectedPath ? (
									<>
										<button
											type="button"
											className="omp-button omp-button-small"
											onClick={() => void openReadOnly(selectedPath)}
										>
											{t("changes.openReadOnly")}
										</button>
										<button
											type="button"
											className="omp-button omp-button-small"
											onClick={() => void openExternal(selectedPath)}
											disabled={externalBusy}
										>
											{externalBusy ? t("changes.opening") : t("changes.externalEditor")}
										</button>
									</>
								) : null}
							</div>
						</div>

						{selectedDisplay ? (
							<p className="omp-diff-title">
								<strong>{selectedDisplay.path}</strong>
								{selectedDisplay.renamedFrom ? (
									<span className="omp-muted"> {t("changes.renamedFrom", { path: selectedDisplay.renamedFrom })}</span>
								) : null}
								<span className="omp-muted"> · {source === "index" ? t("changes.index") : t("changes.workingTree")}</span>
							</p>
						) : (
							<p className="omp-muted">{t("changes.selectFile")}</p>
						)}

						{!selectedPath ? (
							<div className="omp-changes-empty">
								<StatusIcon kind="empty" size={20} />
								<p>{t("changes.noDiffYet")}</p>
							</div>
						) : diffError ? (
							<div className="omp-message omp-message-error" role="alert">
								<StatusIcon kind="error" />
								<span>{diffError}</span>
								<button
									type="button"
									className="omp-button omp-button-small"
									onClick={() => setRefreshTick(value => value + 1)}
								>
									{t("common.retry")}
								</button>
							</div>
						) : diffLoading ? (
							<p className="omp-muted" role="status">
								{t("changes.loadingDiff")}
							</p>
						) : diff?.binary ? (
							<div className="omp-changes-empty">
								<StatusIcon kind="warning" size={20} />
								<p>{t("changes.binaryDiffTitle")}</p>
								<p className="omp-muted">{t("changes.binaryDiffHint")}</p>
							</div>
						) : diff ? (
							<>
								{diff.truncated ? (
									<p className="omp-message omp-message-warning" role="status">
										<StatusIcon kind="warning" /> {t("changes.diffTruncated")}
									</p>
								) : null}
								{diff.original === "" && diff.modified === "" ? (
									<p className="omp-muted">{t("changes.noTextDiff")}</p>
								) : null}
								<div className="omp-diff-editor" key={`${selectedPath}:${source}`}>
									<DiffEditor
										theme={theme}
										language={diffLanguageFor(selectedPath)}
										original={diff.original}
										modified={diff.modified}
										height="100%"
										options={{
											readOnly: true,
											originalEditable: false,
											renderSideBySide: sideBySide,
											renderOverviewRuler: false,
											minimap: { enabled: false },
											scrollBeyondLastLine: false,
											automaticLayout: true,
											fontSize: 12,
											fontFamily: "Cascadia Code, Consolas, monospace",
											lineNumbersMinChars: 3,
											wordWrap: "off",
										}}
									/>
								</div>
							</>
						) : null}
					</section>

					<section className="omp-commit" aria-labelledby="omp-commit-title">
						<header className="omp-section-head">
							<h3 id="omp-commit-title">{t("changes.commitTitle")}</h3>
							<span className="omp-muted">
								{stagedCount === 0
									? t("changes.noStaged")
									: stagedCount === 1
										? t("changes.stagedOne")
										: t("changes.stagedMany", { count: stagedCount })}
							</span>
						</header>
						<label className="omp-field">
							<span>{t("changes.commitMessage")}</span>
							<textarea
								rows={2}
								value={commitMessage}
								onChange={event => setCommitMessage(event.target.value)}
								placeholder={t("changes.commitPlaceholder")}
								disabled={commitBusy}
								maxLength={20_000}
							/>
						</label>
						<div className="omp-row">
							<button
								type="button"
								className="omp-button omp-button-primary"
								onClick={() => void commit()}
								disabled={commitBusy || commitMessage.trim().length === 0}
							>
								{commitBusy ? t("changes.committing") : t("changes.commit")}
							</button>
							<span className="omp-hint">{t("changes.commitHint")}</span>
						</div>
						{commitNotice ? (
							<p
								className={`omp-message omp-message-${commitNotice.level}`}
								role={commitNotice.level === "error" ? "alert" : "status"}
							>
								<StatusIcon kind={commitNotice.level === "success" ? "success" : "error"} />
								<span>{commitNotice.text}</span>
							</p>
						) : null}
					</section>
				</div>
			) : null}

			{fileDialog ? (
				<div className="omp-modal-backdrop" role="presentation" onMouseDown={closeFileDialog}>
					<div
						ref={dialogRef}
						className="omp-file-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="omp-file-dialog-title"
						onMouseDown={event => event.stopPropagation()}
					>
						<header className="omp-file-dialog-head">
							<div>
								<h2 id="omp-file-dialog-title">{fileDialog.title}</h2>
								<p className="omp-muted">
									{t("changes.readOnlyView")}
									{fileDialog.size !== undefined ? ` · ${formatBytes(fileDialog.size, locale) ?? ""}` : ""}
								</p>
							</div>
							<div className="omp-row">
								<button
									type="button"
									className="omp-button omp-button-small"
									onClick={() => void openExternal(fileDialog.title)}
									disabled={externalBusy}
								>
									{externalBusy ? t("changes.opening") : t("changes.openExternal")}
								</button>
								<button type="button" className="omp-button omp-button-small" onClick={closeFileDialog}>
									{t("common.close")}
								</button>
							</div>
						</header>
						{actionError && fileDialog ? (
							<p className="omp-message omp-message-error" role="alert">
								<StatusIcon kind="error" /> {actionError}
							</p>
						) : null}
						{fileDialogLoading ? <p className="omp-muted">{t("changes.readingFile")}</p> : null}
						{fileDialog.error ? (
							<p className="omp-message omp-message-error" role="alert">
								<StatusIcon kind="error" /> {fileDialog.error}
							</p>
						) : null}
						{fileDialog.binary ? (
							<p className="omp-message omp-message-warning" role="status">
								<StatusIcon kind="warning" /> {t("changes.binaryContent")}
							</p>
						) : null}
						{fileDialog.truncated ? (
							<p className="omp-message omp-message-warning" role="status">
								<StatusIcon kind="warning" /> {t("changes.fileTruncated")}
							</p>
						) : null}
						{!fileDialog.binary && !fileDialog.error ? (
							<pre className="omp-file-content" tabIndex={0} aria-label={t("changes.fileContentLabel")}>
								{fileDialogLoading ? "" : fileDialog.content || t("changes.emptyFile")}
							</pre>
						) : null}
					</div>
				</div>
			) : null}
		</aside>
	);
}

export default ChangesPanel;
