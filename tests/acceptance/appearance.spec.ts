import { expect, test } from "@playwright/test";
import { launch, quit } from "./helpers";

test("temas, acento, densidade e zoom são aplicados", async () => {
	const first = await launch("stream");
	try {
		const p = first.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toBeVisible({
			timeout: 30_000,
		});

		await p.getByRole("button", { name: "Configurações" }).click();
		await p.getByRole("tab", { name: "Geral" }).click();

		await p.getByTestId("settings-theme").selectOption("aurora");
		await expect
			.poll(() => p.evaluate(() => document.documentElement.dataset.theme))
			.toBe("aurora");
		await expect
			.poll(() =>
				p.evaluate(() =>
					getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
				),
			)
			.toBe("#8af0c8");

		await p.locator('input[type="color"]').evaluate((element) => {
			if (!(element instanceof HTMLInputElement)) return;
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(element, "#ff00aa");
			element.dispatchEvent(new Event("input", { bubbles: true }));
			element.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await expect
			.poll(() =>
				p.evaluate(() =>
					getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
				),
			)
			.toBe("#ff00aa");

		await p.getByLabel("Densidade").selectOption("compact");
		await expect
			.poll(() => p.evaluate(() => document.documentElement.dataset.density))
			.toBe("compact");

		await p.getByLabel("Tamanho da interface").selectOption("1.1");
		await expect
			.poll(() =>
				first.app.evaluate(({ BrowserWindow }) => {
					const win = BrowserWindow.getAllWindows()[0];
					return win ? win.webContents.getZoomFactor() : 0;
				}),
			)
			.toBeCloseTo(1.1, 2);
	} finally {
		await quit(first);
	}
});
