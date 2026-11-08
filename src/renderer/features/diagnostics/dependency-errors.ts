import type { DependencyErrorCode } from "@shared/dependency-install-types";
import type { MessageKey } from "../../i18n";

/**
 * Tradução dos códigos estáveis do instalador de Git/Node. O `message` técnico
 * (inglês, sem segredos) continua disponível como detalhe; a UI nunca mostra o
 * código cru como texto principal.
 */
const DEPENDENCY_ERROR_KEYS: Record<DependencyErrorCode, MessageKey> = {
	UNSUPPORTED_PLATFORM: "dep.error.UNSUPPORTED_PLATFORM",
	UNSUPPORTED_ARCH: "dep.error.UNSUPPORTED_ARCH",
	NETWORK: "dep.error.NETWORK",
	HTTP_STATUS: "dep.error.HTTP_STATUS",
	CHECKSUM: "dep.error.CHECKSUM",
	ARCHIVE_INVALID: "dep.error.ARCHIVE_INVALID",
	PATH_ESCAPE: "dep.error.PATH_ESCAPE",
	SIZE_LIMIT: "dep.error.SIZE_LIMIT",
	WRITE: "dep.error.WRITE",
	EXISTING_INCOMPATIBLE: "dep.error.EXISTING_INCOMPATIBLE",
	INCOMPLETE_INSTALL: "dep.error.INCOMPLETE_INSTALL",
	VERSION_MISMATCH: "dep.error.VERSION_MISMATCH",
	PROBE_FAILED: "dep.error.PROBE_FAILED",
	MANUAL_INSTALL_REQUIRED: "dep.error.MANUAL_INSTALL_REQUIRED",
	MISSING_SYSTEM_LIBRARY: "dep.error.MISSING_SYSTEM_LIBRARY",
	ABORTED: "dep.error.ABORTED",
	INTERNAL: "dep.error.INTERNAL",
};

export function dependencyErrorKey(code: string | undefined): MessageKey {
	if (code && Object.hasOwn(DEPENDENCY_ERROR_KEYS, code)) {
		return DEPENDENCY_ERROR_KEYS[code as DependencyErrorCode];
	}
	return "dep.error.INTERNAL";
}
