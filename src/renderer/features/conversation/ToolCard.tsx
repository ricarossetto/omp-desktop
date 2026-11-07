import { useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n, useT, type MessageKey } from "../../i18n";
import type { ToolExecution } from "@shared/session-types";

const COLLAPSED_CHARS = 4_000;
const PAGE_CHARS = 20_000;

function stringifyArguments(value: unknown): string {
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** Resumo curto do argumento principal, para a linha do cabeçalho. */
export function toolSummary(tool: ToolExecution): string {
	const args = tool.arguments;
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		for (const key of ["intent", "description", "command", "path", "file_path", "pattern", "query", "url"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) {
				const single = value.replace(/\s+/g, " ").trim();
				return single.length > 120 ? `${single.slice(0, 117)}…` : single;
			}
		}
	}
	if (typeof args === "string") {
		const single = args.replace(/\s+/g, " ").trim();
		return single.length > 120 ? `${single.slice(0, 117)}…` : single;
	}
	return tool.intent ?? "";
}

/** Diff de uma edição: `details.diff` do OMP ou os `edits[].diff` dos argumentos. */
export function toolDiff(tool: ToolExecution): string | null {
	const details = tool.details;
	if (details && typeof details === "object") {
		const diff = (details as Record<string, unknown>).diff;
		if (typeof diff === "string" && diff.trim()) return diff;
	}
	const args = tool.arguments;
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		if (typeof record.diff === "string" && record.diff.trim()) return record.diff;
		if (Array.isArray(record.edits)) {
			const parts = record.edits
				.map((edit) => (edit && typeof edit === "object" ? (edit as Record<string, unknown>).diff : undefined))
				.filter((diff): diff is string => typeof diff === "string" && diff.trim().length > 0);
			if (parts.length > 0) return parts.join("\n");
		}
	}
	return null;
}

function diffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

const DIFF_PREVIEW_LINES = 400;

function DiffView({ diff }: { diff: string }) {
	const t = useT();
	const { formatNumber } = useI18n();
	const lines = diff.replace(/\n$/, "").split("\n");
	const shown = lines.slice(0, DIFF_PREVIEW_LINES);
	return (
		<div className="tool-diff" role="region" aria-label={t("tool.diffLabel")}>
			{shown.map((line, index) => {
				const kind = line.startsWith("@@")
					? "hunk"
					: line.startsWith("+") && !line.startsWith("+++")
						? "add"
						: line.startsWith("-") && !line.startsWith("---")
							? "del"
							: "ctx";
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: linhas do diff não têm identidade própria
					<div key={index} className={`tool-diff__line tool-diff__line--${kind}`}>
						<span className="tool-diff__sign" aria-hidden="true">
							{kind === "add" ? "+" : kind === "del" ? "−" : " "}
						</span>
						<span className="tool-diff__text">{kind === "add" || kind === "del" ? line.slice(1) : line}</span>
					</div>
				);
			})}
			{lines.length > shown.length ? (
				<div className="tool-diff__more muted text-xs">
					{t("tool.moreLines", { count: formatNumber(lines.length - shown.length) ?? lines.length - shown.length })}
				</div>
			) : null}
		</div>
	);
}

const STATUS_KEYS: Record<ToolExecution["status"], MessageKey> = {
	running: "tool.running",
	done: "tool.done",
	error: "tool.error",
};

export function ToolStatus({ status }: { status: ToolExecution["status"] }) {
	const t = useT();
	return (
		<span className={`tool-status tool-status--${status}`}>
			{status === "running" ? (
				<span className="ring" aria-hidden="true" />
			) : (
				<Icon name={status === "error" ? "error" : "check"} className="icon--sm" />
			)}
			{t(STATUS_KEYS[status])}
		</span>
	);
}

