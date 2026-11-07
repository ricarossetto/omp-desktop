import { useEffect, type ReactNode } from "react";
import { useT } from "../i18n";
import { Modal } from "./Modal";

export interface ConfirmDialogProps {
	title: string;
	children: ReactNode;
	confirmLabel?: string;
	cancelLabel?: string;
	danger?: boolean;
	busy?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function ConfirmDialog({
	title,
	children,
	confirmLabel,
	cancelLabel,
	danger = false,
	busy = false,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	const t = useT();
	useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onCancel();
			}
		};
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [onCancel]);

	return (
		<Modal
			title={title}
			onClose={busy ? undefined : onCancel}
			footer={
				<>
					<button type="button" className="btn" onClick={onCancel} disabled={busy}>
						{cancelLabel ?? t("common.cancel")}
					</button>
					<button
						type="button"
						className={`btn ${danger ? "btn--danger" : "btn--primary"}`}
						onClick={onConfirm}
						disabled={busy}
						data-autofocus
					>
						{busy ? t("common.wait") : (confirmLabel ?? t("common.confirm"))}
					</button>
				</>
			}
		>
			{children}
		</Modal>
	);
}
