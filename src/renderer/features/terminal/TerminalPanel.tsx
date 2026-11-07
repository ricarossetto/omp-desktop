import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, subscribe } from "../../api";
import { useI18n, useT, type MessageKey } from "../../i18n";
import { StatusIcon } from "../agents/StatusIcon";
import { errorText, isRecord, unwrapRpcData } from "../agents/ui-utils";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

type TerminalPhase = "creating" | "ready" | "exited" | "error";

type TerminalMessage = { key: MessageKey; error?: unknown; code?: number };

function terminalTheme() {
	const styles =
		typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
	const read = (name: string, fallback: string) => {
		const value = styles?.getPropertyValue(name).trim();
		return value ? value : fallback;
	};
	const accent = read("--accent", "#83B4E8");
	return {
		background: read("--panel", "#191C1F"),
		foreground: read("--text", "#E6E8EA"),
		cursor: accent,
		cursorAccent: read("--bg", "#111315"),
		selectionBackground: read("--border", "#32383F"),
		black: read("--bg", "#111315"),
		red: read("--error", "#F07A7A"),
		green: read("--success", "#6FCF97"),
		yellow: read("--warning", "#E6B450"),
		blue: accent,
		magenta: "#B79BE0",
		cyan: "#72C7C7",
		white: read("--text", "#E6E8EA"),
		brightBlack: read("--muted", "#A4AAB2"),
		brightRed: "#F09A9A",
		brightGreen: "#86D3A8",
		brightYellow: "#EDC97E",
		brightBlue: "#A6CBF0",
		brightMagenta: "#CDB9EA",
		brightCyan: "#96D9D9",
		brightWhite: "#F7F8FA",
	};
}

function createId(raw: unknown): string | undefined {
	const value = unwrapRpcData(raw);
	if (isRecord(value) && typeof value.terminalId === "string" && value.terminalId) return value.terminalId;
	if (typeof value === "string" && value) return value;
	return undefined;
}

