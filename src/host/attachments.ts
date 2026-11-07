/**
 * Anexos do compositor.
 *
 * - Handles ficam no host (memória + arquivo temporário para binários), nunca no
 *   renderer.
 * - Imagem png/jpeg/gif/webp vira ImageContent base64 (assinatura validada).
 * - Texto vira bloco delimitado com nome e conteúdo explícito.
 * - PDF/binário vira referência de arquivo; nada é enviado ocultamente.
 * - O limite do frame JSON/base64 é verificado antes da escrita.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import type { AttachmentDto } from "../shared/contracts";
import { isRecord } from "../shared/session-state";

export type AttachmentKind = "image" | "text" | "file";

export interface AttachmentHandle {
	attachmentId: string;
	workspaceId: string;
	name: string;
	mimeType: string;
	size: number;
	kind: AttachmentKind;
	bytes: Uint8Array;
	text?: string;
	filePath?: string;
}

export interface AttachmentAddInput {
	workspaceId: string;
	name: string;
	mimeType: string;
	bytesBase64: string;
}

export interface ResolvedAttachments {
	images: Array<{ type: "image"; mimeType: string; data: string }>;
	textSuffix: string;
}

const IMAGE_SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
	"image/png": (bytes) =>
		bytes.length > 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a,
	"image/jpeg": (bytes) => bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
	"image/gif": (bytes) =>
		bytes.length > 6 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61,
	"image/webp": (bytes) =>
		bytes.length > 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50,
};

const TEXT_MIME = /^(?:text\/|application\/(?:json|xml|x-yaml|yaml|javascript|typescript|sql|toml|csv|markdown))/i;

function classify(mimeType: string, bytes: Uint8Array): AttachmentKind {
	const normalized = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
	if (Object.hasOwn(IMAGE_SIGNATURES, normalized)) {
		const signature = IMAGE_SIGNATURES[normalized];
		if (signature && !signature(bytes)) {
			throw new AttachmentError(
				"INVALID_REQUEST",
				`O arquivo não é uma imagem ${normalized} válida (a assinatura do conteúdo não confere). Anexe outro arquivo.`,
			);
		}
		return "image";
	}
	if (TEXT_MIME.test(normalized) || normalized === "application/octet-stream") {
		if (normalized === "application/octet-stream") return "file";
		return "text";
	}
	return "file";
}

export class AttachmentError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "AttachmentError";
	}
}

function decodeBase64Strict(text: string): Uint8Array {
	if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
		throw new AttachmentError("INVALID_REQUEST", "O conteúdo do anexo não é base64 válido.");
	}
	const bytes = Buffer.from(text, "base64");
	if (bytes.byteLength === 0) {
		throw new AttachmentError("INVALID_REQUEST", "O anexo está vazio.");
	}
	if (bytes.toString("base64") !== text) {
		throw new AttachmentError("INVALID_REQUEST", "O conteúdo do anexo não é base64 válido.");
	}
	return bytes;
}

function safeFileName(name: string): string {
	const base = path.basename(name.replace(/\\/g, "/"));
	const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/[. ]+$/, "");
	return cleaned.length > 0 ? cleaned.slice(0, 100) : "anexo";
}

/**
 * Limite por anexo: o OMP recebe o prompt em um único frame JSON de 1 MiB e o
 * base64 cresce ~4/3. 600 KiB deixa folga para texto e metadados do turno.
 */
const MAX_ATTACHMENT_BYTES = 600 * 1024;

export class AttachmentStore {
	private readonly records = new Map<string, AttachmentHandle>();
	private readonly dir: string;

	constructor(dataDir: string) {
		this.dir = path.join(dataDir, "attachments");
	}

