import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { launch, quit } from "./helpers";

async function openSessionWithoutWorkspaceClick(l: Awaited<ReturnType<typeof launch>>) {
	await l.page.getByRole("button", { name: "Criar sessão" }).click();
	const box = l.page.locator("textarea").first();
	await expect(box).toBeVisible({ timeout: 30_000 });
	return box;
}

async function openSession(l: Awaited<ReturnType<typeof launch>>) {
	await l.page.getByText("workspace", { exact: true }).first().click();
	await l.page.getByRole("button", { name: "Criar sessão" }).click();
	const box = l.page.locator("textarea").first();
	await expect(box).toBeVisible({ timeout: 30_000 });
	return box;
}

test("primeira execução mostra o onboarding e termina no início", async () => {
	const l = await launch("basic", {}, undefined, { noCwd: true });
	const p = l.page;
	await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({ timeout: 30_000 });
	await p.screenshot({ path: "test-results/onboarding-1.png" });
	await p.getByRole("button", { name: "Pular introdução" }).click();
	await expect(p.getByRole("button", { name: /abrir pasta/i }).first()).toBeVisible({ timeout: 20_000 });
	await quit(l);
});

test("compactar conversa só quando o agente está parado", async () => {
	const record = resolve(tmpdir(), "compact-record.jsonl");
	writeFileSync(record, "");
	const l = await launch("longtool", { FAKE_OMP_RECORD: record, FAKE_OMP_TOOL_MS: "9000" });
	const p = l.page;
	const box = await openSession(l);
	await box.fill("primeira");
	await box.press("Enter");
	await expect(p.getByRole("button", { name: "Pausar depois do passo atual" })).toBeVisible({ timeout: 20_000 });
	// Trabalhando: o botão de compactar fica desabilitado.
	await p.getByRole("button", { name: /^Contexto/ }).click();
	const compact = p.getByRole("button", { name: /compactar conversa/i });
	await expect(compact).toBeDisabled();
	await p.keyboard.press("Escape");
	// Depois do turno, compactar envia o comando.
	await expect(p.getByRole("button", { name: "Pausar depois do passo atual" })).toHaveCount(0, { timeout: 30_000 });
	await p.getByRole("button", { name: /^Contexto/ }).click();
	await expect(compact).toBeEnabled();
	await compact.click();
	await expect.poll(() => readFileSync(record, "utf8"), { timeout: 20_000 }).toContain('"command":"compact"');
	await quit(l);
});

test("diff inline do card continua visível depois do turno terminar", async () => {
	const l = await launch("diff");
	const p = l.page;
	const box = await openSession(l);
	await box.fill("edite");
	await box.press("Enter");
	await expect(p.getByText("Editei o arquivo.")).toBeVisible({ timeout: 20_000 });
	// Espera o settle (o histórico é relido e substitui os cards).
	await p.waitForTimeout(3000);
	await expect(p.getByText("src/app.ts").first()).toBeVisible();
	await expect(p.locator("details").filter({ hasText: "src/app.ts" }).first()).toContainText("const valor = 2", { timeout: 10_000 });
	await p.screenshot({ path: "test-results/diff-inline.png" });
	await quit(l);
});

test("janela de 1000px usa gaveta e mostra aprovação", async () => {
	const l = await launch("ask");
	const p = l.page;
	await p.getByText("workspace", { exact: true }).first().click();
	await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
	await p.waitForTimeout(600);
	// Ctrl+B abre a gaveta da barra lateral em janelas estreitas.
	await p.keyboard.press("Control+b");
	const box = await openSessionWithoutWorkspaceClick(l);
	await box.fill("pergunte");
	await box.press("Enter");
	const dialog = p.getByRole("dialog");
	await expect(dialog).toBeVisible({ timeout: 20_000 });
	await p.screenshot({ path: "test-results/1000-aprovacao.png" });
	const drawer = p.getByRole("button", { name: /painel Agentes e Alterações/i });
	await expect(drawer).toBeVisible();
	await quit(l);
});

test("árvore de projetos recolhe e fecha sessão com confirmação", async () => {
	const l = await launch("basic");
	const p = l.page;
	await openSession(l);
	const collapse = p.getByRole("button", { name: /recolher workspace/i });
	await collapse.click();
	await expect(p.getByRole("button", { name: /expandir workspace/i })).toBeVisible();
	await p.getByRole("button", { name: /expandir workspace/i }).click();
	await p.locator("[data-testid=session-row]").first().hover();
	const close = p.getByRole("button", { name: /fechar sessão/i }).first();
	await close.click({ force: true });
	const confirm = p.getByRole("dialog").locator(".btn--danger, .btn--primary").last();
	await expect(confirm).toBeVisible();
	await confirm.click();
	// Sem sessão ativa o compositor desaparece.
	await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toHaveCount(0, { timeout: 20_000 });
	await quit(l);
});

