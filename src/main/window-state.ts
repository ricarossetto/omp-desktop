/**
 * Geometria da janela: restaura a posição apenas quando ela ainda intersecta
 * um monitor existente. Funções puras, testáveis sem Electron.
 */

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface StoredWindowState extends Rect {
	maximized?: boolean;
}

export function rectangleIntersectionArea(a: Rect, b: Rect): number {
	const left = Math.max(a.x, b.x);
	const top = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	if (right <= left || bottom <= top) return 0;
	return (right - left) * (bottom - top);
}

/** Pelo menos 64×64 px visíveis em algum monitor para a posição ser aceita. */
export function intersectsAnyDisplay(bounds: Rect, displays: Rect[]): boolean {
	for (const display of displays) {
		const area = rectangleIntersectionArea(bounds, display);
		const visibleWidth = Math.min(bounds.x + bounds.width, display.x + display.width) - Math.max(bounds.x, display.x);
		const visibleHeight = Math.min(bounds.y + bounds.height, display.y + display.height) - Math.max(bounds.y, display.y);
		if (area > 0 && visibleWidth >= 64 && visibleHeight >= 64) return true;
	}
	return false;
}

export interface RestoredBounds {
	bounds: { width: number; height: number; x?: number; y?: number };
	maximized: boolean;
}

export function restoreWindowBounds(
	saved: StoredWindowState | null,
	displays: Rect[],
	defaults: { width: number; height: number; minWidth: number; minHeight: number },
): RestoredBounds {
	if (
		!saved ||
		!Number.isFinite(saved.width) ||
		!Number.isFinite(saved.height) ||
		!Number.isFinite(saved.x) ||
		!Number.isFinite(saved.y)
	) {
		return { bounds: { width: defaults.width, height: defaults.height }, maximized: false };
	}
	const width = Math.max(defaults.minWidth, Math.round(saved.width));
	const height = Math.max(defaults.minHeight, Math.round(saved.height));
	const candidate = { x: Math.round(saved.x), y: Math.round(saved.y), width, height };
	if (!intersectsAnyDisplay(candidate, displays)) {
		return { bounds: { width, height }, maximized: false };
	}
	return { bounds: candidate, maximized: Boolean(saved.maximized) };
}
