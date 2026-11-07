/** Rótulo, classe e ícone do estado da sessão; usado pelo rodapé e pela sidebar. */
export interface SessionStatusBadge {
	label: string;
	className: string;
	icon: "check" | "warning" | "error" | "info" | "lock";
}

export const SESSION_STATUS: Record<string, SessionStatusBadge> = {
	starting: { label: "Iniciando", className: "badge--warning", icon: "info" },
	ready: { label: "Pronta", className: "badge--success", icon: "check" },
	settled: { label: "Pronta", className: "badge--success", icon: "check" },
	busy: { label: "Trabalhando", className: "badge--accent", icon: "info" },
	interrupted: { label: "Interrompida", className: "badge--warning", icon: "warning" },
	error: { label: "Com erro", className: "badge--error", icon: "error" },
	closed: { label: "Fechada", className: "", icon: "lock" },
};

export function statusFor(view: SessionStatusBadgeSource | null, resyncing: boolean): SessionStatusBadge {
	if (!view) return { label: "Sem sessão", className: "", icon: "info" };
	if (resyncing) return { label: "Ressincronizando", className: "badge--warning", icon: "warning" };
	const working =
		view.status === "busy" ||
		view.status === "starting" ||
		view.meta?.isStreaming === true ||
		view.meta?.isCompacting === true ||
		(view.meta ? !view.meta.isSettled : false);
	if (working) {
		return view.status === "starting"
			? SESSION_STATUS.starting
			: { label: view.meta?.isCompacting ? "Compactando" : "Trabalhando", className: "badge--accent", icon: "info" };
	}
	if (view.meta?.hasPendingAsyncWork) {
		return { label: "Trabalho pendente", className: "badge--warning", icon: "info" };
	}
	return SESSION_STATUS[view.status] ?? { label: view.status, className: "", icon: "info" };
}

import type { SessionViewState } from "@shared/session-types";
type SessionStatusBadgeSource = SessionViewState;
