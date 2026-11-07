import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, quit } from "./helpers";

const SHOTS = "test-results/usabilidade";

interface SmallTarget {
	label: string;
	width: number;
	height: number;
}

async function shot(page: Page, name: string): Promise<void> {
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test("alvos de clique, truncamento, foco e zoom em 200%", async () => {
	test.setTimeout(300_000);
	const l = await launch("stream");
	try {
		const p = l.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		const box = p.getByRole("textbox", { name: "Mensagem para o OMP" });
		await expect(box).toBeVisible({ timeout: 30_000 });
		await box.fill("olá");
		await box.press("Enter");
		await expect(p.getByText("Verificado.", { exact: true })).toHaveCount(1, { timeout: 20_000 });
		await expect(p.getByRole("button", { name: "Enviar", exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(p.getByRole("button", { name: "Parar", exact: true })).toHaveCount(0);

		// 1) Alvos menores que 24x24 (WCAG 2.2 AA, 2.5.8).
		const small: SmallTarget[] = await p.evaluate(() => {
			const out: SmallTarget[] = [];
			const nodes = document.querySelectorAll<HTMLElement>(
				"button, [role=button], a[href], input, select, textarea, [role=tab], [role=menuitem], [role=option]",
			);
			for (const node of nodes) {
				const rect = node.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
				const style = getComputedStyle(node);
				if (style.visibility === "hidden" || style.display === "none") continue;
				if (style.pointerEvents === "none" || Number.parseFloat(style.opacity) === 0) continue;
				if (rect.width < 24 || rect.height < 24) {
					out.push({
						label:
							node.getAttribute("aria-label") ||
							node.textContent?.trim().slice(0, 40) ||
							node.tagName.toLowerCase(),
						width: Math.round(rect.width),
						height: Math.round(rect.height),
					});
				}
			}
			return out;
		});

		// 2) Texto truncado sem tooltip.
		const truncated: string[] = await p.evaluate(() => {
			const out: string[] = [];
			for (const node of document.querySelectorAll<HTMLElement>("*")) {
				if (node.children.length > 0) continue;
				const text = node.textContent?.trim();
				if (!text || text.length < 8) continue;
				if (node.clientWidth <= 0 || node.title) continue;
				const overflow = getComputedStyle(node).overflowX;
				if (overflow !== "hidden" && overflow !== "clip") continue;
				if (node.scrollWidth > node.clientWidth + 2) {
					out.push(`${node.className || node.tagName}: ${text.slice(0, 40)}`);
				}
			}
			return out.slice(0, 20);
		});

		// 3) Foco visível ao tabular pelos primeiros 25 controles.
		// Compara a assinatura visual do elemento focado e de seus ancestrais
		// (contêineres com :focus-within) antes e depois de perder o foco.
		const focusIssues: string[] = [];
		for (let index = 0; index < 25; index++) {
			await p.keyboard.press("Tab");
			const info = await p.evaluate(async () => {
				const el = document.activeElement;
				if (!(el instanceof HTMLElement) || el === document.body) return null;
				const chain: HTMLElement[] = [];
				let node: HTMLElement | null = el;
				for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) chain.push(node);
				const signature = () =>
					chain.map((item) => {
						const style = getComputedStyle(item);
						return [
							style.outlineStyle,
							style.outlineWidth,
							style.boxShadow,
							style.borderColor,
							style.backgroundColor,
							style.color,
							style.opacity,
						].join("|");
					});
				const wait = (ms: number): Promise<void> => {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, ms);
					return promise;
				};
				const focused = signature();
				el.blur();
				await wait(220);
				const blurred = signature();
				el.focus();
				await wait(220);
				return {
					tag: el.tagName.toLowerCase(),
					label: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 30) || "",
					visible: focused.some((value, position) => value !== blurred[position]),
				};
			});
			if (info && !info.visible) focusIssues.push(`${info.tag} ${info.label}`);
		}

		// 4) Zoom de 200% sem rolagem horizontal.
		const baseDpr = await p.evaluate(() => window.devicePixelRatio);
		await l.app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2);
		});
		await expect.poll(() => p.evaluate(() => window.devicePixelRatio)).toBeGreaterThan(baseDpr);
		await p.evaluate(async () => {
			const nextFrame = (): Promise<void> => {
				const { promise, resolve } = Promise.withResolvers<void>();
				requestAnimationFrame(() => resolve());
				return promise;
			};
			await nextFrame();
			await nextFrame();
		});
		const zoom = await p.evaluate(() => ({
			overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			composer: document.querySelector(".composer")?.getBoundingClientRect().width ?? 0,
		}));
		await shot(p, "zoom-200");
		await l.app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1);
		});

		console.log("SMALL", JSON.stringify(small));
		console.log("TRUNC", JSON.stringify(truncated));
		console.log("FOCUS", JSON.stringify(focusIssues));
		console.log("ZOOM", JSON.stringify(zoom));

		expect(zoom.overflow).toBeLessThanOrEqual(1);
		expect(zoom.composer).toBeGreaterThan(200);
		expect(small, "Controles menores que 24 × 24 px").toEqual([]);
		expect(truncated, "Texto cortado sem título acessível").toEqual([]);
		expect(focusIssues, `Foco invisível: ${focusIssues.join(", ")}`).toEqual([]);
	} finally {
		await quit(l);
	}
});

