/**
 * PREVIEW — store estático somente leitura para inspeção visual em dev.
 * Nenhuma ação toca IPC, filesystem ou o store real (`createAppStore`).
 */
import type { AppActions, AppStore } from "../store/create-store";
import { EMPTY_COMPOSER_DRAFT } from "../features/conversation/composer-policy";
import { clampLayout, type AppState } from "../store/state";

export interface PreviewStore extends AppStore {
	replaceState(next: AppState): void;
}

export function createPreviewStore(initial: AppState): PreviewStore {
	let state = initial;
	const listeners = new Set<() => void>();

	const set = (updater: (current: AppState) => AppState): void => {
		const next = updater(state);
		if (next === state) return;
		state = next;
		for (const listener of listeners) listener();
	};

	const done = async (): Promise<void> => undefined;

	const actions: AppActions = {
		start: () => () => undefined,
		refreshRuntime: done,
		retryRuntime: done,
		selectOmp: done,
		installOmp: done,
		applyDependencies: (snapshot) => {
			set((current) =>
				current.runtime
					? { ...current, runtime: { ...current.runtime, dependencies: snapshot } }
					: current,
			);
		},
		loadWorkspaces: done,
		pickWorkspace: done,
		removeWorkspace: done,
		relocateWorkspace: done,
		openWorkspace: done,
		loadSessions: async () => [],
		createSession: async () => false,
		openSession: async () => false,
		activateSession: (sessionId) => {
			set((current) => ({ ...current, activeSessionId: sessionId }));
		},
		closeSession: async () => false,
		refreshSnapshot: done,
		requestStats: done,
		sendPrompt: async () => false,
		abortAndRestore: done,
		removeQueued: done,
		promoteQueued: done,
		respondDialog: async (sessionId, response) => {
			set((current) => {
				const view = current.sessionStates[sessionId];
				if (!view) return current;
				return {
					...current,
					sessionStates: {
						...current.sessionStates,
						[sessionId]: {
							...view,
							pendingDialogs: view.pendingDialogs.filter((dialog) => dialog.id !== response.id),
						},
					},
				};
			});
			return true;
		},
		exportHtml: done,
		navigateTree: async () => false,
		forkSession: async () => false,
		setDraft: (sessionId, text) => {
			set((current) => {
				const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
				return { ...current, drafts: { ...current.drafts, [sessionId]: { ...draft, text } } };
			});
		},
		insertIntoComposer: (sessionId, text) => {
			set((current) => {
				const draft = current.drafts[sessionId] ?? EMPTY_COMPOSER_DRAFT;
				return { ...current, drafts: { ...current.drafts, [sessionId]: { ...draft, text } } };
			});
		},
		pickAttachments: done,
		importAttachment: done,
		removeDraftAttachment: done,
		setUnreadSessions: () => undefined,
		setLocale: () => undefined,
		restoreInterrupted: () => undefined,
		setLayout: (partial) => {
			set((current) => ({ ...current, layout: clampLayout({ ...current.layout, ...partial }) }));
		},
		setTheme: (theme) => {
			set((current) => ({ ...current, theme }));
		},
		setApprovalMode: async () => undefined,
		setAccent: (accent) => set((current) => ({ ...current, accent })),
		setDensity: (density) => set((current) => ({ ...current, density })),
		setFontScale: (fontScale) => set((current) => ({ ...current, fontScale })),
		setTabLayout: (tabLayout) => set((current) => ({ ...current, tabLayout })),
		setTimelineWidth: (timelineWidth) => set((current) => ({ ...current, timelineWidth })),
		setReduceMotion: (reduceMotion) => set((current) => ({ ...current, reduceMotion })),
		moveTab: (sessionId, targetIndex) =>
			set((current) => {
				const from = current.tabs.indexOf(sessionId);
				if (from < 0) return current;
				const to = Math.max(0, Math.min(current.tabs.length - 1, targetIndex));
				if (from === to) return current;
				const tabs = [...current.tabs];
				tabs.splice(from, 1);
				tabs.splice(to, 0, sessionId);
				return { ...current, tabs };
			}),
		requestCloseSession: (sessionId) =>
			set((current) => ({ ...current, closingSessionId: sessionId })),
		cancelCloseSession: () => set((current) => ({ ...current, closingSessionId: null })),
		confirmCloseSession: async () => undefined,
		toggleTerminal: () => {
			set((current) => ({ ...current, layout: { ...current.layout, terminalOpen: !current.layout.terminalOpen } }));
		},
		setRightTab: (tab) => {
			set((current) => ({ ...current, layout: { ...current.layout, rightTab: tab } }));
		},
		toggleRightPanel: () => {
			set((current) => ({ ...current, layout: { ...current.layout, rightOpen: !current.layout.rightOpen } }));
		},
		showRightPanel: (tab) => {
			set((current) => ({
				...current,
				layout: { ...current.layout, rightTab: tab, rightOpen: true },
				rightPanelRequest: current.rightPanelRequest + 1,
			}));
		},
		openSettings: (tab) => {
			set((current) => ({ ...current, settings: { open: true, initialTab: tab } }));
		},
		closeSettings: () => {
			set((current) => ({ ...current, settings: { open: false } }));
		},
		setModelPickerOpen: (open) => {
			set((current) => ({ ...current, modelPickerOpen: open }));
		},
		setPaletteOpen: (open) => {
			set((current) => ({ ...current, paletteOpen: open }));
		},
		notify: (level, text) => {
			set((current) => ({
				...current,
				notices: [...current.notices, { id: `preview-notice-${Date.now()}`, level, text }],
			}));
		},
		dismissNotice: (id) => {
			set((current) => ({ ...current, notices: current.notices.filter((notice) => notice.id !== id) }));
		},
		openExternal: done,
		openWorkspaceFile: done,
		openFileExternal: done,
		closeFilePreview: () => undefined,
	};

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		actions,
		replaceState(next) {
			state = next;
			for (const listener of listeners) listener();
		},
	};
}
