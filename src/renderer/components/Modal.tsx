import { useId, useRef, type ReactNode } from "react";
import { useT } from "../i18n";
import { Icon } from "./Icon";
import { useFocusTrap } from "./focus-trap";

export interface ModalProps {
	title: string;
	children: ReactNode;
	footer?: ReactNode;
	onClose?: () => void;
	wide?: boolean;
	full?: boolean;
	className?: string;
	overlayClassName?: string;
	/** Texto auxiliar exibido ao lado do título. */
	subtitle?: string;
}

export function Modal({ title, subtitle, children, footer, onClose, wide, full, className, overlayClassName }: ModalProps) {
	const t = useT();
	const titleId = useId();
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref, true);

	return (
		<div
			className={`overlay${overlayClassName ? ` ${overlayClassName}` : ""}`}
			onMouseDown={(event) => {
				if (event.target === event.currentTarget && onClose) onClose();
			}}
		>
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				className={`modal${wide ? " modal--wide" : ""}${full ? " modal--full" : ""}${className ? ` ${className}` : ""}`}
			>
				<header className="modal__header">
					<div className="modal__title" id={titleId}>
						{title}
						{subtitle ? <span className="muted text-xs"> — {subtitle}</span> : null}
					</div>
					{onClose ? (
						<button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
							<Icon name="close" />
						</button>
					) : null}
				</header>
				<div className="modal__body">{children}</div>
				{footer ? <footer className="modal__footer">{footer}</footer> : null}
			</div>
		</div>
	);
}
