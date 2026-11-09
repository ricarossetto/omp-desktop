import { useCallback, useState } from "react";
import type { ChatMessage, SessionViewState } from "@shared/session-types";
import { Banner, EmptyState } from "../../components/Banners";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Icon } from "../../components/Icon";
import { useT } from "../../i18n";
import { useActions, useStore } from "../../store/context";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import type { MessageAction } from "./MessageItem";
import "./conversation.css";

export function ConversationView({ view }: { view: SessionViewState }) {
	const t = useT();
	const actions = useActions();
	const resyncing = useStore((state) => state.resyncing[view.sessionId] === true);
	const [pending, setPending] = useState<{ message: ChatMessage; action: MessageAction } | null>(null);
	const [busy, setBusy] = useState(false);

	const handleOpenLink = useCallback(
		(href: string) => {
			if (/^https?:\/\//i.test(href)) {
				void actions.openExternal(href);
				return;
			}
			if (href.startsWith("#")) return;
			const path = href.startsWith("file://") ? href.replace(/^file:\/\//, "") : href;
			void actions.openWorkspaceFile(path);
		},
		[actions],
	);

	const handleMessageAction = useCallback((message: ChatMessage, action: MessageAction) => {
		setPending({ message, action });
	}, []);

	const confirmAction = async () => {
		if (!pending?.message.entryId) return;
		setBusy(true);
		const entryId = pending.message.entryId;
		const ok =
			pending.action === "rewind"
				? await actions.navigateTree(view.sessionId, entryId)
				: await actions.forkSession(view.sessionId, entryId);
		setBusy(false);
		if (ok) setPending(null);
	};

	const notices = view.notices.slice(-3);
	const hasBackgroundWork = view.meta?.isSettled === true && view.meta?.hasPendingAsyncWork === true;

	return (
		<section
			id="omp-conversation-panel"
			role="tabpanel"
			className="conversation"
			aria-label={t("shell.conversation")}
		>
			<div className="conversation__notices">
				{view.status === "starting" ? (
					<Banner level="info" title={t("conversation.startingTitle")}>
						{t("conversation.startingBody")}
					</Banner>
				) : null}
				{resyncing ? (
					<Banner level="info" title={t("conversation.resyncingTitle")}>
						{t("conversation.resyncingBody")}
					</Banner>
				) : null}
				{view.status === "interrupted" ? (
					<Banner
						level="warning"
						title={t("conversation.interruptedTitle")}
						action={
							<button
								type="button"
								className="btn btn--sm"
								onClick={() => actions.restoreInterrupted(view.sessionId)}
							>
								{t("conversation.restorePrompt")}
							</button>
						}
					>
						{t("conversation.interruptedBody")}
					</Banner>
				) : null}
				{hasBackgroundWork ? (
					<Banner level="info" title={t("conversation.backgroundTitle")}>
						{t("conversation.backgroundBody")}
					</Banner>
				) : null}
				{view.error ? (
					<Banner
						level="error"
						title={t("conversation.errorTitle")}
						action={
							<button
								type="button"
								className="btn btn--sm"
								onClick={() => void actions.refreshSnapshot(view.sessionId)}
							>
								{t("common.retry")}
							</button>
						}
					>
						{view.error}
					</Banner>
				) : null}
				{notices.map((notice, index) => (
					<Banner
						key={`${notice.at}:${index}`}
						level={notice.level === "error" ? "error" : notice.level === "warning" ? "warning" : "info"}
					>
						{notice.text}
					</Banner>
				))}
			</div>

			{view.messages.length === 0 && view.status !== "starting" ? (
				<div className="conversation__empty">
					<EmptyState icon="message" title={t("conversation.emptyTitle")}>
						<p>{t("conversation.emptyBody")}</p>
					</EmptyState>
				</div>
			) : (
				<MessageList
					messages={view.messages}
					tools={view.tools}
					onOpenLink={handleOpenLink}
					onMessageAction={handleMessageAction}
				/>
			)}

			{/* Remonta por sessão: pausa, rascunho local e menus não vazam entre abas. */}
			<Composer key={view.sessionId} view={view} />

			{pending ? (
				<ConfirmDialog
					title={pending.action === "rewind" ? t("conversation.rewindTitle") : t("conversation.forkTitle")}
					confirmLabel={pending.action === "rewind" ? t("conversation.rewindConfirm") : t("conversation.forkConfirm")}
					danger={pending.action === "rewind"}
					busy={busy}
					onCancel={() => setPending(null)}
					onConfirm={() => void confirmAction()}
				>
					<div className="stack-2">
						<Banner level="warning" title={t("conversation.filesNotReverted")}>
							{t("conversation.filesNotRevertedBody")}
						</Banner>
						<p className="muted">
							{pending.action === "rewind" ? t("conversation.rewindBody") : t("conversation.forkBody")}
						</p>
						{pending.message.content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map((block) => block.text)
							.join("\n")
							.slice(0, 600) ? (
							<blockquote className="confirm-quote">
								{pending.message.content
									.filter((block): block is { type: "text"; text: string } => block.type === "text")
									.map((block) => block.text)
									.join("\n")
									.slice(0, 600)}
							</blockquote>
						) : null}
					</div>
				</ConfirmDialog>
			) : null}
		</section>
	);
}
