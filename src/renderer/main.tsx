import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { createAppStore } from "./store/create-store";
import "./styles/tokens.css";
import "./styles/app.css";

const params = new URLSearchParams(window.location.search);
const previewMode = import.meta.env.DEV && params.get("preview") === "1";

async function bootstrap(): Promise<void> {
	const container = document.getElementById("root");
	if (!container) throw new Error("Elemento #root ausente no HTML do renderer.");
	const root = createRoot(container);

	if (previewMode) {
		// Escolha em runtime: só o modo preview (dev + ?preview=1) carrega as fixtures.
		// O import dinâmico mantém os dados fictícios fora do bundle de produção.
		const { PreviewApp } = await import("./preview/PreviewApp");
		root.render(<PreviewApp />);
		return;
	}

	const store = createAppStore();
	root.render(
		<ErrorBoundary>
			<App store={store} />
		</ErrorBoundary>,
	);
}

void bootstrap();
