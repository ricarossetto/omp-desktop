import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export type NoticeLevel = "info" | "success" | "warning" | "error";

const ICONS: Record<NoticeLevel, IconName> = {
	info: "info",
	success: "check",
	warning: "warning",
	error: "error",
};

export function StatusIcon({ level }: { level: NoticeLevel }) {
	return <Icon name={ICONS[level]} className={`state-icon state-icon--${level}`} />;
}

export interface BannerProps {
	level: NoticeLevel;
	title?: string;
	children: ReactNode;
	action?: ReactNode;
}

export function Banner({ level, title, children, action }: BannerProps) {
	return (
		<div className={`banner banner--${level}`} role={level === "error" ? "alert" : "status"}>
			<StatusIcon level={level} />
			<div className="banner__body">
				{title ? <div className="banner__title">{title}</div> : null}
				<div>{children}</div>
			</div>
			{action}
		</div>
	);
}

export function EmptyState({
	icon,
	title,
	children,
	action,
}: {
	icon?: IconName;
	title: string;
	children?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="empty-state">
			{icon ? <Icon name={icon} size={28} className="icon--lg" /> : null}
			<h2>{title}</h2>
			{children ? <div>{children}</div> : null}
			{action}
		</div>
	);
}
