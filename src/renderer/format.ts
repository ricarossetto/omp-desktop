import { translate } from "./i18n/translate";
import type { Locale } from "./i18n/types";

const clockFormatters = new Map<Locale, Intl.DateTimeFormat>();
const dateTimeFormatters = new Map<Locale, Intl.DateTimeFormat>();
const dayFormatters = new Map<Locale, Intl.DateTimeFormat>();
const decimalFormatters = new Map<Locale, Intl.NumberFormat>();

function clock(locale: Locale): Intl.DateTimeFormat {
	let formatter = clockFormatters.get(locale);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
		clockFormatters.set(locale, formatter);
	}
	return formatter;
}

function dateTime(locale: Locale): Intl.DateTimeFormat {
	let formatter = dateTimeFormatters.get(locale);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(locale, {
			day: "2-digit",
			month: "2-digit",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
		dateTimeFormatters.set(locale, formatter);
	}
	return formatter;
}

function dayOnly(locale: Locale): Intl.DateTimeFormat {
	let formatter = dayFormatters.get(locale);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit" });
		dayFormatters.set(locale, formatter);
	}
	return formatter;
}

function decimal(locale: Locale): Intl.NumberFormat {
	let formatter = decimalFormatters.get(locale);
	if (!formatter) {
		formatter = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
		decimalFormatters.set(locale, formatter);
	}
	return formatter;
}

export function formatClock(timestamp: number | undefined, locale: Locale = "pt-BR"): string {
	if (!timestamp) return "";
	return clock(locale).format(new Date(timestamp));
}

export function formatDateTime(timestamp: number | undefined, locale: Locale = "pt-BR"): string {
	if (!timestamp) return "";
	return dateTime(locale).format(new Date(timestamp));
}

export function formatRelative(timestamp: number | undefined, locale: Locale = "pt-BR", now = Date.now()): string {
	if (!timestamp) return "";
	const delta = Math.max(0, now - timestamp);
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 1) return translate(locale, "format.now");
	if (minutes < 60) return translate(locale, "format.minutesAgo", { count: minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return translate(locale, "format.hoursAgo", { count: hours });
	const days = Math.floor(hours / 24);
	if (days === 1) return translate(locale, "format.yesterday");
	if (days < 7) return translate(locale, "format.daysAgo", { count: days });
	return dayOnly(locale).format(new Date(timestamp));
}

export function formatBytes(size: number, locale: Locale = "pt-BR"): string {
	if (!Number.isFinite(size) || size <= 0) return "0 B";
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${decimal(locale).format(size / 1024)} KB`;
	return `${decimal(locale).format(size / (1024 * 1024))} MB`;
}

export function formatModelLabel(
	model: { provider: string; id: string; name?: string } | undefined,
	locale: Locale = "pt-BR",
): string {
	if (!model) return translate(locale, "common.modelUnknown");
	return model.name?.trim() || model.id;
}

export function formatThinking(level: string | undefined, locale: Locale = "pt-BR"): string {
	if (!level) return translate(locale, "format.thinkingUnknown");
	const keys = {
		off: "format.thinkingOff",
		minimal: "format.thinkingMinimal",
		low: "format.thinkingLow",
		medium: "format.thinkingMedium",
		high: "format.thinkingHigh",
		xhigh: "format.thinkingMax",
	} as const;
	const key = keys[level as keyof typeof keys];
	return key ? translate(locale, key) : translate(locale, "format.thinkingCustom", { level });
}
