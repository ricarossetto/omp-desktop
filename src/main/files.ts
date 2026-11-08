/**
 * Leitura segura de arquivos do workspace e validação para abrir no editor
 * externo. Caminhos são relativos, validados por realpath dentro do projeto.
 */
import { open, stat } from "node:fs/promises";
import * as path from "node:path";
import { resolveWorkspacePath, PathValidationError } from "./paths";

export const MAX_FILE_READ_BYTES = 512 * 1024;

export interface WorkspaceFileRead {
	path: string;
	size: number;
	binary: boolean;
	truncated: boolean;
	content?: string;
}

export function isBinaryBuffer(buffer: Buffer): boolean {
	const limit = Math.min(buffer.length, 8192);
	for (let index = 0; index < limit; index += 1) {
		if (buffer[index] === 0) return true;
	}
	return false;
}

export async function readWorkspaceFile(
	rootAbs: string,
	relativePath: string,
	maxBytes = MAX_FILE_READ_BYTES,
): Promise<WorkspaceFileRead> {
	const resolved = await resolveWorkspacePath(rootAbs, relativePath);
	const info = await stat(resolved.realPath);
	if (!info.isFile()) {
		throw new PathValidationError("O caminho não é um arquivo.");
	}
	const handle = await open(resolved.realPath, "r");
	try {
		const buffer = Buffer.alloc(Math.min(info.size, maxBytes + 1));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const data = buffer.subarray(0, bytesRead);
		const binary = isBinaryBuffer(data);
		const truncated = info.size > maxBytes;
		return {
			path: resolved.relativePath,
			size: info.size,
			binary,
			truncated,
			content: binary ? undefined : data.subarray(0, maxBytes).toString("utf8"),
		};
	} finally {
		await handle.close();
	}
}

/**
 * Allowlist de extensões que podem ser entregues ao `shell.openPath`.
 *
 * Só entra aqui conteúdo que não é executado pelo sistema por associação:
 * texto, dados, imagens raster, PDF e código-fonte textual comum. Ficam de fora
 * executáveis, scripts de shell/Windows, atalhos, instaladores e conteúdo ativo
 * (HTML/SVG/XML/JS), que seguem para `shell.showItemInFolder`. Extensões
 * perigosas conhecidas (bat, cmd, ps1, vbs, wsf, hta, lnk, exe, msi, scr, com,
 * reg, jar, js, mjs, cjs…) simplesmente não pertencem à lista.
 */
const SAFE_EXTERNAL_OPEN_EXTENSIONS: Record<string, true> = {
	// texto e dados
	".txt": true,
	".log": true,
	".md": true,
	".markdown": true,
	".rst": true,
	".csv": true,
	".tsv": true,
	".json": true,
	".jsonc": true,
	".jsonl": true,
	".ndjson": true,
	".yml": true,
	".yaml": true,
	".toml": true,
	".ini": true,
	".cfg": true,
	".conf": true,
	".properties": true,
	".diff": true,
	".patch": true,
	// imagens raster e documentos
	".png": true,
	".jpg": true,
	".jpeg": true,
	".gif": true,
	".webp": true,
	".bmp": true,
	".ico": true,
	".tif": true,
	".tiff": true,
	".avif": true,
	".pdf": true,
	// código-fonte textual comum (sem scripts executáveis por associação)
	".ts": true,
	".tsx": true,
	".vue": true,
	".svelte": true,
	".astro": true,
	".css": true,
	".scss": true,
	".sass": true,
	".less": true,
	".c": true,
	".h": true,
	".cc": true,
	".cpp": true,
	".cxx": true,
	".hpp": true,
	".hxx": true,
	".cs": true,
	".java": true,
	".kt": true,
	".kts": true,
	".go": true,
	".rs": true,
	".py": true,
	".rb": true,
	".php": true,
	".swift": true,
	".m": true,
	".mm": true,
	".scala": true,
	".sc": true,
	".lua": true,
	".pl": true,
	".pm": true,
	".r": true,
	".sql": true,
	".graphql": true,
	".gql": true,
	".proto": true,
	".tf": true,
	".tfvars": true,
	".hcl": true,
	".sh": true,
	".bash": true,
	".zsh": true,
	".fish": true,
};

/** Nomes sem extensão reconhecidos como texto comum. */
const SAFE_EXTERNAL_OPEN_NAMES: Record<string, true> = {
	makefile: true,
	dockerfile: true,
	license: true,
	licence: true,
	readme: true,
	changelog: true,
	authors: true,
	notice: true,
	".gitignore": true,
	".gitattributes": true,
	".editorconfig": true,
};

/** Extensões que um desktop POSIX pode executar por associação. */
const POSIX_SCRIPT_EXTENSIONS: Record<string, true> = {
	".sh": true,
	".bash": true,
	".zsh": true,
	".fish": true,
	".command": true,
	".run": true,
};

/**
 * Decide se o arquivo pode ser entregue ao aplicativo padrão (`open`) ou se
 * deve apenas ser mostrado no gerenciador de arquivos (`reveal`). Função pura
 * e testável.
 *
 * No POSIX, scripts de shell e qualquer arquivo com bit de execução nunca vão
 * para `xdg-open`: alguns ambientes executam o arquivo em vez de abri-lo no
 * editor. O chamador confirma o bit de execução com `isExecutableFile`.
 */
export function externalOpenMode(filePath: string): "open" | "reveal" {
	const extension = path.extname(filePath).toLowerCase();
	if (extension.length > 0) {
		if (process.platform !== "win32" && POSIX_SCRIPT_EXTENSIONS[extension] === true) return "reveal";
		return SAFE_EXTERNAL_OPEN_EXTENSIONS[extension] === true ? "open" : "reveal";
	}
	return SAFE_EXTERNAL_OPEN_NAMES[path.basename(filePath).toLowerCase()] === true ? "open" : "reveal";
}

/** `true` quando o arquivo tem bit de execução (POSIX); sempre `false` no Windows. */
export async function isExecutableFile(filePath: string): Promise<boolean> {
	if (process.platform === "win32") return false;
	try {
		const info = await stat(filePath);
		return (info.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/**
 * Devolve o caminho real validado (dentro do workspace). O tipo do arquivo é
 * decidido por `externalOpenMode` antes de qualquer `shell.openPath`.
 */
export async function resolveFileForExternalOpen(rootAbs: string, relativePath: string): Promise<string> {
	const resolved = await resolveWorkspacePath(rootAbs, relativePath);
	const info = await stat(resolved.realPath);
	if (!info.isFile()) {
		throw new PathValidationError("Somente arquivos podem ser abertos no editor externo.");
	}
	return resolved.realPath;
}
