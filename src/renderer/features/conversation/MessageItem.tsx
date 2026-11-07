import { memo, useState, type ReactNode } from "react";
import type { ChatMessage, ContentBlock, ToolExecution } from "@shared/session-types";
import { Icon } from "../../components/Icon";
import { formatClock, formatModelLabel } from "../../format";
import { useI18n, useT } from "../../i18n";
import { Markdown } from "./Markdown";
import { ToolCard, ToolStatus } from "./ToolCard";

export type MessageAction = "rewind" | "fork";

export interface MessageItemProps {
	message: ChatMessage;
	tools: Record<string, ToolExecution>;
	onOpenLink: (href: string) => void;
	onMessageAction: (message: ChatMessage, action: MessageAction) => void;
}

function ImageBlock({ block }: { block: Extract<ContentBlock, { type: "image" }> }) {
	const t = useT();
	if (block.omitted || !block.data) {
		return (
			<div className="message__image-missing">
				<Icon name="image" className="icon--sm" /> {t("message.imageOmitted")}
			</div>
		);
	}
	return (
		<img
			className="message__image"
			src={`data:${block.mimeType ?? "image/png"};base64,${block.data}`}
			alt={t("message.imageAlt")}
			loading="lazy"
		/>
	);
}

function ThinkingBlock({ text }: { text: string }) {
	const t = useT();
	if (!text.trim()) return null;
	return (
		<details className="thinking">
			<summary>
				<Icon name="chevron-right" className="icon--sm thinking__chev" /> {t("message.thinking")}
			</summary>
			<div className="thinking__body">{text}</div>
		</details>
	);
}

function BlockView({
	block,
	tools,
	onOpenLink,
}: {
	block: ContentBlock;
	tools: Record<string, ToolExecution>;
	onOpenLink: (href: string) => void;
}): ReactNode {
	const t = useT();
	switch (block.type) {
		case "text":
			return <Markdown text={block.text} onOpenLink={onOpenLink} />;
		case "thinking":
			return <ThinkingBlock text={block.thinking} />;
		case "image":
			return <ImageBlock block={block} />;
		case "toolCall": {
			const execution = tools[block.id];
			return execution ? (
				<ToolCard tool={execution} />
			) : (
				<div className="tool-card tool-card--running tool-card--pending">
					<div className="tool-card__header">
						<ToolStatus status="running" />
						<span className="tool-card__cmd mono">
							{block.name}
							{block.intent ? <span className="tool-card__summary"> {block.intent}</span> : null}
						</span>
					</div>
				</div>
			);
		}
		case "unknown":
			return (
				<details className="message__unknown">
					<summary>{t("message.unknownBlock")}</summary>
					<pre>{JSON.stringify(block.raw, null, 2)}</pre>
				</details>
			);
	}
}

function CopyAction({ text }: { text: string }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="message__action"
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1600);
				});
			}}
		>
			<Icon name={copied ? "check" : "copy"} className="icon--sm" /> {copied ? t("common.copied") : t("common.copy")}
		</button>
	);
}

export const MessageItem = memo(function MessageItem({
	message,
	tools,
	onOpenLink,
	onMessageAction,
}: MessageItemProps) {
	const t = useT();
	const { locale } = useI18n();
	const roleLabel =
		message.role === "user"
			? t("message.you")
			: message.role === "assistant"
				? message.model
					? formatModelLabel({ provider: message.provider ?? "", id: message.model }, locale)
					: t("message.assistant")
				: message.role === "system"
					? t("message.system")
					: message.role === "toolResult"
						? (message.toolName ?? t("message.tool"))
						: t("message.content");

	if (message.role === "toolResult" && message.toolCallId && tools[message.toolCallId]) {
		// O card da ferramenta já mostra resultado/erro desta execução.
		return null;
	}

	const text = message.content
		.filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");

	if (message.role === "toolResult") {
		return (
			<div className={`message message--tool-result${message.isError ? " message--error" : ""}`}>
				<header className="message__header">
					<span className="message__role">{roleLabel}</span>
					<span className="message__time">{formatClock(message.timestamp, locale)}</span>
				</header>
				{message.content.map((block, index) => (
					<BlockView key={index} block={block} tools={tools} onOpenLink={onOpenLink} />
				))}
				{text && !message.content.some((block) => block.type === "text") ? <pre>{text}</pre> : null}
				{message.errorMessage ? (
					<div className="banner banner--error">
						<Icon name="error" />
						<div className="banner__body">{message.errorMessage}</div>
					</div>
				) : null}
			</div>
		);
	}

	const canRewind = Boolean(message.entryId) && !message.streaming && message.role !== "system";
	const isUser = message.role === "user";
	const isSystem = message.role === "system";

	if (isUser) {
		return (
			<article className="message message--user" aria-label={roleLabel}>
				<div className="message__bubble">
					{text ? <div className="message__user-text">{text}</div> : null}
					{message.content.map((block, index) =>
						block.type === "text" ? null : <BlockView key={index} block={block} tools={tools} onOpenLink={onOpenLink} />,
					)}
				</div>
				<div className="message__actions">
					{message.timestamp ? <span className="message__time">{formatClock(message.timestamp, locale)}</span> : null}
					{canRewind ? (
						<button
							type="button"
							className="message__action"
							title={t("message.rewindHint")}
							onClick={() => onMessageAction(message, "rewind")}
						>
							<Icon name="refresh" className="icon--sm" /> {t("message.rewind")}
						</button>
					) : null}
					{canRewind ? (
						<button
							type="button"
							className="message__action"
							title={t("message.forkHint")}
							onClick={() => onMessageAction(message, "fork")}
						>
							<Icon name="git" className="icon--sm" /> {t("message.fork")}
						</button>
					) : null}
					{text ? <CopyAction text={text} /> : null}
				</div>
			</article>
		);
	}

	return (
		<article
			className={`message message--${message.role}${isSystem ? " message--system" : ""}`}
			aria-label={roleLabel}
		>
			{isSystem || message.streaming ? (
				<header className="message__header">
					{isSystem ? <span className="message__role">{roleLabel}</span> : null}
					{message.streaming ? (
						<span className="message__writing">
							<span className="ring" aria-hidden="true" /> {t("message.writing")}
						</span>
					) : null}
				</header>
			) : null}

			<div className="message__body">
				{message.content.map((block, index) => (
					<BlockView key={index} block={block} tools={tools} onOpenLink={onOpenLink} />
				))}
			</div>

			{message.errorMessage ? (
				<div className="banner banner--error message__error" role="alert">
					<Icon name="error" />
					<div className="banner__body">
						<strong>{t("message.failure")}</strong> {message.errorMessage}
					</div>
				</div>
			) : null}
			{message.isError && !message.errorMessage ? (
				<p className="message__error-text">
					<Icon name="warning" className="icon--sm" /> {t("message.executionFailed")}
				</p>
			) : null}
			{canRewind && !message.streaming ? (
				<div className="message__actions message__actions--assistant">
					{message.timestamp ? <span className="message__time">{formatClock(message.timestamp, locale)}</span> : null}
					<span className="message__time">{roleLabel}</span>
					{text ? <CopyAction text={text} /> : null}
				</div>
			) : null}
		</article>
	);
});
