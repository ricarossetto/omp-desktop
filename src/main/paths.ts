/**
 * Validação de caminhos relativos ao workspace.
 *
 * Regras universais:
 * - Somente caminhos relativos; `..`, NUL e caracteres de controle são recusados.
 * - O caminho final precisa continuar dentro do workspace depois de resolver symlinks.
 *
 * Regras adicionais do Windows: absolutos/UNC/drive-relativo, ADS
 * (`arquivo:stream`) e caracteres inválidos (`<>"|?*`). No POSIX esses nomes
 * são válidos e não podem ser recusados; a barra invertida continua aceita
 * como separador de entrada por compatibilidade com o renderer.
 *
 * Este módulo não importa `electron` para poder ser testado com bun test.
 */
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";

export const MAX_RELATIVE_PATH_LENGTH = 4096;

export class PathValidationError extends Error {
	readonly code = "FORBIDDEN_PATH" as const;

	constructor(message: string) {
		super(message);
		this.name = "PathValidationError";
	}
}

const WINDOWS = process.platform === "win32";
/** No Windows a barra invertida também separa; no POSIX ela é um caractere válido. */
const SEPARATORS = WINDOWS ? /[\\/]+/ : /\//;

/** Separa um caminho em segmentos validados (sem `..`, sem ADs, sem vazio). */
export function validateRelativePath(input: unknown): string {
	if (typeof input !== "string" || input.length === 0) {
		throw new PathValidationError("Informe um caminho relativo ao projeto.");
	}
	if (input.length > MAX_RELATIVE_PATH_LENGTH) {
		throw new PathValidationError("O caminho é longo demais.");
	}
	if (input.includes("\0")) {
		throw new PathValidationError("O caminho contém um byte nulo.");
	}
	// Controle (inclui quebra de linha) corromperia logs e o protocolo; é uma
	// regra de segurança do aplicativo, não uma regra do Windows.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f]/.test(input)) {
		throw new PathValidationError("O caminho contém caracteres de controle.");
	}
	if (WINDOWS) {
		if (/^[a-zA-Z]:/.test(input)) {
			throw new PathValidationError("Caminhos absolutos não são permitidos; use um caminho relativo ao projeto.");
		}
		if (input.startsWith("\\\\") || input.startsWith("//")) {
			throw new PathValidationError("Caminhos de rede (UNC) não são permitidos.");
		}
	}
	if (input.startsWith("/") || (WINDOWS && input.startsWith("\\"))) {
		throw new PathValidationError("Caminhos absolutos não são permitidos; use um caminho relativo ao projeto.");
	}
	const segments = input.split(SEPARATORS);
	const result: string[] = [];
	for (const segment of segments) {
		if (segment.length === 0 || segment === ".") continue;
		if (segment === "..") {
			throw new PathValidationError("O caminho não pode sair do projeto (..).");
		}
		if (WINDOWS) {
			if (segment.includes(":")) {
				throw new PathValidationError("O caminho contém um fluxo alternativo (:) não permitido.");
			}
			if (/[<>"|?*]/.test(segment)) {
				throw new PathValidationError("O caminho contém caracteres inválidos no Windows.");
			}
		}
		result.push(segment);
	}
	if (result.length === 0) {
		throw new PathValidationError("Informe um arquivo dentro do projeto.");
	}
	return result.join("/");
}

/** Compara caminhos respeitando a insensibilidade a maiúsculas do Windows. */
function compareKey(value: string): string {
	return WINDOWS ? value.toLowerCase() : value;
}

/** `candidate` está dentro de `root` (inclusive o próprio root)? */
export function isWithin(rootAbs: string, candidateAbs: string): boolean {
	const root = path.resolve(rootAbs);
	const candidate = path.resolve(candidateAbs);
	const a = compareKey(root);
	const b = compareKey(candidate);
	if (a === b) return true;
	const prefix = a.endsWith(path.sep) ? a : a + path.sep;
	return b.startsWith(prefix);
}

