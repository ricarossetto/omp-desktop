import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { AxeResults, RunOptions } from "axe-core";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { launch, quit } from "./helpers";

declare global {
	interface Window {
		axe: { run: (context: Document, options: RunOptions) => Promise<AxeResults> };
	}
}

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");
const SHOTS = "test-results/usabilidade";
const AXE_OPTIONS: RunOptions = {
	runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
};

type Locale = "pt-BR" | "en-US" | "zh-CN";
type Theme = "light" | "dark";

const LOCALES: Record<Locale, { settings: string; composer: RegExp; send: string; stop: string }> = {
	"pt-BR": {
		settings: "Configurações",
		composer: /Mensagem para o OMP/,
		send: "Enviar",
		stop: "Parar",
	},
	"en-US": {
		settings: "Settings",
		composer: /Message to OMP/,
		send: "Send",
		stop: "Stop",
	},
	"zh-CN": {
		settings: "设置",
		composer: /发给 OMP 的消息/,
		send: "发送",
		stop: "停止",
	},
};

interface Violation {
	screen: string;
	id: string;
	impact: string | null;
	targets: (string | string[])[][];
	details: (string | undefined)[];
}

async function prepare(page: Page): Promise<void> {
	await page.addInitScript({ path: AXE_PATH });
	await page.reload();
	await expect(page.getByText("workspace", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
	await page.getByText("workspace", { exact: true }).first().click();
	await expect(page.getByRole("button", { name: "Criar sessão" })).toBeVisible({ timeout: 30_000 });
}

async function openSettings(page: Page, locale: Locale): Promise<void> {
	await page.getByRole("button", { name: LOCALES[locale].settings, exact: true }).first().click();
	await expect(page.getByRole("dialog").getByRole("tablist")).toBeVisible({ timeout: 30_000 });
}

async function configure(page: Page, locale: Locale, theme: Theme): Promise<void> {
	await openSettings(page, "pt-BR");
	await page.locator("#omp-settings-tab-general").click();
	await expect(page.locator("#omp-settings-panel-general")).toBeVisible();
	await page.getByTestId("settings-language").selectOption(locale);
	await expect(page.getByTestId("settings-language")).toHaveValue(locale);
	await page.getByTestId("settings-theme").selectOption(theme);
	await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function scan(page: Page, screen: string, violations: Violation[]): Promise<void> {
	const result = await page.evaluate(async (options) => {
		if (!window.axe) throw new Error("axe-core não foi injetado");
		return window.axe.run(document, options);
	}, AXE_OPTIONS);
	for (const item of result.violations) {
		violations.push({
			screen,
			id: item.id,
			impact: item.impact ?? null,
			targets: item.nodes.map((node) => node.target),
			details: item.nodes.map((node) => node.failureSummary),
		});
	}
}

async function shot(page: Page, name: string): Promise<void> {
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function waitForComposer(page: Page, locale: Locale): Promise<void> {
	await expect(page.getByRole("textbox", { name: LOCALES[locale].composer })).toBeVisible({ timeout: 30_000 });
}

async function sendPrompt(page: Page, locale: Locale, text: string): Promise<void> {
	const box = page.getByRole("textbox", { name: LOCALES[locale].composer });
	await box.fill(text);
	await box.press("Enter");
}

async function waitForSettledComposer(page: Page, locale: Locale): Promise<void> {
	await expect(page.getByRole("button", { name: LOCALES[locale].send, exact: true })).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByRole("button", { name: LOCALES[locale].stop, exact: true })).toHaveCount(0);
}

for (const locale of ["pt-BR", "en-US", "zh-CN"] as const) {
	for (const theme of ["light", "dark"] as const) {
		test(`acessibilidade das telas e aprovações: ${locale}, ${theme}`, async () => {
			test.setTimeout(300_000);
			const violations: Violation[] = [];
			const l = await launch("stream");
			try {
				const p = l.page;
				await prepare(p);
				await configure(p, locale, theme);
				await scan(p, "shell-vazio", violations);

				await p.keyboard.press("Control+n");
				await waitForComposer(p, locale);
				await sendPrompt(p, locale, "olá");
				await expect(p.getByText("Verificado.", { exact: true })).toHaveCount(1, { timeout: 30_000 });
				await waitForSettledComposer(p, locale);
				await scan(p, "conversa-agentes", violations);

				await p.locator("#right-panel-tab-changes").click();
				await expect(p.locator("#right-panel-panel-changes")).toBeVisible();
				await expect(
					p
						.locator(
							"#right-panel-panel-changes .omp-changes-empty, #right-panel-panel-changes .omp-changes-grid",
						)
						.first(),
				).toBeVisible({ timeout: 30_000 });
				await scan(p, "alteracoes", violations);

				await p.keyboard.press("Control+k");
				await expect(p.getByRole("listbox")).toBeVisible({ timeout: 10_000 });
				await expect(p.getByRole("option").first()).toBeVisible();
				await scan(p, "paleta", violations);
				await p.keyboard.press("Escape");
				await expect(p.getByRole("listbox")).toHaveCount(0);

				await p.keyboard.press("Control+m");
				const picker = p.getByRole("dialog");
				await expect(picker).toBeVisible({ timeout: 10_000 });
				await expect(picker.getByRole("button", { name: /Fake Model/ }).first()).toBeVisible({
					timeout: 30_000,
				});
				await expect(picker.locator(".omp-thinking select").first()).toBeEnabled({ timeout: 30_000 });
				await scan(p, "seletor-modelos", violations);
				await p.keyboard.press("Escape");
				await expect(p.getByRole("dialog")).toHaveCount(0);

				await openSettings(p, locale);
				for (const tab of ["models", "accounts", "general"] as const) {
					await p.locator(`#omp-settings-tab-${tab}`).click();
					await expect(p.locator(`#omp-settings-panel-${tab}`)).toBeVisible();
					if (tab === "models") {
						await expect(p.locator("#omp-settings-panel-models .omp-role-list select").first()).toBeEnabled({
							timeout: 30_000,
						});
						await expect(p.locator("#omp-settings-panel-models .omp-thinking select").first()).toBeEnabled({
							timeout: 30_000,
						});
					}
					if (tab === "accounts") {
						await expect(p.locator('#omp-settings-panel-accounts [role="meter"]').first()).toBeVisible({
							timeout: 30_000,
						});
					}
					if (tab === "general") {
						await expect(p.getByTestId("settings-theme")).toBeVisible();
						await expect(p.locator("#omp-settings-panel-general")).toContainText("Fake Model", {
							timeout: 30_000,
						});
					}
					await scan(p, `configuracoes-${tab}`, violations);
				}
				await p.keyboard.press("Escape");
				await expect(p.getByRole("dialog")).toHaveCount(0);

				await p.keyboard.press("Control+`");
				await expect(p.locator(".omp-terminal")).toBeVisible({ timeout: 30_000 });
				await expect(p.locator(".omp-terminal-ready")).toBeVisible({ timeout: 30_000 });
				await scan(p, "terminal", violations);
				await shot(p, `${locale}-${theme}`);
			} finally {
				await quit(l);
			}

			const approval = await launch("ask");
			try {
				const p = approval.page;
				await prepare(p);
				await configure(p, locale, theme);
				await p.keyboard.press("Control+n");
				await waitForComposer(p, locale);
				await sendPrompt(p, locale, "pergunte");
				await expect(p.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
				await expect(p.getByRole("radio", { name: /a\.txt/ })).toBeVisible();
				await scan(p, "aprovacao", violations);
			} finally {
				await quit(approval);
			}

			console.log(`AXE ${locale}/${theme}: ${violations.length} violações`);
			expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
		});
	}
}
