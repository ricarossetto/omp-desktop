import { useMemo, useState } from "react";
import { Icon } from "../../components/Icon";
import { useT } from "../../i18n";

export function PromptHistoryPicker({
	items,
	onSelect,
	onClose,
}: {
	items: readonly string[];
	onSelect: (text: string) => void;
	onClose: () => void;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return items;
		return items.filter((item) => item.toLowerCase().includes(needle));
	}, [items, query]);

	return (
		<>
			<header className="prompt-history__head">
				<strong>{t("composer.historyTitle")}</strong>
				<button type="button" className="icon-btn" aria-label={t("common.close")} onClick={onClose}>
					<Icon name="close" className="icon--sm" />
				</button>
			</header>
			<input
				autoFocus
				className="prompt-history__search"
				value={query}
				onChange={(event) => setQuery(event.target.value)}
				placeholder={t("composer.historySearch")}
				aria-label={t("composer.historySearch")}
				onKeyDown={(event) => {
					if (event.key === "Enter" && filtered[0]) {
						event.preventDefault();
						onSelect(filtered[0]);
						return;
					}
					if (event.key === "Escape") {
						event.stopPropagation();
						onClose();
					}
				}}
			/>
			<ul className="prompt-history__list" role="listbox" aria-label={t("composer.historyTitle")}>
				{filtered.map((item, index) => (
					<li key={`${index}:${item.slice(0, 40)}`}>
						<button
							type="button"
							role="option"
							aria-selected={false}
							onClick={() => onSelect(item)}
						>
							{item}
						</button>
					</li>
				))}
			</ul>
			{filtered.length === 0 ? <p className="muted">{t("composer.historyEmpty")}</p> : null}
			<p className="prompt-history__hint muted text-xs">{t("composer.historyHint")}</p>
		</>
	);
}