	async add(input: AttachmentAddInput): Promise<AttachmentDto> {
		const bytes = decodeBase64Strict(input.bytesBase64);
		if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
			throw new AttachmentError(
				"FRAME_TOO_LARGE",
				`O anexo ${input.name} tem ${(bytes.byteLength / 1024).toFixed(0)} KiB; o limite por anexo é ${MAX_ATTACHMENT_BYTES / 1024} KiB, porque o prompt inteiro precisa caber em um frame do OMP.`,
			);
		}
		const kind = classify(input.mimeType, bytes);
		const attachmentId = `att_${randomUUID()}`;
		const record: AttachmentHandle = {
			attachmentId,
			workspaceId: input.workspaceId,
			name: safeFileName(input.name),
			mimeType: input.mimeType,
			size: bytes.byteLength,
			kind,
			bytes,
		};
		if (kind === "text") {
			try {
				record.text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				throw new AttachmentError(
					"INVALID_REQUEST",
					`O arquivo ${record.name} foi marcado como texto, mas não está em UTF-8. Anexe-o como binário.`,
				);
			}
		}
		if (kind === "file") {
			await fs.promises.mkdir(this.dir, { recursive: true });
			const filePath = path.join(this.dir, `${attachmentId}-${safeFileName(record.name)}`);
			await fs.promises.writeFile(filePath, bytes);
			record.filePath = filePath;
		}
		this.records.set(attachmentId, record);
		return this.toDto(record);
	}

	get(attachmentId: string): AttachmentHandle | undefined {
		return this.records.get(attachmentId);
	}

	async remove(attachmentId: string): Promise<void> {
		const record = this.records.get(attachmentId);
		this.records.delete(attachmentId);
		if (record?.filePath) {
			await fs.promises.unlink(record.filePath).catch(() => undefined);
		}
	}

	/**
	 * Remove no boot os binários de anexos de execuções anteriores. Handles são
	 * só memória; qualquer arquivo `att_*` na pasta é órfão de um host anterior.
	 */
	async cleanupOrphans(): Promise<number> {
		let entries: Dirent[];
		try {
			entries = await fs.promises.readdir(this.dir, { withFileTypes: true });
		} catch {
			return 0;
		}
		let removed = 0;
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.startsWith("att_")) continue;
			try {
				await fs.promises.unlink(path.join(this.dir, entry.name));
				removed += 1;
			} catch {
				/* arquivo em uso/removido: próximo boot tenta de novo */
			}
		}
		return removed;
	}

	private toDto(record: AttachmentHandle): AttachmentDto {
		return {
			attachmentId: record.attachmentId,
			name: record.name,
			mimeType: record.mimeType,
			size: record.size,
			kind: record.kind,
		};
	}

	/**
	 * Resolve handles na ordem pedida e monta `images` + bloco de texto para o
	 * prompt. Nunca aceita caminho do renderer; só o handle pertence ao workspace.
	 */
	resolveForPrompt(
		attachmentIds: readonly string[],
		options: { workspaceId: string; supportsImages: boolean },
	): ResolvedAttachments {
		const images: ResolvedAttachments["images"] = [];
		const textParts: string[] = [];
		for (const attachmentId of attachmentIds) {
			const record = this.records.get(attachmentId);
			if (!record || record.workspaceId !== options.workspaceId) {
				throw new AttachmentError(
					"INVALID_REQUEST",
					"Um dos anexos não pertence a este projeto ou expirou. Anexe o arquivo novamente.",
				);
			}
			if (record.kind === "image") {
				if (!options.supportsImages) {
					throw new AttachmentError(
						"UNSUPPORTED",
						`O modelo atual não informou suporte a imagens (ou não aceita imagens), então ${record.name} não foi enviado. Remova o anexo ou troque para um modelo que aceite imagens.`,
					);
				}
				images.push({
					type: "image",
					mimeType: record.mimeType,
					data: Buffer.from(record.bytes).toString("base64"),
				});
				continue;
			}
			if (record.kind === "text") {
				const text = record.text ?? "";
				textParts.push(`--- anexo: ${record.name} (${record.mimeType}) ---\n${text}\n--- fim do anexo ---`);
				continue;
			}
			textParts.push(
				// Sem caminho absoluto: o perfil/pasta de dados do usuário não vaza
				// para o prompt nem para o provedor. Nome + ID bastam para o humano.
				`[Arquivo anexado, não enviado ao modelo: ${record.name} (${record.mimeType}, ${record.size} bytes; referência ${record.attachmentId}). Ele fica guardado pelo aplicativo, fora do projeto.]`,
			);
		}
		return {
			images,
			textSuffix: textParts.join("\n\n"),
		};
	}
}

/** True quando um comando serializado cabe no limite físico do transporte. */
export function commandFits(command: unknown, maxBytes: number): { fits: boolean; bytes: number } {
	const bytes = Buffer.byteLength(JSON.stringify(command), "utf8") + 1;
	return { fits: bytes <= maxBytes, bytes };
}

export function isAttachmentDto(value: unknown): value is AttachmentDto {
	return isRecord(value) && typeof value.attachmentId === "string";
}