const PT_WORDS = /\b(sessão|sessões|projeto|projetos|arquivo|arquivos|enviar|parar|configurações|mensagem|trabalhando|indisponível|fechar|salvar|cancelar|buscar|agentes|alterações|objetivo|tarefas|contexto|custo|estimado|pronta|nova|abrir)\b/i;


async function portugueseLeaks(page: Page): Promise<string[]> {
	return page.evaluate((source) => {
		const re = new RegExp(source, "i");
		const leaks: string[] = [];
		for (const node of document.querySelectorAll<HTMLElement>("button, h1, h2, h3, p, span, label, a, li, option, [role=tab]")) {
			if (node.children.length > 0) continue;
			const text = node.textContent?.trim();
			if (!text || text.length < 3) continue;
			if (re.test(text)) leaks.push(text.slice(0, 60));
		}
		return [...new Set(leaks)].slice(0, 15);
	}, PT_WORDS.source);
}

test("nenhum texto em português nas versões en-US e zh-CN", async () => {
	test.setTimeout(300_000);
	const l = await launch("stream");
	try {
		const p = l.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toBeVisible({ timeout: 30_000 });

		for (const locale of ["en-US", "zh-CN"] as const) {
			await p.getByRole("button", { name: /^(Configurações|Settings|设置)$/ }).first().click();
			await expect(p.getByRole("dialog").getByRole("tablist")).toBeVisible({ timeout: 30_000 });
			await p.locator("#omp-settings-tab-general").click();
			await expect(p.locator("#omp-settings-panel-general")).toBeVisible();
			await p.getByTestId("settings-language").selectOption(locale);
			await expect(p.getByTestId("settings-language")).toHaveValue(locale);
			await expect(p.locator("#omp-settings-panel-general")).toContainText("Fake Model", { timeout: 30_000 });
			const settingsLeaks = await portugueseLeaks(p);

			await p.locator("#omp-settings-tab-models").click();
			await expect(p.locator("#omp-settings-panel-models")).toBeVisible();
			await expect(p.locator("#omp-settings-panel-models .omp-role-list select").first()).toBeEnabled({
				timeout: 30_000,
			});
			await expect(p.locator("#omp-settings-panel-models .omp-thinking select").first()).toBeEnabled({
				timeout: 30_000,
			});
			const modelsLeaks = await portugueseLeaks(p);

			await p.locator("#omp-settings-tab-accounts").click();
			await expect(p.locator("#omp-settings-panel-accounts")).toBeVisible();
			await expect(p.locator('#omp-settings-panel-accounts [role="meter"]').first()).toBeVisible({
				timeout: 30_000,
			});
			const accountsLeaks = await portugueseLeaks(p);

			await p.keyboard.press("Escape");
			await expect(p.getByRole("dialog")).toHaveCount(0, { timeout: 10_000 });
			const shellLeaks = await portugueseLeaks(p);
			console.log(`LEAK ${locale}`, JSON.stringify({ settingsLeaks, modelsLeaks, accountsLeaks, shellLeaks }));
			expect(
				[...settingsLeaks, ...modelsLeaks, ...accountsLeaks, ...shellLeaks],
				`Textos em português em ${locale}`,
			).toEqual([]);
		}
	} finally {
		await quit(l);
	}
});

