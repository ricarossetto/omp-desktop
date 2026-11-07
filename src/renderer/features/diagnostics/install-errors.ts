import type { MessageKey } from "../../i18n";

/**
 * Códigos técnicos do instalador do OMP → chave localizada do diagnóstico.
 * Compartilhado entre a tela de diagnóstico e os avisos do store para que um
 * erro como `timeout` nunca apareça cru no idioma ativo.
 */
const INSTALL_ERROR_KEYS: Record<string, MessageKey> = {
	EXISTING_INCOMPATIBLE: "diag.installErrorExisting",
	NETWORK: "diag.installErrorNetwork",
	CHECKSUM: "diag.installErrorChecksum",
	VERSION_MISMATCH: "diag.installErrorVersion",
	WRITE: "diag.installErrorWrite",
	ABORTED: "diag.installCancelled",
	ACTIVATION_FAILED: "diag.installErrorActivation",
	UNSUPPORTED_PLATFORM: "diag.installErrorUnsupported",
};

export function installErrorKey(code: string): MessageKey {
	return INSTALL_ERROR_KEYS[code] ?? "diag.installErrorGeneric";
}
