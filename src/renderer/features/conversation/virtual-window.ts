/**
 * Janela de virtualização própria, sem biblioteca externa.
 * Alturas conhecidas por item (medidas com ResizeObserver) e estimativa para
 * itens ainda não renderizados. O cálculo é O(n) por atualização com busca
 * binária no início da janela; n permanece na casa de milhares.
 */
export interface VirtualWindowInput {
	itemCount: number;
	/** Altura em px do item no índice informado (medida ou estimada, > 0). */
	heightAt: (index: number) => number;
	scrollTop: number;
	viewportHeight: number;
	/** Itens extras renderizados acima e abaixo da janela visível. */
	overscan?: number;
}

export interface VirtualWindow {
	/** Índice inicial inclusivo. */
	start: number;
	/** Índice final exclusivo. */
	end: number;
	padTop: number;
	padBottom: number;
	totalHeight: number;
	/** Início em px do primeiro item renderizado. */
	startOffset: number;
}

export function computeOffsets(itemCount: number, heightAt: (index: number) => number): number[] {
	const offsets: number[] = new Array(itemCount + 1);
	offsets[0] = 0;
	for (let i = 0; i < itemCount; i++) {
		const height = Math.max(1, heightAt(i));
		offsets[i + 1] = offsets[i] + height;
	}
	return offsets;
}

/** Índice do item que contém `y` (offset acumulado). */
export function findIndexAt(offsets: readonly number[], y: number): number {
	const last = offsets.length - 2;
	if (last < 0) return 0;
	if (y <= 0) return 0;
	if (y >= offsets[last + 1]) return last;
	let lo = 0;
	let hi = last;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (offsets[mid] <= y) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

export function computeVirtualWindow(input: VirtualWindowInput): VirtualWindow {
	const count = Math.max(0, Math.floor(input.itemCount));
	if (count === 0) {
		return { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0, startOffset: 0 };
	}
	const overscan = Math.max(0, Math.floor(input.overscan ?? 4));
	const offsets = computeOffsets(count, input.heightAt);
	const totalHeight = offsets[count];
	const scrollTop = Math.max(0, Math.min(input.scrollTop, totalHeight));
	const viewport = Math.max(1, input.viewportHeight);

	const firstVisible = findIndexAt(offsets, scrollTop);
	const lastVisible = findIndexAt(offsets, scrollTop + viewport - 1);

	const start = Math.max(0, firstVisible - overscan);
	const end = Math.min(count, lastVisible + 1 + overscan);

	return {
		start,
		end,
		padTop: offsets[start],
		padBottom: Math.max(0, totalHeight - offsets[end]),
		totalHeight,
		startOffset: offsets[start],
	};
}

/** Ordem estável de chaves; usado para detectar prepend de histórico. */
export function indexOfKey(keys: readonly string[], key: string): number {
	for (let i = 0; i < keys.length; i++) if (keys[i] === key) return i;
	return -1;
}
