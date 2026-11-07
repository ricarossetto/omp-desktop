import type { SessionStatus, SessionViewState } from "@shared/session-types";

const LOST_STATUS: Record<SessionStatus, boolean> = {
	starting: false,
	ready: false,
	busy: false,
	settled: false,
	interrupted: true,
	closed: true,
	error: true,
};

const DIALOG_METHOD: Record<string, boolean> = {
	select: true,
	confirm: true,
	input: true,
	editor: true,
	ask: true,
};

/** Métodos que o OMP envia apenas como aviso e que não esperam resposta. */
const NOTIFICATION_METHOD: Record<string, boolean> = {
	cancel: true,
	notify: true,
	open_url: true,
	setStatus: true,
	setWidget: true,
	setTitle: true,
	set_editor_text: true,
};

/**
 * Uma sessão fechada, interrompida ou com erro não tem processo OMP capaz de
 * receber respostas. Manter o diálogo na tela só permitiria enviar uma resposta
 * que seria recusada (ou, pior, autorizar algo em uma sessão que já morreu).
 * Removemos os pendentes sem enviar nenhuma resposta.
 */
export function isLostSessionStatus(status: SessionStatus): boolean {
	return LOST_STATUS[status] === true;
}

/** Descarta diálogos pendentes quando o estado já não pode recebê-los. */
export function clearDialogsForLostSession(view: SessionViewState): SessionViewState {
	if (view.pendingDialogs.length === 0 || !isLostSessionStatus(view.status)) return view;
	return { ...view, pendingDialogs: [] };
}

/**
 * Devolve o método de um `extension_ui_request` que esta interface não sabe
 * responder. O host cancela esse pedido antes de encaminhá-lo; o renderer só
 * precisa avisar o usuário, nunca enviar uma segunda resposta.
 */
export function unsupportedDialogMethod(frame: unknown): string | null {
	if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
	const record = frame as Record<string, unknown>;
	if (record.type !== "extension_ui_request") return null;
	const method = typeof record.method === "string" ? record.method : null;
	const id = typeof record.id === "string" ? record.id : null;
	if (!method || !id) return null;
	if (DIALOG_METHOD[method] || NOTIFICATION_METHOD[method]) return null;
	return method;
}
