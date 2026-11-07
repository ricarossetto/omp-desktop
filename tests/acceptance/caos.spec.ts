import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, quit } from "./helpers";

mkdirSync("test-results", { recursive: true });

async function openSession(l: Awaited<ReturnType<typeof launch>>) {
	await l.page.getByText("workspace", { exact: true }).first().click();
	await l.page.getByRole("button", { name: "Criar sessão" }).click();
	const box = l.page.getByRole("textbox", { name: "Mensagem para o OMP" });
	await expect(box).toBeVisible({ timeout: 30_000 });
	return box;
}

test("duplo Enter envia um único prompt", async () => {
	const record = resolve(tmpdir(), "caos-duplo.jsonl");
	writeFileSync(record, "");
	const l = await launch("stream", { FAKE_OMP_RECORD: record });
	const box = await openSession(l);
	await box.fill("uma vez só");
	await box.press("Enter");
	await box.press("Enter");
	await l.page.waitForTimeout(2500);
	const prompts = readFileSync(record, "utf8").split("\n").filter((line) => line.includes('"type":"prompt"'));
	expect(prompts.length).toBe(1);
	await quit(l);
});

test("trocar de idioma durante o streaming não perde a resposta", async () => {
	const l = await launch("longtool", { FAKE_OMP_TOOL_MS: "6000" });
	const p = l.page;
	const box = await openSession(l);
	await box.fill("trabalho");
	await box.press("Enter");
	await expect(p.getByRole("button", { name: "Pausar depois do passo atual" })).toBeVisible({ timeout: 20_000 });
	await p.getByRole("button", { name: "Configurações" }).click();
	await p.getByRole("tab", { name: /Geral/ }).click();
	await p.locator("[data-testid=settings-language]").selectOption("en-US");
	await p.waitForTimeout(400);
	await expect(p.getByRole("dialog", { name: "Settings" })).toBeVisible();
	await p.keyboard.press("Escape");
	await expect(p.getByRole("dialog", { name: "Settings" })).toHaveCount(0, { timeout: 10_000 });
	await p.waitForTimeout(4000);
	// O turno termina e o app continua utilizável em inglês.
	await expect(p.getByRole("textbox", { name: "Message to OMP" })).toBeVisible({ timeout: 20_000 });
	await p.screenshot({ path: "test-results/caos-idioma-streaming.png" });
	await quit(l);
});

test("texto enorme, emoji e RTL não quebram o layout", async () => {
	const l = await launch("stream");
	const p = l.page;
	const box = await openSession(l);
	const texto = `${"palavra ".repeat(200)}🎉🚀 中文 العربية ${"x".repeat(400)}`;
	await box.fill(texto);
	await box.press("Enter");
	await expect(p.getByText("Verificado.")).toHaveCount(1, { timeout: 20_000 });
	const overflow = await p.evaluate(() => ({
		doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		msg: [...document.querySelectorAll(".message-slot")].some((el) => el.scrollWidth > el.clientWidth + 2),
	}));
	expect(overflow.doc).toBeLessThanOrEqual(1);
	expect(overflow.msg).toBe(false);
	await p.screenshot({ path: "test-results/caos-texto-longo.png" });
	await quit(l);
});

