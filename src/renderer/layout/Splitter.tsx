import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Divisor arrastável com limites e controle por teclado.
 * `invert` indica que arrastar para a esquerda/cima aumenta o valor.
 */
export interface SplitterProps {
	orientation: "vertical" | "horizontal";
	value: number;
	min: number;
	max: number;
	onChange: (value: number) => void;
	label: string;
	invert?: boolean;
}

export function Splitter({ orientation, value, min, max, onChange, label, invert = false }: SplitterProps) {
	const dragRef = useRef<{ coordinate: number; value: number } | null>(null);
	const [dragging, setDragging] = useState(false);

	const clamp = useCallback(
		(next: number) => Math.min(max, Math.max(min, Math.round(next))),
		[min, max],
	);

	useEffect(() => {
		if (!dragging) return;
		const onMove = (event: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;
			const coordinate = orientation === "vertical" ? event.clientX : event.clientY;
			const delta = (coordinate - drag.coordinate) * (invert ? -1 : 1);
			onChange(clamp(drag.value + delta));
		};
		const onUp = () => {
			dragRef.current = null;
			setDragging(false);
			document.body.classList.remove("is-resizing");
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			document.body.classList.remove("is-resizing");
		};
	}, [dragging, invert, onChange, orientation, clamp]);

	const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		dragRef.current = {
			coordinate: orientation === "vertical" ? event.clientX : event.clientY,
			value,
		};
		setDragging(true);
		document.body.classList.add("is-resizing");
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const back = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
		const forward = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
		const decrement = invert ? forward : back;
		const increment = invert ? back : forward;
		if (event.key === decrement) {
			event.preventDefault();
			onChange(clamp(value - 16));
		} else if (event.key === increment) {
			event.preventDefault();
			onChange(clamp(value + 16));
		} else if (event.key === "Home") {
			event.preventDefault();
			onChange(min);
		} else if (event.key === "End") {
			event.preventDefault();
			onChange(max);
		}
	};

	return (
		<div
			role="separator"
			aria-orientation={orientation}
			aria-label={label}
			aria-valuenow={value}
			aria-valuemin={min}
			aria-valuemax={max}
			tabIndex={0}
			className={`splitter splitter--${orientation}${dragging ? " splitter--dragging" : ""}`}
			onPointerDown={onPointerDown}
			onKeyDown={onKeyDown}
		/>
	);
}
