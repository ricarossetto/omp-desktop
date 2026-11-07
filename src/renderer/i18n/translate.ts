import { enUS } from "./en-US";
import { ptBR, type MessageKey } from "./pt-BR";
import type { Locale, MessageParams } from "./types";
import { zhCN } from "./zh-CN";

const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = {
	"pt-BR": ptBR,
	"en-US": enUS,
	"zh-CN": zhCN,
};

function interpolate(template: string, params?: MessageParams): string {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) =>
		Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
	);
}

/** Traduz sem React (para módulos puros); cai no pt-BR quando a chave faltar. */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
	const dictionary = DICTIONARIES[locale] ?? ptBR;
	return interpolate(dictionary[key] ?? ptBR[key] ?? key, params);
}