export interface ResolvedWorkspacePath {
	/** Caminho absoluto nominal (pode conter symlink). */
	absPath: string;
	/** Caminho real, sem symlinks. */
	realPath: string;
	/** Raiz real do workspace. */
	rootRealPath: string;
	/** Caminho relativo normalizado (barras). */
	relativePath: string;
}

async function realpathOrUndefined(value: string): Promise<string | undefined> {
	try {
		return await realpath(value);
	} catch {
		return undefined;
	}
}

/**
 * Resolve um caminho existente dentro do workspace.
 * Recusa traversal, caminhos absolutos e symlinks que apontem para fora.
 */
export async function resolveWorkspacePath(rootAbs: string, relativePath: string): Promise<ResolvedWorkspacePath> {
	const normalized = validateRelativePath(relativePath);
	const rootRealPath = await realpathOrUndefined(path.resolve(rootAbs));
	if (!rootRealPath) {
		throw new PathValidationError("O projeto não está mais disponível no disco.");
	}
	const absPath = path.resolve(rootRealPath, ...normalized.split("/"));
	if (!isWithin(rootRealPath, absPath)) {
		throw new PathValidationError("O caminho aponta para fora do projeto.");
	}
	const realPath = await realpathOrUndefined(absPath);
	if (!realPath) {
		throw new PathValidationError("O arquivo não existe dentro do projeto.");
	}
	if (!isWithin(rootRealPath, realPath)) {
		throw new PathValidationError("O caminho aponta para fora do projeto através de um link simbólico.");
	}
	return { absPath, realPath, rootRealPath, relativePath: normalized };
}

/**
 * Igual a `resolveWorkspacePath`, mas aceita o caminho quando o arquivo final
 * não existe mais (arquivo deletado no Git). O diretório pai ainda precisa
 * existir de verdade dentro do workspace.
 */
export async function resolveWorkspacePathAllowMissing(
	rootAbs: string,
	relativePath: string,
): Promise<ResolvedWorkspacePath> {
	const normalized = validateRelativePath(relativePath);
	const rootRealPath = await realpathOrUndefined(path.resolve(rootAbs));
	if (!rootRealPath) {
		throw new PathValidationError("O projeto não está mais disponível no disco.");
	}
	const absPath = path.resolve(rootRealPath, ...normalized.split("/"));
	if (!isWithin(rootRealPath, absPath)) {
		throw new PathValidationError("O caminho aponta para fora do projeto.");
	}
	const realPath = await realpathOrUndefined(absPath);
	if (realPath) {
		if (!isWithin(rootRealPath, realPath)) {
			throw new PathValidationError("O caminho aponta para fora do projeto através de um link simbólico.");
		}
		return { absPath, realPath, rootRealPath, relativePath: normalized };
	}
	const parentReal = await realpathOrUndefined(path.dirname(absPath));
	if (!parentReal) {
		throw new PathValidationError("O caminho não existe dentro do projeto.");
	}
	if (!isWithin(rootRealPath, parentReal)) {
		throw new PathValidationError("O caminho aponta para fora do projeto através de um link simbólico.");
	}
	return {
		absPath,
		realPath: path.join(parentReal, path.basename(absPath)),
		rootRealPath,
		relativePath: normalized,
	};
}

/** Valida que a pasta do workspace existe e é um diretório. */
export async function assertWorkspaceDirectory(dirAbs: string): Promise<string> {
	const real = await realpathOrUndefined(path.resolve(dirAbs));
	if (!real) {
		throw new PathValidationError("A pasta do projeto não existe mais.");
	}
	const info = await stat(real);
	if (!info.isDirectory()) {
		throw new PathValidationError("O caminho do projeto não é uma pasta.");
	}
	return real;
}

/** Nome amigável do workspace (último segmento). */
export function workspaceDisplayName(dirAbs: string): string {
	const trimmed = dirAbs.replace(/[\\/]+$/, "");
	const base = path.basename(trimmed);
	return base.length > 0 ? base : trimmed;
}
