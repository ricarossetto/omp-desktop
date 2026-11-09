import { expect, test } from "@playwright/test";
import { launch, quit } from "./helpers";

test("↑ recupera o último prompt e Ctrl+↑ abre o histórico", async () => {
	const first = await launch("stream");
	try {
		const p = first.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		const box = p.getByRole("textbox", { name: "Mensagem para o OMP" });
		await expect(box).toBeVisible({ timeout: 30_000 });

		await box.fill("primeira mensagem");
		await box.press("Enter");
		await expect(p.getByText("Verificado.")).toHaveCount(1, { timeout: 20_000 });
		await expect(box).toHaveValue("");

		await box.press("ArrowUp");
		await expect(box).toHaveValue("primeira mensagem");
		await box.press("ArrowDown");
		await expect(box).toHaveValue("");

		await box.press("Control+ArrowUp");
		const dialog = p.getByRole("dialog", { name: "Histórico de prompts" });
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		await dialog.getByRole("option", { name: "primeira mensagem" }).click();
		await expect(box).toHaveValue("primeira mensagem");
	} finally {
		await quit(first);
	}
});
