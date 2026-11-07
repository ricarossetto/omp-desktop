import { expect, test } from "@playwright/test";
import { launch, quit } from "./helpers";

test("reabrir o app restaura as abas e permite interagir com elas", async () => {
	const first = await launch("stream");
	const p = first.page;
	await p.getByText("workspace", { exact: true }).first().click();
	await p.getByRole("button", { name: "Criar sessão" }).click();
	const box = p.getByRole("textbox", { name: "Mensagem para o OMP" });
	await expect(box).toBeVisible({ timeout: 30_000 });
	await box.fill("primeira mensagem");
	await box.press("Enter");
	await expect(p.getByText("Verificado.")).toHaveCount(1, { timeout: 20_000 });
	// Dá tempo do estado da interface (abas) ser gravado antes de fechar.
	await p.waitForTimeout(900);
	// Fecha como o usuário (app.quit dispara o mesmo before-quit da janela).
	const closed = first.app.waitForEvent("close", { timeout: 60_000 });
	void first.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
	await closed;

	const again = await launch("stream", {}, { workspace: first.workspace, userData: first.userData });
	await again.page.getByText("workspace", { exact: true }).first().click();
	// A aba volta com o histórico e o compositor funciona nela.
	await expect(again.page.getByRole("textbox", { name: "Mensagem para o OMP" })).toBeVisible({ timeout: 60_000 });
	await expect(again.page.getByText("Verificado.")).toHaveCount(1, { timeout: 30_000 });
	await again.page.getByRole("textbox", { name: "Mensagem para o OMP" }).fill("segunda");
	await again.page.getByRole("textbox", { name: "Mensagem para o OMP" }).press("Enter");
	await expect(again.page.getByText("Verificado.")).toHaveCount(2, { timeout: 30_000 });
	await quit(again);
});
