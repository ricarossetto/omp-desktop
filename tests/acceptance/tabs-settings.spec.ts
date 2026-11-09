import { expect, test } from "@playwright/test";
import { launch, quit } from "./helpers";

test("abas: criar, trocar e fechar com confirmação", async () => {
	const first = await launch("stream");
	try {
		const p = first.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toBeVisible({
			timeout: 30_000,
		});

		await p.keyboard.press("Control+t");
		const tabs = p
			.getByRole("tablist", { name: "Abas de sessão" })
			.getByRole("tab");
		await expect(tabs).toHaveCount(2, { timeout: 30_000 });
		await p.screenshot({ path: "test-results/tabs-after-sidebar.png" });

		await tabs.nth(0).click();
		await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

		await p.keyboard.press("Control+w");
		const dialog = p.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		await dialog.locator("button[data-autofocus]").click();
		await expect(tabs).toHaveCount(1, { timeout: 30_000 });
	} finally {
		await quit(first);
	}
});

test("configurações: navegação lateral, atalhos, sobre e layout", async () => {
	const first = await launch("stream");
	try {
		const p = first.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toBeVisible({
			timeout: 30_000,
		});

		await p.getByRole("button", { name: "Configurações" }).click();
		await p.getByRole("tab", { name: "Atalhos" }).click();
		await expect(p.getByText("Atalhos de teclado")).toBeVisible();
		await p.getByRole("tab", { name: "Sobre" }).click();
		await expect(p.getByText("Sobre o OMP Desktop")).toBeVisible();
		const about = p.getByRole("tabpanel", { name: "Sobre" });
		await expect(about.getByText(/^\d+\.\d+\.\d+$/).first()).toBeVisible();

		await p.getByRole("tab", { name: "Geral" }).click();
		await p.getByLabel("Abas", { exact: true }).selectOption("vertical");
		await expect(p.locator(".tab-strip")).toHaveCount(0);
		await p.getByLabel("Largura da conversa").selectOption("wide");
		await expect
			.poll(() => p.evaluate(() => document.documentElement.dataset.timeline))
			.toBe("wide");
		await p.getByLabel("Movimento").selectOption("on");
		await expect
			.poll(() => p.evaluate(() => document.documentElement.dataset.reduceMotion))
			.toBe("on");
	} finally {
		await quit(first);
	}
});
