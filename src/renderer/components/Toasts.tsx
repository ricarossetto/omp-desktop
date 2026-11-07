import { Icon } from "../components/Icon";
import { useT } from "../i18n";
import { useActions, useStore } from "../store/context";

export function Toasts() {
	const t = useT();
	const notices = useStore((state) => state.notices);
	const actions = useActions();
	if (notices.length === 0) return null;
	return (
		<div className="toasts" aria-live="polite" aria-atomic="false">
			{notices.slice(-4).map((notice) => (
				<div
					key={notice.id}
					className={`toast toast--${notice.level}`}
					role={notice.level === "error" ? "alert" : "status"}
				>
					<Icon
						name={notice.level === "error" ? "error" : notice.level === "warning" ? "warning" : notice.level === "success" ? "check" : "info"}
						className={`state-icon state-icon--${notice.level}`}
					/>
					<div className="toast__body">{notice.text}</div>
					<button
						type="button"
						className="icon-btn"
						aria-label={t("common.dismissNotice")}
						onClick={() => actions.dismissNotice(notice.id)}
					>
						<Icon name="close" className="icon--sm" />
					</button>
				</div>
			))}
		</div>
	);
}
