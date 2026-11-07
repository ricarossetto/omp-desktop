import { expect, test } from "@playwright/test";
import { launch, quit } from "./helpers";

test("histórico longo com alturas variáveis mantém a última mensagem e a rolagem estáveis", async () => {
	const l = await launch("virtual-scroll");
	try {
		await l.page.getByText("workspace", { exact: true }).first().click();
		await l.page.getByRole("button", { name: "Criar sessão" }).click();
		await expect(l.page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });
		await expect(l.page.getByText("Mensagem de histórico 599", { exact: false })).toBeVisible();
		const stable = await l.page.evaluate(async () => {
			const log = document.querySelector<HTMLElement>('[aria-label="Histórico da conversa"]');
			if (!log) throw new Error("Histórico ausente");
			let previous = log.scrollTop;
			let changes = 0;
			for (let frame = 0; frame < 30; frame++) {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				if (Math.abs(log.scrollTop - previous) > 1) changes++;
				previous = log.scrollTop;
			}
			return { changes, distance: log.scrollHeight - log.clientHeight - log.scrollTop };
		});
		expect(l.errors).toEqual([]);
		expect(stable.changes).toBeLessThan(3);
		expect(stable.distance).toBeLessThanOrEqual(2);
		await l.page.screenshot({ path: "test-results/historico-longo.png" });
	} finally {
		await quit(l);
	}
});
