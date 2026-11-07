import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
	'a[href]:not([aria-disabled="true"]), button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Prende o foco dentro do diálogo e devolve o foco ao elemento anterior ao fechar.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
	const previousRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!active) return;
		const node = ref.current;
		if (!node) return;
		previousRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

		const focusables = (): HTMLElement[] =>
			Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
				(element) => element.offsetParent !== null || element === document.activeElement,
			);
		const first = node.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0] ?? node;
		first.focus();

		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Tab") return;
			const list = focusables();
			if (list.length === 0) {
				event.preventDefault();
				return;
			}
			const firstElement = list[0];
			const lastElement = list[list.length - 1];
			const current = document.activeElement;
			if (event.shiftKey) {
				if (current === firstElement || !node.contains(current)) {
					event.preventDefault();
					lastElement.focus();
				}
			} else if (current === lastElement || !node.contains(current)) {
				event.preventDefault();
				firstElement.focus();
			}
		};

		node.addEventListener("keydown", onKeyDown);
		return () => {
			node.removeEventListener("keydown", onKeyDown);
			previousRef.current?.focus?.();
		};
	}, [active, ref]);
}
