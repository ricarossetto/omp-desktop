import { useT, type MessageKey } from "../../i18n";
import "./settings.css";

const SHORTCUTS: Array<{ keys: string; label: MessageKey }> = [
	{ keys: "Ctrl+K", label: "settings.shortcuts.palette" },
	{ keys: "Ctrl+N / Ctrl+T", label: "settings.shortcuts.newTab" },
	{ keys: "Ctrl+W", label: "settings.shortcuts.closeTab" },
	{ keys: "Alt+↑ / Alt+↓", label: "settings.shortcuts.prevNextTab" },
	{ keys: "Ctrl+,", label: "settings.shortcuts.settings" },
	{ keys: "Ctrl+B", label: "settings.shortcuts.sidebar" },
	{ keys: "Ctrl+`", label: "settings.shortcuts.terminal" },
	{ keys: "Alt+← / Alt+→", label: "settings.shortcuts.history" },
	{ keys: "Enter", label: "settings.shortcuts.send" },
	{ keys: "Shift+Enter", label: "settings.shortcuts.newline" },
	{ keys: "↑ / ↓", label: "settings.shortcuts.promptHistory" },
	{ keys: "Ctrl+↑", label: "settings.shortcuts.promptHistorySearch" },
	{ keys: "Esc", label: "settings.shortcuts.interrupt" },
];

export function ShortcutsTab() {
	const t = useT();
	return (
		<section className="omp-settings-section" aria-labelledby="omp-shortcuts-title">
			<h3 id="omp-shortcuts-title">{t("settings.shortcuts.title")}</h3>
			<p className="omp-muted">{t("settings.shortcuts.body")}</p>
			<dl className="omp-shortcuts">
				{SHORTCUTS.map((item) => (
					<div key={item.keys} className="omp-shortcuts__row">
						<dt>
							<kbd>{item.keys}</kbd>
						</dt>
						<dd>{t(item.label)}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}
