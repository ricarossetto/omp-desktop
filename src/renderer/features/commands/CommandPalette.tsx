import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { useFocusTrap } from "../../components/focus-trap";
import { useT } from "../../i18n";
import { useActions, useStore } from "../../store/context";
import { activeWorkspace, sessionHasActiveWork } from "../../store/state";
import "./commands.css";

interface PaletteItem {
	id: string;
	group: "actions" | "commands";
	label: string;
	hint?: string;
	keywords?: string;
	disabled?: boolean;
	run: () => void;
}

/** Fontes de comando que contam como skill/MCP no modo restrito da paleta. */
const SKILL_SOURCES: Record<string, true> = {
	skill: true,
	mcp_prompt: true,
	extension: true,
	custom: true,
	file: true,
};

export function CommandPalette() {
	const t = useT();
	const actions = useActions();
	const workspace = useStore((state) => activeWorkspace(state));
	const activeSessionId = useStore((state) => state.activeSessionId);
	const view = useStore((state) =>
		state.activeSessionId ? (state.sessionStates[state.activeSessionId] ?? null) : null,
	);
	const terminalOpen = useStore((state) => state.layout.terminalOpen);
	const mode = useStore((state) => state.paletteMode);

	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const dialogRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	useFocusTrap(dialogRef, true);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const close = () => actions.setPaletteOpen(false);

	const items = useMemo<PaletteItem[]>(() => {
		const list: PaletteItem[] = [
			{
				id: "new-session",
				group: "actions",
				label: t("sidebar.newSession"),
				hint: "Ctrl+N",
				disabled: !workspace,
				run: () => {
					if (workspace) void actions.createSession(workspace.workspaceId);
				},
			},
			{
				id: "open-project",
				group: "actions",
				label: t("palette.openProject"),
				hint: "Ctrl+Shift+P",
				keywords: t("palette.kwWorkspace"),
				run: () => void actions.pickWorkspace(),
			},
			{
				id: "models",
				group: "actions",
				label: t("palette.models"),
				hint: "Ctrl+M",
				disabled: !activeSessionId,
				run: () => actions.setModelPickerOpen(true),
			},
			{
				id: "settings",
				group: "actions",
				label: t("sidebar.settings"),
				keywords: t("palette.kwPreferences"),
				run: () => actions.openSettings(),
			},
			{
				id: "terminal",
				group: "actions",
				label: terminalOpen ? t("palette.collapseTerminal") : t("palette.openTerminal"),
				hint: "Ctrl+`",
				run: () => actions.toggleTerminal(),
			},
			{
				id: "right-agents",
				group: "actions",
				label: t("palette.showAgents"),
				run: () => actions.showRightPanel("agents"),
			},
			{
				id: "right-changes",
				group: "actions",
				label: t("palette.showChanges"),
				keywords: t("palette.kwDiff"),
				run: () => actions.showRightPanel("changes"),
			},
			{
				id: "export-html",
				group: "actions",
				label: t("palette.exportHtml"),
				disabled: !activeSessionId,
				run: () => {
					if (activeSessionId) void actions.exportHtml(activeSessionId);
				},
			},
			{
				id: "resync",
				group: "actions",
				label: t("palette.resync"),
				disabled: !activeSessionId,
				run: () => {
					if (activeSessionId) void actions.refreshSnapshot(activeSessionId);
				},
			},
			{
				id: "theme-system",
				group: "actions",
				label: t("palette.themeSystem"),
				run: () => actions.setTheme("system"),
			},
			{
				id: "theme-light",
				group: "actions",
				label: t("palette.themeLight"),
				run: () => actions.setTheme("light"),
			},
			{
				id: "theme-dark",
				group: "actions",
				label: t("palette.themeDark"),
				run: () => actions.setTheme("dark"),
			},
		];

		if (view && sessionHasActiveWork(view)) {
			list.splice(5, 0, {
				id: "abort",
				group: "actions",
				label: t("palette.abort"),
				keywords: t("palette.kwStop"),
				run: () => void actions.abortAndRestore(view.sessionId),
			});
		}
		if (view && view.status === "interrupted") {
			list.splice(6, 0, {
				id: "restore-interrupted",
				group: "actions",
				label: t("palette.restoreInterrupted"),
				run: () => actions.restoreInterrupted(view.sessionId),
			});
		}

		if (activeSessionId) {
			for (const command of view?.commands ?? []) {
				if (mode === "skills" && !SKILL_SOURCES[command.source ?? ""]) continue;
				list.push({
					id: `command:${command.name}`,
					group: "commands",
					label: `/${command.name}`,
					hint: command.description ?? command.inputHint,
					keywords: (command.aliases ?? []).join(" "),
					run: () => actions.insertIntoComposer(activeSessionId, `/${command.name} `),
				});
			}
		}
		return list;
	}, [actions, activeSessionId, mode, t, terminalOpen, view, workspace]);

	const scoped = useMemo(
		() => (mode === "skills" ? items.filter((item) => item.group === "commands") : items),
		[items, mode],
	);

	const filtered = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return scoped;
		return scoped.filter((item) => {
			const group = item.group === "actions" ? t("palette.groupActions") : t("palette.groupCommands");
			return `${item.label} ${group} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLowerCase().includes(normalized);
		});
	}, [query, scoped, t]);

	useEffect(() => {
		setIndex((current) => Math.min(current, Math.max(0, filtered.length - 1)));
	}, [filtered.length]);

	const runItem = (item: PaletteItem | undefined) => {
		if (!item || item.disabled) return;
		close();
		item.run();
	};

	const move = (direction: number) => {
		if (filtered.length === 0) return;
		let next = index;
		for (let step = 0; step < filtered.length; step++) {
			next = (next + direction + filtered.length) % filtered.length;
			if (!filtered[next]?.disabled) {
				setIndex(next);
				return;
			}
		}
	};

	const activeItem = filtered[index];
	const activeId = activeItem ? `palette-item-${activeItem.id}` : undefined;

	return (
		<div className="palette-overlay" onMouseDown={(event) => {
			if (event.target === event.currentTarget) close();
		}}>
			<div ref={dialogRef} className="palette" role="dialog" aria-modal="true" aria-label={mode === "skills" ? t("sidebar.skills") : t("palette.title")}>
				<div className="palette__search">
					<Icon name="search" />
					<input
						ref={inputRef}
						className="palette__input"
						type="text"
						value={query}
						placeholder={mode === "skills" ? t("palette.searchSkillsPlaceholder") : t("palette.searchPlaceholder")}
						aria-label={t("palette.searchLabel")}
						aria-controls="palette-list"
						aria-activedescendant={activeId}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "ArrowDown") {
								event.preventDefault();
								move(1);
							} else if (event.key === "ArrowUp") {
								event.preventDefault();
								move(-1);
							} else if (event.key === "Enter") {
								event.preventDefault();
								runItem(filtered[index]);
							} else if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								close();
							}
						}}
					/>
					<kbd className="palette__kbd">Esc</kbd>
				</div>
				<div className="palette__list" id="palette-list" role="listbox" aria-label={t("palette.results")}>
					{filtered.length === 0 ? (
						<p className="palette__empty">
							{mode === "skills" ? t("palette.emptySkills") : t("palette.empty")}
						</p>
					) : null}
					{filtered.map((item, itemIndex) => {
						const showGroup = itemIndex === 0 || filtered[itemIndex - 1]?.group !== item.group;
						return (
							<div key={item.id}>
								{showGroup ? (
									<div className="palette__group">
										{item.group === "actions" ? t("palette.groupActions") : t("palette.groupCommands")}
									</div>
								) : null}
								<button
									type="button"
									id={`palette-item-${item.id}`}
									role="option"
									aria-selected={itemIndex === index}
									disabled={item.disabled}
									className={`palette__item${itemIndex === index ? " palette__item--active" : ""}`}
									onMouseMove={() => setIndex(itemIndex)}
									onClick={() => runItem(item)}
								>
									<span className="palette__label">{item.label}</span>
									{item.hint ? <span className="palette__hint">{item.hint}</span> : null}
								</button>
							</div>
						);
					})}
				</div>
				<footer className="palette__footer muted text-xs">
					<span>{t("palette.footerKeys")}</span>
					<span>
						{mode === "skills"
							? t("palette.footerSkills")
							: activeSessionId
								? t("palette.footerCommands")
								: t("palette.footerNoSession")}
					</span>
				</footer>
			</div>
		</div>
	);
}
