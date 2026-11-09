import { useEffect, useRef, useState } from "react";
import { invoke } from "./api";
import { CloseSessionDialog } from "./components/CloseSessionDialog";
import { Toasts } from "./components/Toasts";
import { DiagnosticsScreen } from "./features/diagnostics/DiagnosticsScreen";
import { FilePreview } from "./features/files/FilePreview";
import { Onboarding, onboardingDone } from "./features/onboarding/Onboarding";
import { StartScreen } from "./features/workspaces/StartScreen";
import { Shell } from "./layout/Shell";
import { TitleBar } from "./layout/TitleBar";
import { I18nProvider, useT } from "./i18n";
import { StoreProvider, useActions, useStore } from "./store/context";
import type { AppStore } from "./store/create-store";
import { activeWorkspace } from "./store/state";
import { applyAccent } from "./styles/accent";

function LoadingScreen({ title, detail }: { title: string; detail: string }) {
	return (
		<div className="app-loading" role="status" aria-live="polite">
			<span className="spinner-static" />
			<div className="app-loading__title">{title}</div>
			<div className="muted">{detail}</div>
		</div>
	);
}

function LocalizedApp() {
	const locale = useStore((state) => state.locale);
	return (
		<I18nProvider locale={locale}>
			<AppContent />
		</I18nProvider>
	);
}

function AppContent() {
	const t = useT();
	const actions = useActions();
	const boot = useStore((state) => state.boot);
	const runtime = useStore((state) => state.runtime);
	const runtimeError = useStore((state) => state.runtimeError);
	const workspacesLoaded = useStore((state) => state.workspacesLoaded);
	const workspace = useStore((state) => activeWorkspace(state));
	const hasRecents = useStore((state) => state.workspaces.length > 0);
	const [showOnboarding, setShowOnboarding] = useState(() => !onboardingDone());
	const [onboardingForced, setOnboardingForced] = useState(false);
	const theme = useStore((state) => state.theme);
	const accent = useStore((state) => state.accent);
	const density = useStore((state) => state.density);
	const fontScale = useStore((state) => state.fontScale);
	const timelineWidth = useStore((state) => state.timelineWidth);
	const reduceMotion = useStore((state) => state.reduceMotion);
	const phase = runtime?.phase;
	const previousPhase = useRef(phase);

	useEffect(() => actions.start(), [actions]);

	// Enquanto o ambiente não está pronto, o diagnóstico pode selecionar outro OMP;
	// consultamos o status para sair da tela sem exigir reinício manual.
	useEffect(() => {
		if (!phase || phase === "ready" || phase === "starting-host") return;
		const timer = setInterval(() => void actions.refreshRuntime(), 3000);
		return () => clearInterval(timer);
	}, [actions, phase]);

	useEffect(() => {
		if (boot === "ready" && previousPhase.current !== "ready" && phase === "ready") {
			void actions.retryRuntime();
		}
		previousPhase.current = phase;
	}, [actions, boot, phase]);

	useEffect(() => {
		const root = document.documentElement;
		if (theme === "system") delete root.dataset.theme;
		else root.dataset.theme = theme;
	}, [theme]);

	useEffect(() => {
		document.documentElement.dataset.density = density;
	}, [density]);

	useEffect(() => {
		document.documentElement.dataset.timeline = timelineWidth;
	}, [timelineWidth]);

	useEffect(() => {
		document.documentElement.dataset.reduceMotion = reduceMotion;
	}, [reduceMotion]);

	useEffect(() => {
		applyAccent(accent);
	}, [accent]);

	useEffect(() => {
		void invoke({ op: "ui.setZoom", factor: fontScale }).catch(() => undefined);
	}, [fontScale]);

	// Configurações → Geral reabre o assistente sem passar pelo store.
	useEffect(() => {
		const openOnboarding = () => {
			setOnboardingForced(true);
		};
		const openOnboardingSettings = () => {
			setOnboardingForced(false);
			setShowOnboarding(false);
			actions.openSettings("accounts");
		};
		window.addEventListener("omp:onboarding", openOnboarding);
		window.addEventListener("omp:onboarding-settings", openOnboardingSettings);
		return () => {
			window.removeEventListener("omp:onboarding", openOnboarding);
			window.removeEventListener("omp:onboarding-settings", openOnboardingSettings);
		};
	}, [actions]);

	let content: React.ReactNode;
	if (runtimeError) {
		content = (
			<div className="app-fatal">
				<div className="app-fatal__card" role="alert">
					<h1 className="text-lg">{t("app.fatalTitle")}</h1>
					<p className="muted" style={{ marginTop: "var(--space-2)" }}>
						{t("app.fatalBody")}
					</p>
					<pre>{runtimeError}</pre>
					<div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
						<button type="button" className="btn btn--primary" onClick={() => void actions.retryRuntime()}>
							{t("common.retry")}
						</button>
					</div>
				</div>
			</div>
		);
	} else if (!runtime) {
		content = <LoadingScreen title={t("app.loadingTitle")} detail={t("app.loadingDetail")} />;
	} else if (runtime.phase === "starting-host") {
		content = <LoadingScreen title={t("app.startingHostTitle")} detail={t("app.startingHostDetail")} />;
	} else if (runtime.phase === "omp-missing" || runtime.phase === "omp-incompatible" || runtime.phase === "host-failed") {
		content = (
			<div className="app-diagnostics">
				<DiagnosticsScreen status={runtime} />
			</div>
		);
	} else if (!workspacesLoaded || boot === "loading") {
		content = <LoadingScreen title={t("app.loadingProjectsTitle")} detail={t("app.loadingProjectsDetail")} />;
	} else if (onboardingForced || (showOnboarding && !hasRecents)) {
		content = (
			<Onboarding
				onFinish={() => {
					setOnboardingForced(false);
					setShowOnboarding(false);
				}}
			/>
		);
	} else if (!workspace || !workspace.available) {
		content = <StartScreen />;
	} else {
		content = <Shell />;
	}

	return (
		<div className="app-frame">
			<TitleBar />
			<div className="app-frame__body">{content}</div>
			<Toasts />
			<FilePreview />
			<CloseSessionDialog />
		</div>
	);
}

export default function App({ store }: { store: AppStore }) {
	return (
		<StoreProvider store={store}>
			<LocalizedApp />
		</StoreProvider>
	);
}
