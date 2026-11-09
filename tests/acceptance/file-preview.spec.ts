import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, quit } from "./helpers";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
	"base64",
);

test("links de arquivo abrem o preview de texto e imagem", async () => {
	const first = await launch("stream");
	try {
		writeFileSync(join(first.workspace, "smoke-omp.txt"), "conteúdo do preview");
		writeFileSync(join(first.workspace, "preview.png"), PNG);
		const p = first.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		const box = p.getByRole("textbox", { name: "Mensagem para o OMP" });
		await expect(box).toBeVisible({ timeout: 30_000 });
		await box.fill("primeira mensagem");
		await box.press("Enter");
		await expect(p.getByText("Verificado.")).toHaveCount(1, { timeout: 20_000 });

		await p.getByRole("link", { name: "smoke-omp.txt" }).click();
		const dialog = p.getByRole("dialog", { name: "Prévia do arquivo" });
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		await expect(dialog.getByText("conteúdo do preview")).toBeVisible();

		await dialog.getByRole("button", { name: "Fechar" }).click();
		await p.getByRole("link", { name: "preview.png" }).click();
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		await expect(dialog.locator("img.file-preview__image")).toBeVisible();
	} finally {
		await quit(first);
	}
});
