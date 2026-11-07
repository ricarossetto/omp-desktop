/** Regras de teclado e de largura compartilhadas pela moldura da janela. */

export const CONVERSATION_MIN_WIDTH = 320;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 380;
export const RIGHT_PANEL_MIN_WIDTH = 280;
export const RIGHT_PANEL_MAX_WIDTH = 520;
export const SPLITTER_WIDTH = 6;
export const SIDEBAR_RAIL_WIDTH = 44;

/** Campos de texto e áreas editáveis mantêm as setas para o cursor. */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!target || typeof target !== "object") return false;
	const element = target as { tagName?: unknown; isContentEditable?: unknown };
	const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
	return tag === "INPUT" || tag === "TEXTAREA" || element.isContentEditable === true;
}

/**
 * Próxima aba para as setas/Home/End, no padrão ARIA de tablist.
 * Devolve `null` quando a tecla não navega ou a aba atual não pertence à ordem.
 */
export function cycleTab<T extends string>(order: readonly T[], current: T, key: string): T | null {
	if (order.length === 0) return null;
	const index = order.indexOf(current);
	if (index < 0) return null;
	if (key === "Home") return order[0] ?? null;
	if (key === "End") return order[order.length - 1] ?? null;
	if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
	const delta = key === "ArrowRight" ? 1 : -1;
	return order[(index + delta + order.length) % order.length] ?? null;
}

export interface PanelWidths {
	sidebar: number;
	right: number;
}

/**
 * Larguras efetivas da barra lateral e do painel direito.
 * Em janelas largas os painéis encolhem (painel direito primeiro) até a
 * conversa garantir `CONVERSATION_MIN_WIDTH`; nunca ficam abaixo dos mínimos.
 */
export function clampPanelWidths(input: {
	viewportWidth: number;
	sidebarOpen: boolean;
	rightOpen: boolean;
	sidebarWidth: number;
	rightWidth: number;
}): PanelWidths {
	let sidebar = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, input.sidebarWidth));
	let right = Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, input.rightWidth));

	const chrome =
		(input.sidebarOpen ? SPLITTER_WIDTH : SIDEBAR_RAIL_WIDTH) +
		(input.rightOpen ? SPLITTER_WIDTH : 0);
	const available = input.viewportWidth - CONVERSATION_MIN_WIDTH - chrome;
	const total = (input.sidebarOpen ? sidebar : 0) + (input.rightOpen ? right : 0);
	let overflow = total - Math.max(0, available);

	if (overflow > 0 && input.rightOpen) {
		const cut = Math.min(overflow, right - RIGHT_PANEL_MIN_WIDTH);
		right -= cut;
		overflow -= cut;
	}
	if (overflow > 0 && input.sidebarOpen) {
		const cut = Math.min(overflow, sidebar - SIDEBAR_MIN_WIDTH);
		sidebar -= cut;
	}

	return { sidebar, right };
}
