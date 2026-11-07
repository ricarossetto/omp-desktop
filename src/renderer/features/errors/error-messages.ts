import { ERROR_CODES } from "@shared/contracts";
import type { MessageKey, Translate } from "../../i18n";
import { translate } from "../../i18n/translate";
import type { Locale } from "../../i18n/types";
import { DesktopError } from "../../api";

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(ERROR_CODES);

/** Código de erro do main/host, quando presente. */
export function errorCode(error: unknown): string | undefined {
	if (error instanceof DesktopError) return error.body.code;
	if (typeof error === "object" && error !== null && "code" in error) {
		return typeof error.code === "string" ? error.code : undefined;
	}
	return undefined;
}

/**
 * Detalhe técnico devolvido pelo host. Nunca é a mensagem principal de uma
 * tela traduzida: serve de detalhe ao lado da chave `error.<CODE>` e de
 * fallback quando o código é desconhecido.
 */
export function errorDetail(error: unknown): string | undefined {
	if (error instanceof DesktopError) return error.body.message || undefined;
	if (error instanceof Error) return error.message || undefined;
	if (typeof error === "string") return error.trim() ? error : undefined;
	if (typeof error === "object" && error !== null && "message" in error) {
		return typeof error.message === "string" && error.message.trim() ? error.message : undefined;
	}
	return undefined;
}

/**
 * Mensagem de erro para o usuário no idioma ativo. Códigos conhecidos viram
 * `error.<CODE>`; a mensagem do host entra apenas como `{detail}`. Códigos
 * desconhecidos e erros sem código usam o detalhe como fallback.
 */
export function localizeError(error: unknown, t: Translate): string {
	const code = errorCode(error);
	const detail = errorDetail(error);
	if (code && KNOWN_ERROR_CODES.has(code)) {
		return t(`error.${code}` as MessageKey, { detail: detail ?? t("common.unavailable") });
	}
	return detail ?? t("error.unexpected");
}

/** Versão sem React de `localizeError`, para módulos puros fora de componentes. */
export function errorText(error: unknown, locale: Locale = "pt-BR"): string {
	return localizeError(error, (key, params) => translate(locale, key, params));
}
