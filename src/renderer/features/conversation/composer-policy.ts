import type { AttachmentDto } from "@shared/contracts";

/** Rascunho por sessão; só é descartado com ack explícito do OMP. */
export interface ComposerDraft {
	text: string;
	attachments: AttachmentDto[];
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = Object.freeze({ text: "", attachments: [] });

export interface SentPayload {
	text: string;
	attachmentIds: readonly string[];
}

/**
 * Aplica o ack de um prompt:
 * - remove apenas os anexos que foram enviados;
 * - limpa o texto somente se o usuário não digitou nada novo enquanto o
 *   envio estava em andamento.
 */
export function settleDraftAfterAck(draft: ComposerDraft, sent: SentPayload): ComposerDraft {
	const sentIds = new Set(sent.attachmentIds);
	const attachments = draft.attachments.filter((item) => !sentIds.has(item.attachmentId));
	const text = draft.text === sent.text ? "" : draft.text;
	if (text === draft.text && attachments.length === draft.attachments.length) return draft;
	return { text, attachments };
}

/** Junta texto restaurado pelo abort sem descartar o que o usuário digitou. */
export function mergeRestoredDraft(current: ComposerDraft, restoredText: string): ComposerDraft {
	const text = restoredText.trim();
	if (!text) return current;
	if (!current.text.trim()) return { ...current, text: restoredText };
	if (current.text.includes(text)) return current;
	return { ...current, text: `${restoredText.replace(/\s+$/, "")}\n${current.text}` };
}

export function appendAttachments(draft: ComposerDraft, items: readonly AttachmentDto[]): ComposerDraft {
	if (items.length === 0) return draft;
	const known = new Set(draft.attachments.map((a) => a.attachmentId));
	const next = [...draft.attachments];
	for (const item of items) {
		if (!known.has(item.attachmentId)) {
			known.add(item.attachmentId);
			next.push(item);
		}
	}
	return next.length === draft.attachments.length ? draft : { ...draft, attachments: next };
}

export function removeAttachment(draft: ComposerDraft, attachmentId: string): ComposerDraft {
	const attachments = draft.attachments.filter((a) => a.attachmentId !== attachmentId);
	return attachments.length === draft.attachments.length ? draft : { ...draft, attachments };
}

export function isComposerEmpty(draft: ComposerDraft): boolean {
	return draft.text.trim().length === 0 && draft.attachments.length === 0;
}

export interface SubmitKey {
	key: string;
	shiftKey?: boolean;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	isComposing?: boolean;
}

/**
 * Enter envia; Shift+Enter quebra linha; composição de IME nunca envia.
 * Ctrl/Cmd+Enter também envia (atalho comum em compositores).
 */
export function shouldSubmitOnKey(event: SubmitKey): boolean {
	if (event.isComposing) return false;
	if (event.key !== "Enter") return false;
	if (event.altKey) return false;
	if (event.ctrlKey || event.metaKey) return true;
	return !event.shiftKey;
}

export interface RestoredImage {
	mimeType: string;
	/** Base64 sem prefixo `data:`. */
	data: string;
}

export interface AbortRestoreOutcome {
	restoredText?: string;
	restoredAttachments: AttachmentDto[];
	/** Imagens cruas devolvidas pelo OMP; o host precisa importá-las como anexos. */
	restoredImages: RestoredImage[];
	truncated: boolean;
	imagesDropped: boolean;
}

/**
 * Lê o resultado de `abort_and_restore_queue` de forma defensiva: o OMP pode
 * devolver o rascunho restaurado em `restored` ou nos campos de nível superior.
 */
export function parseAbortRestore(data: unknown): AbortRestoreOutcome {
	const empty: AbortRestoreOutcome = {
		restoredAttachments: [],
		restoredImages: [],
		truncated: false,
		imagesDropped: false,
	};
	if (!data || typeof data !== "object") return empty;
	const root = data as Record<string, unknown>;
	const restored =
		root.restored && typeof root.restored === "object" ? (root.restored as Record<string, unknown>) : root;

	const textCandidate =
		typeof restored.text === "string"
			? restored.text
			: typeof restored.message === "string"
				? restored.message
				: undefined;

	// Formato real do OMP: { steering: [{text, images?}], followUp: [...] }.
	const queuedTexts: string[] = [];
	const restoredImages: RestoredImage[] = [];
	for (const queueName of ["steering", "followUp"] as const) {
		const queue = restored[queueName];
		if (!Array.isArray(queue)) continue;
		for (const entry of queue) {
			if (!entry || typeof entry !== "object") continue;
			const value = entry as Record<string, unknown>;
			if (typeof value.text === "string" && value.text.trim()) queuedTexts.push(value.text);
			for (const image of Array.isArray(value.images) ? value.images : []) {
				if (!image || typeof image !== "object") continue;
				const candidate = image as Record<string, unknown>;
				if (typeof candidate.data === "string" && candidate.data.length > 0) {
					restoredImages.push({
						mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : "image/png",
						data: candidate.data,
					});
				}
			}
		}
	}

	const rawAttachments = Array.isArray(restored.attachments) ? restored.attachments : [];
	const restoredAttachments: AttachmentDto[] = [];
	for (const item of rawAttachments) {
		if (!item || typeof item !== "object") continue;
		const value = item as Record<string, unknown>;
		if (typeof value.attachmentId !== "string") continue;
		restoredAttachments.push({
			attachmentId: value.attachmentId,
			name: typeof value.name === "string" ? value.name : value.attachmentId,
			mimeType: typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream",
			size: typeof value.size === "number" ? value.size : 0,
			kind: value.kind === "image" || value.kind === "text" || value.kind === "file" ? value.kind : "file",
		});
	}

	return {
		restoredText: textCandidate ?? (queuedTexts.length > 0 ? queuedTexts.join("\n\n") : undefined),
		restoredAttachments,
		restoredImages,
		truncated: root.truncated === true || restored.truncated === true,
		imagesDropped: root.imagesDropped === true || restored.imagesDropped === true,
	};
}