export function ToolCard({ tool }: { tool: ToolExecution }) {
	const t = useT();
	const { formatNumber } = useI18n();
	const [showAll, setShowAll] = useState(false);
	const [pages, setPages] = useState(1);
	const [copied, setCopied] = useState(false);

	const result = tool.resultText ?? "";
	const partial = tool.partialText ?? "";
	const body = result || partial;
	const visible = showAll ? body.slice(0, pages * PAGE_CHARS) : body.slice(0, COLLAPSED_CHARS);
	const remaining = body.length - visible.length;
	const summary = toolSummary(tool);
	const argsText = stringifyArguments(tool.arguments);
	const diff = tool.status === "error" ? null : toolDiff(tool);
	const stats = diff ? diffStats(diff) : null;
	// Rodando, com erro ou com diff curto: aberto. Concluído sem diff: recolhido, como no protótipo.
	const startOpen = tool.status !== "done" || (diff !== null && diff.split("\n").length <= 60);
	const [open, setOpen] = useState(startOpen);

	const copyResult = () => {
		void navigator.clipboard.writeText(body).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1600);
		});
	};

	return (
		<details
			className={`tool-card tool-card--${tool.status}`}
			open={open}
			onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
		>
			<summary className="tool-card__header">
				<ToolStatus status={tool.status} />
				<span className="tool-card__cmd mono" title={summary || tool.name}>
					{tool.name}
					{summary ? <span className="tool-card__summary"> {summary}</span> : null}
				</span>
				<span className="tool-card__right">
					{stats ? (
						<span
							className="tool-card__stats mono"
							aria-label={t("tool.diffStats", {
								added: formatNumber(stats.added) ?? stats.added,
								removed: formatNumber(stats.removed) ?? stats.removed,
							})}
						>
							<span className="tool-card__add">+{stats.added}</span> <span className="tool-card__del">−{stats.removed}</span>
						</span>
					) : null}
					<Icon name="chevron-right" className="icon--sm tool-card__chev" />
				</span>
			</summary>

			{tool.intent && tool.intent !== summary ? <p className="tool-card__intent">{tool.intent}</p> : null}

			{diff ? <DiffView diff={diff} /> : null}

			{body && !diff ? (
				<div className={`tool-card__output${tool.status === "error" ? " tool-card__output--error" : ""}`}>
					<pre className="tool-card__pre">{visible}</pre>
					{remaining > 0 ? (
						<div className="tool-card__more">
							<button
								type="button"
								className="btn btn--sm btn--ghost"
								onClick={() => {
									if (!showAll) {
										setShowAll(true);
										setPages(1);
									} else {
										setPages((value) => value + 1);
									}
								}}
							>
								{showAll
									? t("tool.showMore", { remaining: formatNumber(remaining) ?? remaining })
									: t("tool.showFull", { total: formatNumber(body.length) ?? body.length })}
							</button>
						</div>
					) : null}
					{showAll && remaining === 0 && body.length > COLLAPSED_CHARS ? (
						<div className="tool-card__more">
							<button type="button" className="btn btn--sm btn--ghost" onClick={() => setShowAll(false)}>
								{t("tool.collapse")}
							</button>
						</div>
					) : null}
				</div>
			) : null}

			{tool.resultTruncated ? (
				<p className="tool-card__truncated">
					<Icon name="warning" className="icon--sm" /> {t("tool.truncated")}
				</p>
			) : null}

			<div className="tool-card__foot">
				{result ? (
					<button type="button" className="btn btn--sm btn--ghost" onClick={copyResult}>
						<Icon name={copied ? "check" : "copy"} className="icon--sm" />
						{copied ? t("common.copied") : t("tool.copyResult")}
					</button>
				) : null}
				{argsText ? (
					<details className="tool-card__details">
						<summary>{t("tool.arguments")}</summary>
						<pre className="tool-card__pre">{argsText}</pre>
					</details>
				) : null}
				{tool.details && !diff ? (
					<details className="tool-card__details">
						<summary>{t("tool.details")}</summary>
						<pre className="tool-card__pre">{stringifyArguments(tool.details)}</pre>
					</details>
				) : null}
			</div>
		</details>
	);
}
