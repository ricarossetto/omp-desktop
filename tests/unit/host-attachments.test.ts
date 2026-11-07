import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AttachmentError, AttachmentStore, commandFits } from "../../src/host/attachments";

const dirs: string[] = [];

async function store(): Promise<AttachmentStore> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-attach-"));
	dirs.push(dir);
	return new AttachmentStore(dir);
}

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.from("fake-png-body"),
]);

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe("attachments", () => {
	test("imagem válida vira ImageContent; texto vira bloco delimitado; PDF vira referência", async () => {
		const attachments = await store();
		const image = await attachments.add({
			workspaceId: "ws",
			name: "foto.png",
			mimeType: "image/png",
			bytesBase64: PNG.toString("base64"),
		});
		expect(image.kind).toBe("image");
		const text = await attachments.add({
			workspaceId: "ws",
			name: "nota.txt",
			mimeType: "text/plain",
			bytesBase64: Buffer.from("conteúdo do anexo", "utf8").toString("base64"),
		});
		expect(text.kind).toBe("text");
		const pdf = await attachments.add({
			workspaceId: "ws",
			name: "doc.pdf",
			mimeType: "application/pdf",
			bytesBase64: Buffer.from("%PDF-1.7 fake", "utf8").toString("base64"),
		});
		expect(pdf.kind).toBe("file");
		const resolved = attachments.resolveForPrompt([image.attachmentId, text.attachmentId, pdf.attachmentId], {
			workspaceId: "ws",
			supportsImages: true,
		});
		expect(resolved.images).toHaveLength(1);
		expect(resolved.images[0].mimeType).toBe("image/png");
		expect(resolved.textSuffix).toContain("nota.txt");
		expect(resolved.textSuffix).toContain("conteúdo do anexo");
		expect(resolved.textSuffix).toContain("doc.pdf");
		expect(resolved.textSuffix).toContain("não enviado ao modelo");
	});

	test("imagem com assinatura inválida é recusada e não fica registrada", async () => {
		const attachments = await store();
		let failure: unknown;
		try {
			await attachments.add({
				workspaceId: "ws",
				name: "falsa.png",
				mimeType: "image/png",
				bytesBase64: Buffer.from("não é png").toString("base64"),
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AttachmentError);
		expect((failure as AttachmentError).code).toBe("INVALID_REQUEST");
	});

	test("modelo sem suporte a imagem recusa o anexo e mantém o handle", async () => {
		const attachments = await store();
		const image = await attachments.add({
			workspaceId: "ws",
			name: "foto.png",
			mimeType: "image/png",
			bytesBase64: PNG.toString("base64"),
		});
		let failure: unknown;
		try {
			attachments.resolveForPrompt([image.attachmentId], { workspaceId: "ws", supportsImages: false });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AttachmentError);
		expect((failure as AttachmentError).code).toBe("UNSUPPORTED");
		expect(attachments.get(image.attachmentId)).toBeDefined();
	});

	test("anexo de outro workspace é recusado", async () => {
		const attachments = await store();
		const text = await attachments.add({
			workspaceId: "ws-a",
			name: "a.txt",
			mimeType: "text/plain",
			bytesBase64: Buffer.from("a").toString("base64"),
		});
		expect(() =>
			attachments.resolveForPrompt([text.attachmentId], { workspaceId: "ws-b", supportsImages: true }),
		).toThrow(AttachmentError);
	});

	test("prompt de arquivo anexado não vaza caminho absoluto, só nome e referência", async () => {
		const attachments = await store();
		const pdf = await attachments.add({
			workspaceId: "ws",
			name: "doc.pdf",
			mimeType: "application/pdf",
			bytesBase64: Buffer.from("%PDF-1.4 fake").toString("base64"),
		});
		const resolved = attachments.resolveForPrompt([pdf.attachmentId], {
			workspaceId: "ws",
			supportsImages: true,
		});
		expect(resolved.textSuffix).toContain("doc.pdf");
		expect(resolved.textSuffix).toContain(pdf.attachmentId);
		expect(resolved.textSuffix).not.toContain(os.tmpdir());
		expect(resolved.textSuffix).not.toMatch(/[A-Za-z]:\\/);
	});

	test("boot remove binários órfãos de anexos e preserva arquivos alheios", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-attach-clean-"));
		dirs.push(dir);
		const attachments = new AttachmentStore(dir);
		const pdf = await attachments.add({
			workspaceId: "ws",
			name: "antigo.pdf",
			mimeType: "application/pdf",
			bytesBase64: Buffer.from("%PDF-1.4 antigo").toString("base64"),
		});
		const folder = path.join(dir, "attachments");
		await fs.promises.writeFile(path.join(folder, "keep-me.txt"), "não é anexo", "utf8");
		const removed = await new AttachmentStore(dir).cleanupOrphans();
		expect(removed).toBe(1);
		const names = await fs.promises.readdir(folder);
		expect(names).toContain("keep-me.txt");
		expect(names.some((name) => name.includes(pdf.attachmentId))).toBe(false);
	});

	test("remove apaga o arquivo temporário", async () => {
		const attachments = await store();
		const pdf = await attachments.add({
			workspaceId: "ws",
			name: "doc.pdf",
			mimeType: "application/pdf",
			bytesBase64: Buffer.from("%PDF-1.7 fake", "utf8").toString("base64"),
		});
		const handle = attachments.get(pdf.attachmentId);
		expect(handle?.filePath).toBeTruthy();
		await attachments.remove(pdf.attachmentId);
		expect(attachments.get(pdf.attachmentId)).toBeUndefined();
		expect(fs.existsSync(handle?.filePath ?? "")).toBe(false);
	});

	test("limite do frame é medido antes da escrita", () => {
		expect(commandFits({ type: "prompt", message: "oi" }, 1024).fits).toBe(true);
		expect(commandFits({ type: "prompt", message: "x".repeat(2048) }, 1024).fits).toBe(false);
	});
});
