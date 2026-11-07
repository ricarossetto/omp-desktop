import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { AppStore, AppActions } from "./create-store";
import type { AppState } from "./state";
import type { SessionViewState } from "@shared/session-types";

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
	return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

function useStoreContext(): AppStore {
	const store = useContext(StoreContext);
	if (!store) throw new Error("StoreProvider ausente");
	return store;
}

/**
 * Seletor deve devolver valor estável (primitivo ou referência do estado).
 * Evite criar objetos/arrays no seletor: useSyncExternalStore compara por identidade.
 */
export function useStore<T>(selector: (state: AppState) => T): T {
	const store = useStoreContext();
	const getSnapshot = () => selector(store.getState());
	return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useActions(): AppActions {
	return useStoreContext().actions;
}

export function useSessionView(sessionId: string | null): SessionViewState | null {
	return useStore((state) => (sessionId ? (state.sessionStates[sessionId] ?? null) : null));
}
