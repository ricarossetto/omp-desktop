import type { JSX } from "react";

export type IconKind =
	| "success"
	| "warning"
	| "error"
	| "info"
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "aborted"
	| "blocked"
	| "empty";

const PATHS: Record<IconKind, JSX.Element> = {
	success: <path d="M4 8.5 6.8 11.3 12 5.5" />,
	completed: <path d="M4 8.5 6.8 11.3 12 5.5" />,
	warning: (
		<>
			<path d="M8 2.8 14.4 13.2H1.6L8 2.8Z" />
			<path d="M8 6.3v3.1" />
			<path d="M8 11.5h.01" />
		</>
	),
	error: (
		<>
			<circle cx="8" cy="8" r="5.8" />
			<path d="m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2" />
		</>
	),
	failed: (
		<>
			<circle cx="8" cy="8" r="5.8" />
			<path d="m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2" />
		</>
	),
	info: (
		<>
			<circle cx="8" cy="8" r="5.8" />
			<path d="M8 7.3v4" />
			<path d="M8 4.7h.01" />
		</>
	),
	pending: (
		<>
			<circle cx="8" cy="8" r="5.8" />
			<path d="M8 4.8V8l2.2 1.4" />
		</>
	),
	running: (
		<>
			<path d="M13.4 8A5.4 5.4 0 1 1 10.7 3.2" />
			<path d="M10.7 3.2h2.5v2.5" />
		</>
	),
	aborted: (
		<>
			<circle cx="8" cy="8" r="5.8" />
			<path d="M5.6 8h4.8" />
		</>
	),
	blocked: (
		<>
			<circle cx="8" cy="8" r="5.8" />
			<path d="M8 4.8v3.6" />
			<path d="M8 11.3h.01" />
		</>
	),
	empty: (
		<>
			<rect x="2.8" y="3.4" width="10.4" height="9.2" rx="1.4" />
			<path d="M5.4 6.4h5.2M5.4 9.2h3.4" />
		</>
	),
};

/** Ícone inline com significado acessível; nunca depende só da cor. */
export function StatusIcon({ kind, size = 16 }: { kind: IconKind; size?: number }) {
	return (
		<svg
			className="omp-icon"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{PATHS[kind]}
		</svg>
	);
}
