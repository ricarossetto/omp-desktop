import type { RestoredImage } from "../features/conversation/composer-policy";

/** Recorte da fila que interessa às regras de edição/remoção. */
export interface QueueState {
	steering: string[];
	followUp: string[];
	liveSteered: number;
}

function liveSteeredCount(queue: QueueState): number {
	const value = Number.isFinite(queue.liveSteered) ? Math.trunc(queue.liveSteered) : 0;
	return Math.max(0, value);
}

/**
 * Entradas de steering com índice abaixo de `liveSteered` já foram entregues
 * ao agente; removê-las ou editá-las prometeria algo que o OMP não desfaz.
 */
export function isLiveSteered(queue: QueueState, name: "steering" | "followUp", index: number): boolean {
	if (name !== "steering") return false;
	return index >= 0 && index < liveSteeredCount(queue);
}

/** Índice de uma mensagem removível; a região já entregue ao agente é preservada. */
export function removableIndexOf(
	queue: QueueState,
	name: "steering" | "followUp",
	message: string,
): number {
	const list = queue[name];
	const from = name === "steering" ? Math.min(liveSteeredCount(queue), list.length) : 0;
	return list.indexOf(message, from);
}

/**
 * Imagens devolvidas por `remove_queued_message` (formato `ImageContent` do
 * OMP). O host precisa reimportá-las como anexos para o rascunho não perder
 * a imagem que acompanhava a mensagem removida.
 */
export function parseQueueImages(value: unknown): RestoredImage[] {
	if (!value || typeof value !== "object") return [];
	const root = value as Record<string, unknown>;
	const raw = Array.isArray(root.images) ? root.images : [];
	const images: RestoredImage[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const candidate = item as Record<string, unknown>;
		if (typeof candidate.data !== "string" || candidate.data.length === 0) continue;
		images.push({
			mimeType:
				typeof candidate.mimeType === "string" && candidate.mimeType.length > 0
					? candidate.mimeType
					: "image/png",
			data: candidate.data,
		});
	}
	return images;
}

/** O OMP sinaliza que removeu a mensagem mas omitiu as imagens por tamanho. */
export function queueImagesDropped(value: unknown): boolean {
	return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).imagesDropped === true);
}

/** `promote_queued_message` só move a mensagem quando o OMP confirma. */
export function parsePromoted(value: unknown): boolean | null {
	if (!value || typeof value !== "object") return null;
	const promoted = (value as Record<string, unknown>).promoted;
	return typeof promoted === "boolean" ? promoted : null;
}

/** `navigate_tree` devolve `editorText` quando o alvo é uma mensagem do usuário. */
export function parseEditorText(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	const text = (value as Record<string, unknown>).editorText;
	return typeof text === "string" && text.trim().length > 0 ? text : null;
}
