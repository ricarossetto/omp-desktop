import { translate } from "../../i18n/translate";
import type { Locale } from "../../i18n/types";

export { errorCode, errorText } from "../errors/error-messages";

/**
 * O host devolve o `data` da resposta RPC; aceitamos também o envelope
 * `{type:'response', data}` por compatibilidade defensiva.
 */
export function unwrapRpcData(raw: unknown): unknown {
	if (!isRecord(raw)) return raw;
	if (raw.type === "response" && "data" in raw) return raw.data;
	if (raw.type === "response" && raw.success === true) return null;
	if ("response" in raw && typeof raw.response === "object" && raw.response !== null) {
		const response = raw.response;
		if ("data" in response) return response.data;
	}
	return raw;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function formatDateTime(epochMs: number | undefined, locale: Locale = "pt-BR"): string | undefined {
	if (epochMs === undefined || !Number.isFinite(epochMs) || epochMs <= 0) return undefined;
	try {
		return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
			new Date(epochMs),
		);
	} catch {
		return new Date(epochMs).toLocaleString(locale);
	}
}

export function formatPercent(value: number | undefined, locale: Locale = "pt-BR"): string {
	if (value === undefined || !Number.isFinite(value)) return translate(locale, "common.unavailable");
	return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value / 100);
}

export function formatBytes(bytes: number | undefined, locale: Locale = "pt-BR"): string | undefined {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
	const decimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${decimal.format(bytes / 1024)} KB`;
	return `${decimal.format(bytes / (1024 * 1024))} MB`;
}

export function classNames(...values: Array<string | false | null | undefined>): string {
	return values.filter(Boolean).join(" ");
}