test("introdução reaberta usa o idioma escolhido", async () => {
	test.setTimeout(300_000);
	const l = await launch("ask");
	try {
		const p = l.page;
		// Troca para inglês e reabre a introdução.
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Configurações", exact: true }).first().click();
		await expect(p.getByRole("dialog").getByRole("tablist")).toBeVisible({ timeout: 30_000 });
		await p.locator("#omp-settings-tab-general").click();
		await p.getByTestId("settings-language").selectOption("en-US");
		await expect(p.locator("#omp-settings-tab-general")).toHaveText("General");
		await p.getByRole("button", { name: "Open introduction again", exact: true }).click();
		await expect(p.getByRole("button", { name: "Close introduction", exact: true })).toBeVisible({
			timeout: 30_000,
		});
		const onboardingLeaks = await portugueseLeaks(p);
		console.log("LEAK onboarding", JSON.stringify(onboardingLeaks));
		expect(onboardingLeaks).toEqual([]);
		await shot(p, "onboarding-en");
		await p.getByRole("button", { name: "Close introduction", exact: true }).click();
		await expect(p.getByRole("button", { name: "Settings", exact: true }).first()).toBeVisible({
			timeout: 30_000,
		});
	} finally {
		await quit(l);
	}
});

function readRecord(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Respostas de diálogo registradas pelo fake: uma lista de selectedOptions por pergunta. */
function recordedAnswers(path: string): string[][][] {
	const answers: string[][][] = [];
	for (const line of readRecord(path).split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry: unknown = JSON.parse(line);
			if (typeof entry !== "object" || entry === null) continue;
			if (!("type" in entry) || entry.type !== "ui_response") continue;
			if (!("response" in entry) || typeof entry.response !== "object" || entry.response === null) continue;
			const response = entry.response;
			if (!("answers" in response) || !Array.isArray(response.answers)) continue;
			answers.push(
				response.answers.map((answer) => {
					if (typeof answer !== "object" || answer === null) return [];
					if (!("selectedOptions" in answer) || !Array.isArray(answer.selectedOptions)) return [];
					return answer.selectedOptions.filter((value: unknown): value is string => typeof value === "string");
				}),
			);
		} catch {
			// Linha ainda em escrita: o poll seguinte relê o arquivo inteiro.
		}
	}
	return answers;
}

test("aprovação por teclado envia somente as opções escolhidas", async () => {
	const record = join(mkdtempSync(join(tmpdir(), "omp-keyboard-")), "commands.jsonl");
	const l = await launch("ask", { FAKE_OMP_RECORD: record });
	try {
		const p = l.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		const box = p.getByRole("textbox", { name: "Mensagem para o OMP" });
		await box.fill("pergunte");
		await box.press("Enter");
		const dialog = p.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 30_000 });

		const tabTo = async (target: Locator): Promise<void> => {
			for (let index = 0; index < 30; index++) {
				if (await target.evaluate((el) => el === document.activeElement)) return;
				await p.keyboard.press("Tab");
			}
			await expect(target).toBeFocused();
		};

		await tabTo(dialog.getByRole("radio", { name: /a\.txt/ }));
		await p.keyboard.press("ArrowRight");
		await expect(dialog.getByRole("radio", { name: /b\.txt/ })).toBeChecked();
		for (const label of ["alpha", "beta"]) {
			const option = dialog.getByRole("checkbox", { name: label });
			await tabTo(option);
			await p.keyboard.press("Space");
			await expect(option).toBeChecked();
		}
		expect(recordedAnswers(record)).toEqual([]);

		const respond = dialog.getByRole("button", { name: "Responder", exact: true });
		await expect(respond).toBeEnabled();
		await tabTo(respond);
		await p.keyboard.press("Enter");
		await expect(dialog).toBeHidden();
		await expect.poll(() => recordedAnswers(record)).toHaveLength(1);
		expect(recordedAnswers(record)).toEqual([[["b.txt"], ["alpha", "beta"]]]);
	} finally {
		await quit(l);
	}
});
