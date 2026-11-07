import { Component, type ErrorInfo, type ReactNode } from "react";
import { detectLocale, translate, type MessageKey, type MessageParams } from "../i18n";

interface ErrorBoundaryState {
	error: Error | null;
	componentStack: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
	state: ErrorBoundaryState = { error: null, componentStack: "" };

	static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		this.setState({ componentStack: info.componentStack ?? "" });
		console.error("Falha no renderer", error);
	}

	render() {
		if (!this.state.error) return this.props.children;
		const details = `${this.state.error.stack ?? this.state.error.message}\n${this.state.componentStack}`;
		const locale = detectLocale(typeof navigator === "undefined" ? undefined : navigator.language);
		const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
		return (
			<div className="app-fatal">
				<div className="app-fatal__card" role="alert">
					<h1 className="text-lg">{t("error.boundaryTitle")}</h1>
					<p className="muted" style={{ marginTop: "var(--space-2)" }}>
						{t("error.boundaryBody")}
					</p>
					<pre>{details}</pre>
					<div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-4)" }}>
						<button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
							{t("error.reloadWindow")}
						</button>
						<button
							type="button"
							className="btn"
							onClick={() => {
								void navigator.clipboard.writeText(details);
							}}
						>
							{t("error.copyDetails")}
						</button>
					</div>
				</div>
			</div>
		);
	}
}