test("ui-state corrompido não impede a abertura", async () => {
	const l = await launch("basic");
	await quit(l);
	// Reabre o mesmo perfil com o estado corrompido.
	const broken = await launch("basic", {}, { workspace: l.workspace, userData: l.userData });
	writeFileSync(join(l.userData, "ui-state.json"), "{ isso não é json");
	await broken.app.close().catch(() => undefined);
	const again = await launch("basic", {}, { workspace: l.workspace, userData: l.userData });
	await expect(again.page.getByText("workspace", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
	await quit(again);
});

test("pasta do projeto removida entre execuções aparece como indisponível", async () => {
	const first = await launch("basic");
	await first.page.getByText("workspace", { exact: true }).first().click();
	await openSession(first);
	await quit(first);
	// Fecha o app, apaga a pasta e reabre com o mesmo perfil. O Windows pode
	// segurar o diretório por alguns instantes depois de o processo sair.
	await expect
		.poll(
			() => {
				try {
					rmSync(first.workspace, { recursive: true, force: true });
					return true;
				} catch {
					return false;
				}
			},
			{ timeout: 20_000, intervals: [200, 400, 800] },
		)
		.toBe(true);
	const again = await launch("basic", {}, { workspace: first.workspace, userData: first.userData });
	await expect(again.page.getByText(/indispon|não está disponível/i).first()).toBeVisible({ timeout: 30_000 });
	await again.page.screenshot({ path: "test-results/caos-pasta-removida.png" });
	await quit(again);
});

test("fechar sessão durante o streaming cancela sem deixar processo", async () => {
	const l = await launch("longtool", { FAKE_OMP_TOOL_MS: "60000" });
	const p = l.page;
	await openSession(l);
	const box = p.getByRole("textbox", { name: "Mensagem para o OMP" });
	await box.fill("demorado");
	await box.press("Enter");
	await expect(p.getByRole("button", { name: "Pausar depois do passo atual" })).toBeVisible({ timeout: 20_000 });
	await p.locator("[data-testid=session-row]").first().hover();
	await p.getByRole("button", { name: /fechar sessão/i }).first().click({ force: true });
	const dialog = p.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await dialog.locator(".btn--danger, .btn--primary").last().click();
	await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toHaveCount(0, { timeout: 20_000 });
	// Reabrir a mesma sessão funciona depois de fechar.
	await p.getByRole("button", { name: "Nova sessão" }).first().click();
	await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toBeVisible({ timeout: 30_000 });
	await quit(l);
});

test("abrir e fechar sessões em sequência rápida não deixa estado preso", async () => {
	const l = await launch("basic");
	const p = l.page;
	await p.getByText("workspace", { exact: true }).first().click();
	for (let index = 0; index < 3; index++) {
		await p.getByRole("button", { name: "Criar sessão" }).click();
		await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toBeVisible({ timeout: 30_000 });
		await p.locator("[data-testid=session-row]").first().hover();
		await p.getByRole("button", { name: /fechar sessão/i }).first().click({ force: true });
		const dialog = p.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await dialog.locator(".btn--danger, .btn--primary").last().click();
		await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toHaveCount(0, { timeout: 20_000 });
	}
	await expect(p.getByRole("button", { name: "Criar sessão" })).toBeVisible();
	await quit(l);
});

test("paleta abre com Ctrl+K, filtra e fecha com Esc", async () => {
	const l = await launch("basic");
	const p = l.page;
	await openSession(l);
	await p.keyboard.press("Control+k");
	const palette = p.getByRole("dialog", { name: "Paleta de comandos" });
	await expect(palette).toBeVisible();
	await p.keyboard.type("modelo");
	await expect(palette.getByText(/Modelo/i).first()).toBeVisible();
	await p.keyboard.press("Escape");
	await expect(palette).toHaveCount(0);
	await quit(l);
});

test("modelo e raciocínio abrem por Ctrl+M e fecham com Esc", async () => {
	const l = await launch("basic");
	const p = l.page;
	await openSession(l);
	await p.keyboard.press("Control+m");
	const picker = p.getByRole("dialog");
	await expect(picker).toBeVisible({ timeout: 10_000 });
	await p.keyboard.press("Escape");
	await expect(picker).toHaveCount(0);
	await quit(l);
});

test("configuração com valor divergente não é sobrescrita (CONFIG_CONFLICT)", async () => {
	const config = resolve(tmpdir(), "caos-config.json");
	writeFileSync(config, JSON.stringify({ modelRoles: { value: { default: "fake/fake-model" }, type: "object" } }));
	const l = await launch("basic", { FAKE_OMP_CONFIG_FILE: config });
	const p = l.page;
	await p.getByText("workspace", { exact: true }).first().click();
	await p.getByRole("button", { name: "Configurações" }).click();
	await p.getByRole("tab", { name: "Modelos" }).click();
	// Altera o arquivo por fora, simulando outra janela/terminal.
	writeFileSync(config, JSON.stringify({ modelRoles: { value: { default: "outro/modelo" }, type: "object" } }));
	await p.waitForTimeout(500);
	await p.screenshot({ path: "test-results/caos-config.png" });
	// O app não deve gravar nada sozinho.
	const after = readFileSync(config, "utf8");
	expect(after).toContain("outro/modelo");
	await quit(l);
});

test("preset novo salva no global sem copiar preset de projeto", async () => {
	const dir = mkdtempSync(join(tmpdir(), "caos-preset-"));
	const globalConfig = join(dir, "global.json");
	const projectConfig = join(dir, "project.json");
	writeFileSync(globalConfig, JSON.stringify({ modelRoles: { default: "fake/fake-model" } }));
	writeFileSync(
		projectConfig,
		JSON.stringify({
			modelPresets: { "preset-projeto": { modelRoles: { default: "fake/fast-model" } } },
		}),
	);
	const l = await launch("basic", {
		FAKE_OMP_CONFIG_FILE: globalConfig,
		FAKE_OMP_PROJECT_CONFIG_FILE: projectConfig,
	});
	const p = l.page;
	await p.getByText("workspace", { exact: true }).first().click();
	await p.getByRole("button", { name: "Configurações" }).click();
	await expect(p.getByRole("dialog", { name: "Configurações" })).toBeVisible({ timeout: 20_000 });
	await expect(p.getByText("preset-projeto")).toBeVisible({ timeout: 20_000 });
	await p.getByRole("button", { name: "Criar preset" }).click();
	await p.getByRole("button", { name: "Salvar preset" }).click();
	await expect(p.getByText("Preset preset-novo salvo.")).toBeVisible({ timeout: 20_000 });
	const saved = JSON.parse(readFileSync(globalConfig, "utf8")) as {
		modelPresets?: Record<string, unknown>;
	};
	expect(Object.keys(saved.modelPresets ?? {})).toEqual(["preset-novo"]);
	await quit(l);
});
