import type { DesktopEvent } from "@shared/contracts";
import type { SessionViewState } from "@shared/session-types";

/**
 * O que fazer com um evento de sessão antes de aplicá-lo no reducer:
 * - `apply`: evento imediatamente seguinte (ou status sem sequência);
 * - `ignore`: duplicado/fora do escopo ou de outra geração;
 * - `resync`: lacuna de sequência ou processo novo; pedir snapshot;
 * - `replace`: o próprio snapshot (substitui o estado).
 */
export type EventDisposition = "apply" | "ignore" | "resync" | "replace";

/**
 * Decide o destino de um evento. Função pura para permitir teste sem Electron.
 * Eventos de outra geração nunca são aplicados: o processo OMP mudou e o
 * estado antigo não representa mais a sessão.
 */
export function classifySessionEvent(state: SessionViewState, event: DesktopEvent): EventDisposition {
	if (event.workspaceId !== state.workspaceId) return "ignore";
	if (event.sessionId !== undefined && event.sessionId !== state.sessionId) return "ignore";

	if (event.name === "desktop_snapshot") return "replace";

	if (event.name === "session.status") {
		// Status pode chegar antes do primeiro snapshot (generation 0).
		if (state.generation !== 0 && event.generation !== state.generation) return "resync";
		if (event.sequence <= state.sequence) return "ignore";
		return "apply";
	}

	if (event.generation !== state.generation) {
		// Primeiro evento antes de qualquer snapshot: exige snapshot, não aplicação.
		return "resync";
	}

	if (event.sequence <= state.sequence) return "ignore";
	if (event.sequence === state.sequence + 1) return "apply";
	return "resync";
}

/** A lacuna só é detectável quando geração e sequência batem com o estado vivo. */
export function isSequenceGap(state: SessionViewState, event: DesktopEvent): boolean {
	return (
		event.name !== "desktop_snapshot" &&
		event.name !== "session.status" &&
		event.generation === state.generation &&
		event.sequence > state.sequence + 1
	);
}