test("escala de 125% e 150% mantém o compositor e não cria rolagem horizontal", async () => {
	for (const scale of ["1.25", "1.5"]) {
		const l = await launch("basic", {}, undefined, { args: [`--force-device-scale-factor=${scale}`] });
		const p = l.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		const box = p.getByRole("textbox", { name: "Mensagem para o OMP" });
		await expect(box).toBeVisible({ timeout: 30_000 });
		const overflow = await p.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			clientWidth: document.documentElement.clientWidth,
			composer: document.querySelector(".composer")?.getBoundingClientRect().width ?? 0,
		}));
		expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
		expect(overflow.composer).toBeGreaterThan(200);
		await p.screenshot({ path: `test-results/escala-${scale}.png` });
		await quit(l);
	}
});

test("Buscar e Skills e MCP abrem paletas diferentes", async () => {
	const l = await launch("basic");
	const p = l.page;
	await openSession(l);
	// Buscar: paleta geral, com ações e comandos.
	await p.getByRole("button", { name: "Buscar" }).first().click();
	const geral = p.getByRole("dialog", { name: "Paleta de comandos" });
	await expect(geral).toBeVisible();
	await expect(geral.getByText("Ações", { exact: true })).toBeVisible();
	await expect(geral.getByText("/prompt", { exact: true })).toBeVisible();
	await p.keyboard.press("Escape");
	await expect(geral).toHaveCount(0);
	// Skills e MCP: só comandos de skill/extensão/MCP, sem o grupo de ações.
	await p.getByRole("button", { name: "Skills e MCP" }).first().click();
	const skills = p.getByRole("dialog", { name: "Skills e MCP" });
	await expect(skills).toBeVisible();
	await expect(skills.getByText("/revisar", { exact: true })).toBeVisible();
	await expect(skills.getByText("/mcp__docs__buscar", { exact: true })).toBeVisible();
	await expect(skills.getByText("/prompt", { exact: true })).toHaveCount(0);
	await expect(skills.getByText("Ações", { exact: true })).toHaveCount(0);
	await p.screenshot({ path: "test-results/skills-mcp.png" });
	// Escolher a skill insere o comando no compositor.
	await skills.getByText("/revisar", { exact: true }).click();
	await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toHaveValue("/revisar ");
	await quit(l);
});

test("terminal: Ctrl+C interrompe comando e resize acompanha a janela", async () => {
	const l = await launch("basic");
	const p = l.page;
	await openSession(l);
	await p.keyboard.press("Control+`");
	await expect(p.getByText("Conectado")).toBeVisible({ timeout: 20_000 });
	await p.waitForTimeout(1200);
	await p.locator(".xterm").click();
	await p.keyboard.type("Start-Sleep -Seconds 30\n");
	await p.waitForTimeout(1200);
	await p.keyboard.press("Control+c");
	await p.waitForTimeout(800);
	await p.keyboard.type("Write-Output 'depois-do-ctrl-c'\n");
	await expect(p.locator(".xterm-rows")).toContainText("depois-do-ctrl-c", { timeout: 15_000 });
	await l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
	await p.waitForTimeout(800);
	await expect(p.locator(".xterm-rows")).toContainText("depois-do-ctrl-c");
	await p.screenshot({ path: "test-results/terminal-ctrl-c.png" });
	await quit(l);
});

test("colar imagem no compositor cria anexo e envia com o prompt", async () => {
	const record = resolve(tmpdir(), "attach-record.jsonl");
	writeFileSync(record, "");
	const l = await launch("stream", { FAKE_OMP_RECORD: record });
	const p = l.page;
	const box = await openSession(l);
	// Um PNG 1x1 válido, colado como se viesse da área de transferência.
	await box.evaluate((element) => {
		const base64 =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
		const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
		const file = new File([bytes], "pixel.png", { type: "image/png" });
		const data = new DataTransfer();
		data.items.add(file);
		element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
	});
	await expect(p.getByText("pixel.png").first()).toBeVisible({ timeout: 20_000 });
	await p.screenshot({ path: "test-results/anexo-colado.png" });
	await box.fill("olha a imagem");
	await box.press("Enter");
	await expect.poll(() => readFileSync(record, "utf8"), { timeout: 30_000 }).toContain('"command":"prompt"');
	await quit(l);
});
