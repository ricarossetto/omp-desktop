import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import { launch, quit } from "./helpers";

mkdirSync("test-results", { recursive: true });

test("janela abre no tamanho configurado (limitado à tela) com shell real e sem erros", async () => {
	const l = await launch("stream");
	const { app, page, errors } = l;
	await page.getByText("workspace", { exact: true }).first().click();
	await expect(page.getByRole("button", { name: "Nova sessão" }).first()).toBeVisible();
	const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workAreaSize);
	const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
	// Em telas menores que 1440 px o Windows limita a janela à área útil; o teste
	// verifica o maior tamanho que o ambiente permite, sem depender do monitor do CI.
	expect(size.w).toBe(Math.min(1440, workArea.width));
	expect(size.w).toBeGreaterThanOrEqual(1000);
	await page.screenshot({ path: "test-results/shell-1440.png" });
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
	await page.waitForTimeout(500);
	await page.screenshot({ path: "test-results/shell-1000.png" });
	expect(errors).toEqual([]);
	await quit(l);
});

test("enviar texto: streaming, tool card e resposta final únicos", async () => {
	const l = await launch("stream");
	const { page, errors } = l;
	await page.getByText("workspace", { exact: true }).first().click();
	await page.getByRole("button", { name: "Criar sessão" }).click();
	const box = page.locator("textarea").first();
	await expect(box).toBeVisible({ timeout: 30_000 });
	await box.fill("olá fixture");
	await box.press("Enter");
	await expect(page.getByText("Verificado.")).toHaveCount(1, { timeout: 20_000 });
	await expect(page.getByText("smoke-omp.txt").first()).toBeVisible();
	await expect(box).toHaveValue("");
	await page.screenshot({ path: "test-results/conversa.png" });
	expect(errors).toEqual([]);
	await quit(l);
});

test("terminal PTY real executa comando no workspace", async () => {
	const l = await launch("basic");
	const { page } = l;
	expect(existsSync(l.workspace)).toBe(true);
	await page.getByText("workspace", { exact: true }).first().click();
	await page.keyboard.press("Control+`");
	await expect(page.getByText("Conectado")).toBeVisible({ timeout: 20_000 });
	await page.waitForTimeout(1500);
	await page.keyboard.type("Write-Output 'terminal-ok'\n");
	await expect(page.locator(".xterm-rows")).toContainText("terminal-ok", { timeout: 15_000 });
	await page.screenshot({ path: "test-results/terminal.png" });
	await quit(l);
});