export function TerminalPanel({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
	const t = useT();
	const { locale } = useI18n();
	const hostRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const terminalIdRef = useRef<string | null>(null);
	const closingRef = useRef(false);
	const writeErrorRef = useRef(false);
	const [phase, setPhase] = useState<TerminalPhase>("creating");
	const [message, setMessage] = useState<TerminalMessage | null>(null);
	const [retryTick, setRetryTick] = useState(0);
	const [closing, setClosing] = useState(false);
	const tRef = useRef(t);
	useEffect(() => {
		tRef.current = t;
	}, [t]);

	const closeTerminal = useCallback(async () => {
		if (closingRef.current) return;
		closingRef.current = true;
		setClosing(true);
		const id = terminalIdRef.current;
		terminalIdRef.current = null;
		let failed = false;
		if (id) {
			try {
				await invoke({ op: "terminal.close", terminalId: id });
			} catch {
				// O processo já pode ter saído; o cleanup tenta novamente se ainda houver id local.
				failed = true;
			}
		}
		if (failed) {
			closingRef.current = false;
			setClosing(false);
		}
		onClose();
	}, [onClose]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let disposed = false;
		let exited = false;
		let terminalId: string | null = null;
		let unsubscribe: () => void = () => {};
		let frame = 0;
		let observer: ResizeObserver | null = null;
		writeErrorRef.current = false;
		closingRef.current = false;
		setClosing(false);
		setPhase("creating");
		setMessage(null);

		const term = new Terminal({
			convertEol: false,
			cursorBlink: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
			fontFamily: "Cascadia Code, Consolas, monospace",
			fontSize: 12,
			lineHeight: 1.2,
			scrollback: 5000,
			theme: terminalTheme(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		terminalRef.current = term;
		fitRef.current = fit;
		host.replaceChildren();
		term.open(host);

		const resize = () => {
			try {
				fit.fit();
			} catch {
				return;
			}
			if (!terminalId || disposed) return;
			void invoke({
				op: "terminal.resize",
				terminalId,
				cols: term.cols,
				rows: term.rows,
			}).catch(() => {
				// Redimensionamento é best-effort; o terminal continua utilizável.
			});
		};

		const scheduleResize = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(resize);
		};

		term.onData(data => {
			if (!terminalId || disposed || exited) return;
			void invoke({ op: "terminal.write", terminalId, data }).catch(error => {
				if (disposed || writeErrorRef.current) return;
				writeErrorRef.current = true;
				setMessage({ key: "terminal.writeFailed", error });
			});
		});

		unsubscribe = subscribe(event => {
			if (event.workspaceId !== workspaceId) return;
			if (event.name !== "terminal.data" && event.name !== "terminal.exit") return;
			if (!isRecord(event.data)) return;
			if (typeof event.data.terminalId !== "string" || event.data.terminalId !== terminalId) return;
			if (event.name === "terminal.data") {
				if (typeof event.data.data === "string") term.write(event.data.data);
				return;
			}
			const code =
				typeof event.data.exitCode === "number"
					? event.data.exitCode
					: typeof event.data.code === "number"
						? event.data.code
						: undefined;
			exited = true;
			setPhase("exited");
			setMessage(
				code === undefined
					? { key: "terminal.exited" }
					: { key: "terminal.exitedCode", code },
			);
			term.write(
				`\r\n\x1b[2m${
					code === undefined
						? tRef.current("terminal.processClosed")
						: tRef.current("terminal.processClosedCode", { code })
				}\x1b[0m\r\n`,
			);
		});

		invoke({ op: "terminal.create", workspaceId })
			.then(raw => {
				const id = createId(raw);
				if (disposed) {
					if (id) void invoke({ op: "terminal.close", terminalId: id }).catch(() => {});
					return;
				}
				if (!id) {
					setPhase("error");
					setMessage({ key: "terminal.missingId" });
					return;
				}
				terminalId = id;
				terminalIdRef.current = id;
				setPhase("ready");
				terminalRef.current?.focus();
				scheduleResize();
			})
			.catch(error => {
				if (disposed) return;
				setPhase("error");
				setMessage({ key: "terminal.openFailed", error });
			});

		observer = new ResizeObserver(scheduleResize);
		observer.observe(host);
		scheduleResize();

		const themeObserver = new MutationObserver(() => {
			term.options.theme = terminalTheme();
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-theme", "style"],
		});
		if (document.body) {
			themeObserver.observe(document.body, {
				attributes: true,
				attributeFilter: ["class", "data-theme", "style"],
			});
		}

		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			observer?.disconnect();
			themeObserver.disconnect();
			unsubscribe();
			if (terminalId && !closingRef.current) {
				void invoke({ op: "terminal.close", terminalId }).catch(() => {});
				if (terminalIdRef.current === terminalId) terminalIdRef.current = null;
			}
			term.dispose();
			terminalRef.current = null;
			fitRef.current = null;
		};
	}, [workspaceId, retryTick]);

	const statusLabel =
		phase === "ready"
			? t("terminal.connected")
			: phase === "creating"
				? t("terminal.opening")
				: phase === "exited"
					? t("terminal.exitedState")
					: t("terminal.failed");

	return (
		<section className="omp-terminal" aria-label={t("terminal.panelLabel")}>
			<header className="omp-terminal-head">
				<div className="omp-terminal-title">
					<StatusIcon
						kind={phase === "error" ? "error" : phase === "exited" ? "aborted" : "success"}
					/>
					<h2>{t("terminal.title")}</h2>
					<span className={`omp-terminal-state omp-terminal-${phase}`}>{statusLabel}</span>
				</div>
				<div className="omp-terminal-actions">
					{phase === "error" ? (
						<button
							type="button"
							className="omp-button omp-button-small"
							onClick={() => setRetryTick(value => value + 1)}
						>
							{t("common.retry")}
						</button>
					) : null}
					<span className="omp-muted">{t("terminal.ctrlC")}</span>
					<button
						type="button"
						className="omp-button omp-button-small"
						onClick={() => void closeTerminal()}
						disabled={closing}
					>
						{closing ? t("terminal.closing") : t("terminal.close")}
					</button>
				</div>
			</header>

			{message ? (
				<p
					className={`omp-terminal-message${phase === "error" ? " is-error" : ""}`}
					role={phase === "error" ? "alert" : "status"}
				>
					<StatusIcon kind={phase === "error" ? "error" : "info"} />{" "}
					{t(message.key, {
						error: errorText(message.error, locale),
						code: message.code ?? 0,
					})}
				</p>
			) : null}

			<div
				ref={hostRef}
				className="omp-terminal-host"
				role="application"
				aria-label={t("terminal.interactiveLabel")}
			/>
		</section>
	);
}

export default TerminalPanel;
