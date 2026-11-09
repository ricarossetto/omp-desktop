import type { SVGProps } from "react";

export type IconName =
	| "plus"
	| "folder"
	| "folder-open"
	| "send"
	| "stop"
	| "settings"
	| "cpu"
	| "sliders"
	| "panel-right"
	| "chevron-down"
	| "chevron-right"
	| "chevron-up"
	| "close"
	| "copy"
	| "check"
	| "warning"
	| "error"
	| "info"
	| "terminal"
	| "command"
	| "refresh"
	| "external"
	| "lock"
	| "shield"
	| "file"
	| "git"
	| "paperclip"
	| "arrow-down"
	| "more"
	| "search"
	| "message"
	| "agent"
	| "trash"
	| "download"
	| "image"
	| "reload"
	| "minus"
	| "maximize";

const PATHS: Record<IconName, string> = {
	plus: "M12 5v14M5 12h14",
	folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
	"folder-open": "M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H3zM3 10h18l-2.2 7.2a2 2 0 0 1-1.9 1.4H5.1a2 2 0 0 1-1.9-1.4z",
	send: "M4 12 20 4l-4 16-4-7zM12 13l8-9",
	stop: "M7 7h10v10H7z",
	settings:
		"M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z",
	cpu: "M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3M6 6h12v12H6zM10 10h4v4h-4z",
	sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
	"panel-right": "M4 5h16v14H4zM15 5v14",
	"chevron-down": "m6 9 6 6 6-6",
	"chevron-right": "m9 6 6 6-6 6",
	"chevron-up": "m6 15 6-6 6 6",
	close: "M6 6l12 12M18 6 6 18",
	copy: "M9 9h10v10H9zM5 15V5h10",
	check: "m4 12 5 5L20 6",
	warning: "M12 4 3 20h18zM12 9v5M12 17h.01",
	error: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5M12 16h.01",
	info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01",
	terminal: "M4 5h16v14H4zM7 9l3 3-3 3M12 15h4",
	command: "M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z",
	refresh: "M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5",
	external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
	lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3",
	shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
	file: "M6 3h8l4 4v14H6zM14 3v5h5",
	git: "M6 4v9M6 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9v3a3 3 0 0 1-3 3h-3a3 3 0 0 0-3 3v1",
	paperclip: "m20 11-8.5 8.5a4 4 0 0 1-5.66-5.66L14.6 5.1a3 3 0 0 1 4.24 4.24l-8.49 8.49a2 2 0 0 1-2.83-2.83L15 7.5",
	"arrow-down": "M12 4v16M6 14l6 6 6-6",
	more: "M5 12h.01M12 12h.01M19 12h.01",
	search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
	message: "M4 5h16v11H8l-4 4z",
	agent: "M12 3a3 3 0 0 1 3 3v1h2a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3h2V6a3 3 0 0 1 3-3zM9 13h.01M15 13h.01M9.5 17h5",
	trash: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6",
	download: "M12 4v12M6 10l6 6 6-6M4 20h16",
	image: "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M9 9h.01",
	reload: "M4 12a8 8 0 0 1 13.66-5.66L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.66 5.66L4 16M4 20v-4h4",
	minus: "M5 12h14",
	maximize: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
};

export function Icon({
	name,
	size = 16,
	className,
	...rest
}: { name: IconName; size?: number; className?: string } & Omit<SVGProps<SVGSVGElement>, "name">) {
	return (
		<svg
			className={className ? `icon ${className}` : "icon"}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
			{...rest}
		>
			<path d={PATHS[name]} />
		</svg>
	);
}
