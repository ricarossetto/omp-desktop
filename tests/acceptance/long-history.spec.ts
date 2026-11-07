import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildEntries, launch, quit } from "./helpers";

mkdirSync("test-results", { recursive: true });

test("histórico longo não gera loop de renderização (React #185)", async () => {
	const file = resolve(tmpdir(), `omp-long-entries-${process.pid}.json`);
	writeFileSync(file, JSON.stringify(buildEntries(400)));
	const l = await launch("stream", { FAKE_OMP_ENTRIES: file });
	await l.page.getByText("workspace", { exact: true }).first().click();
	await l.page.getByRole("button", { name: "Criar sessão" }).click();
	await expect(l.page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });
	await l.page.waitForTimeout(3000);
	// rola para o topo e para o fundo várias vezes
	const list = l.page.locator("[data-msg-key]").first();
	await expect(list).toBeVisible();
	for (let i = 0; i < 6; i++) {
		await l.page.evaluate(() => {
			const el = document.querySelector("[data-msg-key]")?.closest("div[class*=scroll], div") as HTMLElement | null;
			let p: HTMLElement | null = el;
			while (p && p.scrollHeight <= p.clientHeight + 5) p = p.parentElement;
			if (p) p.scrollTop = i % 2 === 0 ? 0 : p.scrollHeight;
		}).catch(() => undefined);
		await l.page.mouse.wheel(0, i % 2 === 0 ? -6000 : 6000);
		await l.page.waitForTimeout(400);
	}
	// mensagens novas com histórico grande
	const box = l.page.locator("textarea").first();
	for (let i = 0; i < 3; i++) {
		await box.fill(`teste ${i}`);
		await box.press("Enter");
		await l.page.waitForTimeout(1500);
	}
	await l.page.screenshot({ path: "test-results/long-history.png" });
	const text = await l.page.locator("body").innerText();
	expect(text).not.toContain("Minified React error");
	expect(l.errors.filter((e) => /185|Maximum update depth/.test(e))).toEqual([]);
	await quit(l);
});
