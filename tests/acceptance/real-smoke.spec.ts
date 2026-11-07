import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, quit } from "./helpers";

// Usa o OMP real e consome cota: só roda com REAL_OMP=1.
test.skip(!process.env.REAL_OMP, "defina REAL_OMP=1 para o smoke real");

test("smoke real: runner cria smoke-omp.txt", async () => {
	test.setTimeout(600_000);
	const l = await launch("basic");
	const { page } = l;
	await page.getByText("workspace", { exact: true }).first().click();
	await page.getByRole("button", { name: "Criar sessão" }).click();
	const box = page.locator("textarea").first();
	await expect(box).toBeVisible({ timeout: 60_000 });
	await page.screenshot({ path: "test-results/real-1-sessao.png" });
	await box.fill(
		"Use a ferramenta task para delegar a um runner a criação do arquivo smoke-omp.txt neste diretório com exatamente o conteúdo: runner-ok (sem quebra de linha extra). Depois responda apenas: concluído.",
	);
	await box.press("Enter");
	const file = join(l.workspace, "smoke-omp.txt");
	await expect.poll(() => existsSync(file), { timeout: 500_000, intervals: [3000] }).toBe(true);
	expect(readFileSync(file, "utf8").trim()).toBe("runner-ok");
	await page.waitForTimeout(8000);
	const win = await l.app.evaluate(async ({ BrowserWindow }) => {
		const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
		return img.toPNG().toString("base64");
	});
	writeFileSync("test-results/real-2-janela.png", Buffer.from(win, "base64"));
	writeFileSync("test-results/real-main-text.txt", await page.locator("body").innerText());
	await l.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
	await l.app.waitForEvent("close", { timeout: 60_000 }).catch(() => undefined);

	// Reabrir com o mesmo perfil: histórico restaurado sem novo prompt.
	const again = await launch("basic", {}, { workspace: l.workspace, userData: l.userData });
	await again.page.getByText("workspace", { exact: true }).first().click();
	await expect(again.page.getByText("concluído").first()).toBeVisible({ timeout: 90_000 });
	await again.page.waitForTimeout(3000);
	await again.page.screenshot({ path: "test-results/real-3-reaberto.png" });
	expect(readFileSync(file, "utf8").trim()).toBe("runner-ok");
	await quit(again);
});
