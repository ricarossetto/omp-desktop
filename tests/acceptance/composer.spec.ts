import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { launch, quit } from "./helpers";

mkdirSync("test-results", { recursive: true });

test("pausa depois do passo atual interrompe e recupera rascunho", async () => {
	const record = resolve(tmpdir(), "pause-record.jsonl");
	writeFileSync(record, "");
	const l = await launch("longtool", { FAKE_OMP_RECORD: record });
	const p = l.page;
	await p.getByText("workspace", { exact: true }).first().click();
	await p.getByRole("button", { name: "Criar sessão" }).click();
	const box = p.locator("textarea").first();
	await expect(box).toBeVisible({ timeout: 30_000 });
	await box.fill("trabalho longo");
	await box.press("Enter");
	const pause = p.getByRole("button", { name: "Pausar depois do passo atual" });
	await expect(pause).toBeVisible({ timeout: 20_000 });
	await pause.click();
	// Após o passo terminar, o app envia abort_and_restore_queue sozinho.
	await expect
		.poll(() => readFileSync(record, "utf8"), { timeout: 60_000 })
		.toContain("abort_and_restore_queue");
	// Continuar envia nova mensagem, não reenvia a anterior.
	await expect(p.getByRole("button", { name: /continuar/i }).first()).toBeVisible({ timeout: 20_000 });
	await p.getByRole("button", { name: /continuar/i }).click();
	// O primeiro prompt já está no arquivo: espera o segundo, não só "existe prompt".
	await expect
		.poll(
			() => readFileSync(record, "utf8").split("\n").filter((x) => x.includes('"type":"prompt"')).length,
			{ timeout: 30_000 },
		)
		.toBe(2);
	const prompts = readFileSync(record, "utf8").split("\n").filter((x) => x.includes('"type":"prompt"'));
	expect(prompts[1]).toContain("Continue de onde parou");
	await quit(l);
});

test("durante o trabalho: Parar visível, rodapé Trabalhando e pausa disponível", async () => {
	const l = await launch("longtool");
	const p = l.page;
	await p.getByText("workspace", { exact: true }).first().click();
	await p.getByRole("button", { name: "Criar sessão" }).click();
	const box = p.locator("textarea").first();
	await expect(box).toBeVisible({ timeout: 30_000 });
	await box.fill("trabalho longo");
	await box.press("Enter");
	// O host marca "busy" no ack do prompt: Parar e Trabalhando aparecem juntos.
	await expect(p.getByRole("button", { name: "Parar" })).toBeVisible({ timeout: 20_000 });
	await expect(p.getByRole("status").filter({ hasText: "Trabalhando" })).toBeVisible();
	await expect(p.getByRole("button", { name: "Pausar depois do passo atual" })).toBeVisible();
	await quit(l);
});

test("fila: Enviar depois entra na fila e Enviar agora promove", async () => {
	const record = resolve(tmpdir(), "queue-record.jsonl");
	writeFileSync(record, "");
	const l = await launch("longtool", { FAKE_OMP_RECORD: record });
	const p = l.page;
	await p.getByText("workspace", { exact: true }).first().click();
	await p.getByRole("button", { name: "Criar sessão" }).click();
	const box = p.locator("textarea").first();
	await expect(box).toBeVisible({ timeout: 30_000 });
	await box.fill("primeira");
	await box.press("Enter");
	// Enquanto o agente trabalha, o texto digitado vira "Enviar depois" (follow_up).
	await expect(p.getByRole("button", { name: "Pausar depois do passo atual" })).toBeVisible({ timeout: 20_000 });
	await box.fill("segunda em espera");
	await p.getByRole("button", { name: "Enviar depois" }).click();
	await expect.poll(() => readFileSync(record, "utf8"), { timeout: 45_000 }).toContain('"command":"follow_up"');
	// O chip da fila aparece com a mensagem e a ação de enviar agora.
	await expect(p.getByText("segunda em espera").first()).toBeVisible({ timeout: 20_000 });
	const promote = p.getByRole("button", { name: /enviar agora/i }).first();
	await expect(promote).toBeVisible();
	await promote.click();
	await expect.poll(() => readFileSync(record, "utf8"), { timeout: 45_000 }).toContain('"command":"promote_queued_message"');
	await quit(l);
});
