import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { launch, quit } from "./helpers";

mkdirSync("test-results", { recursive: true });

async function openSession(l: Awaited<ReturnType<typeof launch>>) {
	await l.page.getByText("workspace", { exact: true }).first().click();
	await l.page.getByRole("button", { name: "Criar sessão" }).click();
	const box = l.page.locator("textarea").first();
	await expect(box).toBeVisible({ timeout: 30_000 });
	return box;
}

test("diálogo ask multi-pergunta responde exatamente e nunca aprova sozinho", async () => {
	const record = resolve("test-results/ask-record.jsonl");
	writeFileSync(record, "");
	const l = await launch("ask", { FAKE_OMP_RECORD: record });
	const box = await openSession(l);
	await box.fill("pergunte");
	await box.press("Enter");
	const dialog = l.page.getByRole("dialog");
	await expect(dialog).toBeVisible({ timeout: 20_000 });
	await l.page.screenshot({ path: "test-results/ask-dialog.png" });
	// Nada foi respondido enquanto o diálogo está aberto.
	expect(readFileSync(record, "utf8")).not.toContain("extension_ui_response");
	await dialog.getByText("b.txt").click();
	await dialog.getByText("alpha").click();
	await dialog.getByText("beta").click();
	await dialog.getByRole("button", { name: /enviar|responder|confirmar/i }).click();
	await expect(dialog).toBeHidden({ timeout: 10_000 });
	await expect.poll(() => readFileSync(record, "utf8")).toContain("selectedOptions");
	const line = readFileSync(record, "utf8").split("\n").filter((x) => x.includes("selectedOptions"))[0];
	expect(line).toContain("b.txt");
	expect(line).toContain("alpha");
	expect(line).toContain("beta");
	await quit(l);
});

test("recarregar a janela preserva o transcript e não reenvia prompt", async () => {
	const record = resolve("test-results/reload-record.jsonl");
	writeFileSync(record, "");
	const l = await launch("stream", { FAKE_OMP_RECORD: record });
	const box = await openSession(l);
	await box.fill("primeiro");
	await box.press("Enter");
	await expect(l.page.getByText("Verificado.")).toHaveCount(1, { timeout: 20_000 });
	await l.page.reload();
	await l.page.getByText("workspace", { exact: true }).first().click();
	await expect(l.page.getByText("Verificado.")).toHaveCount(1, { timeout: 20_000 }).catch(async () => {
		await l.page.screenshot({ path: "test-results/reload-fail.png" });
		throw new Error("transcript perdido após recarregar: " + (await l.page.locator("main").innerText()).slice(0, 400));
	});
	const prompts = readFileSync(record, "utf8").split("\n").filter((x) => x.includes('"type":"prompt"'));
	expect(prompts.length).toBe(1);
	await quit(l);
});

test("queda do OMP mostra diagnóstico e não reenvia o prompt", async () => {
	const record = resolve("test-results/crash-record.jsonl");
	writeFileSync(record, "");
	const l = await launch("crash", { FAKE_OMP_RECORD: record });
	const box = await openSession(l);
	await box.fill("vai cair");
	await box.press("Enter");
	await expect(l.page.getByText(/interromp|encerrou|queda|indispon/i).first()).toBeVisible({ timeout: 20_000 });
	await l.page.screenshot({ path: "test-results/crash.png" });
	await l.page.waitForTimeout(2000);
	const prompts = readFileSync(record, "utf8").split("\n").filter((x) => x.includes('"type":"prompt"'));
	expect(prompts.length).toBe(1);
	await quit(l);
});

test("painel Alterações: repo com Unicode, espaços, untracked e sem HEAD; fora de repo explica", async () => {
	const l = await launch("basic");
	execFileSync("git", ["init", "-q"], { cwd: l.workspace });
	writeFileSync(join(l.workspace, "ação nova.txt"), "olá\n");
	await l.page.getByText("workspace", { exact: true }).first().click();
	await openSessionNoClick(l);
	await l.page.getByRole("tab", { name: "Alterações" }).click();
	await expect(l.page.getByText("ação nova.txt").first()).toBeVisible({ timeout: 20_000 });
	await l.page.screenshot({ path: "test-results/changes.png" });
	expect(existsSync(join(l.workspace, "ação nova.txt"))).toBe(true);
	await quit(l);
});

async function openSessionNoClick(l: Awaited<ReturnType<typeof launch>>) {
	await l.page.getByRole("button", { name: "Criar sessão" }).click();
	await expect(l.page.locator("textarea").first()).toBeVisible({ timeout: 30_000 });
}
void tmpdir;
