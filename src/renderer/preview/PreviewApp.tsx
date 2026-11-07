/**
 * PREVIEW — shell real com fixtures fictícias.
 * Só é renderizado com `?preview=1` e `import.meta.env.DEV`; em produção retorna null.
 */
import { useEffect, useRef, useState } from "react";
import { Shell } from "../layout/Shell";
import { I18nProvider } from "../i18n";
import { StoreProvider } from "../store/context";
import { previewAppState } from "./preview-data";
import { createPreviewStore, type PreviewStore } from "./preview-store";
import "./preview.css";

export function PreviewApp() {
	const [withDialogs, setWithDialogs] = useState(false);
	const storeRef = useRef<PreviewStore | null>(null);
	const store = storeRef.current ?? (storeRef.current = createPreviewStore(previewAppState(withDialogs)));

	useEffect(() => {
		store.replaceState(previewAppState(withDialogs));
	}, [withDialogs, store]);

	if (!import.meta.env.DEV) {
		return <div className="preview-blocked">Pré-visualização disponível apenas em desenvolvimento.</div>;
	}

	return (
		<StoreProvider store={store}>
			<I18nProvider locale="pt-BR">
			<Shell />
			<div className="preview-flag" role="status">
				<strong>PREVIEW</strong>
				<span>dados fictícios — nunca em produção</span>
				<button type="button" onClick={() => setWithDialogs((value) => !value)}>
					{withDialogs ? "Ocultar diálogo" : "Mostrar diálogo"}
				</button>
			</div>
			</I18nProvider>
		</StoreProvider>
	);
}

export default PreviewApp;
