/**
 * Contrato puro (main + renderer) da instalação das dependências opcionais
 * Git e Node.js. Nenhuma URL, versão, comando ou pasta trafega pelo renderer:
 * o main resolve tudo a partir de fontes oficiais fixas e devolve apenas os
 * estados abaixo.
 *
 * Este arquivo não importa `node:*` nem Electron; pode ser incluído pelo
 * renderer e pelo preload sem puxar código de processo principal.
 */

/** Ferramentas opcionais que o aplicativo sabe instalar sozinho. */
export const DEPENDENCY_KINDS = ["git", "node"] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/** Fases observáveis de uma instalação (mesmo vocabulário do instalador do OMP). */
export const DEPENDENCY_INSTALL_PHASES = [
	"resolving",
	"downloading",
	"verifying",
	"extracting",
	"activating",
] as const;
export type DependencyInstallPhase = (typeof DEPENDENCY_INSTALL_PHASES)[number];

/**
 * Códigos técnicos estáveis (mensagens em inglês, sem segredos). O renderer
 * traduz cada código; `message` é detalhe técnico e não deve ser exibido cru.
 *
 * - `EXISTING_INCOMPATIBLE`: já existe uma instalação no destino gerenciado
 *   que não pôde ser adotada; nada é sobrescrito.
 * - `INCOMPLETE_INSTALL`: pasta gerenciada existe sem o executável esperado.
 * - `NETWORK` / `HTTP_STATUS`: resolução, TLS, timeout ou resposta oficial.
 * - `CHECKSUM`: SHA-256 ou tamanho divergente do artefato oficial.
 * - `ARCHIVE_INVALID` / `PATH_ESCAPE` / `SIZE_LIMIT`: ZIP corrompido, entrada
 *   fora da pasta de extração, symlink ou limite de tamanho excedido.
 * - `VERSION_MISMATCH` / `PROBE_FAILED`: `--version` do executável extraído
 *   não confere ou não executou.
 * - `ABORTED`: cancelamento do usuário/fechamento do aplicativo.
 * - `INTERNAL`: falha inesperada sem detalhe seguro para o usuário.
 *
 * Instalação já existente e compatível NÃO é erro: `install()` devolve
 * `DependencyInstallResult` sem baixar nada.
 */
export const DEPENDENCY_ERROR_CODES = [
	"UNSUPPORTED_PLATFORM",
	"UNSUPPORTED_ARCH",
	"NETWORK",
	"HTTP_STATUS",
	"CHECKSUM",
	"ARCHIVE_INVALID",
	"PATH_ESCAPE",
	"SIZE_LIMIT",
	"WRITE",
	"EXISTING_INCOMPATIBLE",
	"INCOMPLETE_INSTALL",
	"VERSION_MISMATCH",
	"PROBE_FAILED",
	"ABORTED",
	"INTERNAL",
] as const;
export type DependencyErrorCode = (typeof DEPENDENCY_ERROR_CODES)[number];

export interface DependencyInstallProgress {
	phase: DependencyInstallPhase;
	receivedBytes?: number;
	totalBytes?: number;
}

/**
 * Resultado de uma sondagem local (sem rede, sem escrita):
 * - `installed`: executável respondeu `--version`;
 * - `missing`: não há instalação gerenciada nem executável no PATH;
 * - `error`: havia algo no caminho esperado, mas não é utilizável.
 */
export type DependencyProbe =
	| { state: "installed"; kind: DependencyKind; executablePath: string; version: string }
	| { state: "missing"; kind: DependencyKind }
	| { state: "error"; kind: DependencyKind; code: DependencyErrorCode; message: string };

/** Resultado de uma instalação concluída (baixada ou já existente/adotada). */
export interface DependencyInstallResult {
	kind: DependencyKind;
	executablePath: string;
	version: string;
}

export interface DependencyInstallOptions {
	signal?: AbortSignal;
	onProgress?(progress: DependencyInstallProgress): void;
}

/**
 * Snapshot devolvido por `runtime.dependencies`: sempre os dois tipos, com
 * `missing` quando a ferramenta não está disponível. Nunca inventa versões.
 */
export type DependencySnapshot = Record<DependencyKind, DependencyProbe>;

/**
 * Estado observável pelo renderer: o snapshot de sondagem mais o estado
 * transitório `installing` (com fase/progresso) enquanto uma instalação roda.
 * `DependencyProbe` continua sendo o contrato puro de sondagem.
 */
export type DependencyRuntimeState =
	| DependencyProbe
	| {
			state: "installing";
			kind: DependencyKind;
			phase: DependencyInstallPhase;
			receivedBytes?: number;
			totalBytes?: number;
	  };

export type DependencyRuntimeSnapshot = Record<DependencyKind, DependencyRuntimeState>;
