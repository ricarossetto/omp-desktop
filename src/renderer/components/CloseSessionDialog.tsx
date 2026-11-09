import { useT } from "../i18n";
import { useActions, useStore } from "../store/context";
import { sessionHasActiveWork } from "../store/state";
import { ConfirmDialog } from "./ConfirmDialog";

/** Confirmação global de fechamento usada pela barra de abas e por Ctrl+W. */
export function CloseSessionDialog() {
	const t = useT();
	const actions = useActions();
	const sessionId = useStore((state) => state.closingSessionId);
	const view = useStore((state) =>
		state.closingSessionId ? (state.sessionStates[state.closingSessionId] ?? null) : null,
	);

	if (!sessionId) return null;
	const busy = view ? sessionHasActiveWork(view) : false;

	return (
		<ConfirmDialog
			title={busy ? t("sidebar.closeBusyTitle") : t("sidebar.closeTitle")}
			confirmLabel={busy ? t("sidebar.closeSession") : t("common.close")}
			danger={busy}
			onCancel={() => actions.cancelCloseSession()}
			onConfirm={() => void actions.confirmCloseSession()}
		>
			<p>{busy ? t("sidebar.closeBusyBody") : t("sidebar.closeBody")}</p>
		</ConfirmDialog>
	);
}
