import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { MessageKey } from "./pt-BR";
import { translate } from "./translate";
import { intlLocale, type Locale, type MessageParams } from "./types";

export type { Locale, MessageParams } from "./types";
export { LOCALES, LOCALE_LABELS, detectLocale, isLocale } from "./types";
export type { MessageKey } from "./pt-BR";
export { translate } from "./translate";

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export interface I18nValue {
	locale: Locale;
	t: Translate;
	formatDate: (value: number | Date | undefined, options?: Intl.DateTimeFormatOptions) => string | undefined;
	formatNumber: (value: number | undefined, options?: Intl.NumberFormatOptions) => string | undefined;
	formatPercent: (value: number | undefined) => string;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();

function dateFormatter(tag: string, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	const key = `${tag}|${options ? JSON.stringify(options) : ""}`;
	let formatter = dateFormatters.get(key);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat(tag, options ?? { dateStyle: "short", timeStyle: "short" });
		dateFormatters.set(key, formatter);
	}
	return formatter;
}

function numberFormatter(tag: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
	const key = `${tag}|${options ? JSON.stringify(options) : ""}`;
	let formatter = numberFormatters.get(key);
	if (!formatter) {
		formatter = new Intl.NumberFormat(tag, options);
		numberFormatters.set(key, formatter);
	}
	return formatter;
}

export function createI18n(locale: Locale): I18nValue {
	const tag = intlLocale(locale);
	return {
		locale,
		t: (key, params) => translate(locale, key, params),
		formatDate: (value, options) => {
			if (value === undefined) return undefined;
			const date = value instanceof Date ? value : new Date(value);
			if (Number.isNaN(date.getTime())) return undefined;
			return dateFormatter(tag, options).format(date);
		},
		formatNumber: (value, options) => {
			if (value === undefined || !Number.isFinite(value)) return undefined;
			return numberFormatter(tag, options).format(value);
		},
		formatPercent: (value) => {
			if (value === undefined || !Number.isFinite(value)) {
				return translate(locale, "common.unavailable");
			}
			return numberFormatter(tag, { style: "percent", maximumFractionDigits: 1 }).format(value / 100);
		},
	};
}

const I18nContext = createContext<I18nValue>(createI18n("pt-BR"));

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
	const value = useMemo(() => createI18n(locale), [locale]);
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
	return useContext(I18nContext);
}

/** Atalho para o caso mais comum: só o `t`. */
export function useT(): Translate {
	const { t } = useI18n();
	return useCallback<Translate>((key, params) => t(key, params), [t]);
}
