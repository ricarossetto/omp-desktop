/** Idiomas suportados pelo aplicativo. */
export const LOCALES = ["pt-BR", "en-US", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
	"pt-BR": "Português (Brasil)",
	"en-US": "English (US)",
	"zh-CN": "简体中文",
};

/** Parâmetros de interpolação: `t("ola", { nome })` troca `{nome}` no texto. */
export type MessageParams = Record<string, string | number>;

export function isLocale(value: unknown): value is Locale {
	return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Escolhe o idioma inicial a partir do sistema, com pt-BR como padrão.
 *
 * zh-TW/zh-HK (chinês tradicional) caem em zh-CN porque esta entrega só tem
 * dicionário simplificado; o usuário pode trocar depois em Configurações.
 * Mantido de propósito até existir uma tradução tradicional.
 */
export function detectLocale(language: string | undefined): Locale {
	const tag = (language ?? "").toLowerCase();
	if (tag.startsWith("zh")) return "zh-CN";
	if (tag.startsWith("en")) return "en-US";
	if (tag.startsWith("pt")) return "pt-BR";
	return "pt-BR";
}

/** `Intl` por idioma: datas, números e percentuais seguem o locale escolhido. */
export function intlLocale(locale: Locale): string {
	return locale;
}
