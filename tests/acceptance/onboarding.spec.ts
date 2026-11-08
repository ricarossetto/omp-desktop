import { expect, test, type Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch, quit } from "./helpers";

function fixturePaths() {
	const dir = mkdtempSync(join(tmpdir(), "omp-onboarding-"));
	const record = join(dir, "record.jsonl");
	const config = join(dir, "config.json");
	writeFileSync(record, "");
	return { dir, record, config };
}

async function openSettings(p: Page) {
	const workspaceItem = p.getByText("workspace", { exact: true }).first();
	await expect(workspaceItem).toBeVisible({ timeout: 30_000 });
	await workspaceItem.click();
	await expect(p.getByRole("button", { name: "Nova sessão" }).first()).toBeVisible({
		timeout: 30_000,
	});
	await p.getByRole("button", { name: "Configurações" }).first().click();
	await expect(p.getByRole("dialog", { name: "Configurações" })).toBeVisible({ timeout: 20_000 });
}

test("primeiro uso percorre as 5 etapas, mostra ambiente/contas e salva o modelo", async () => {
	const { record, config } = fixturePaths();
	const l = await launch(
		"basic",
		{ FAKE_OMP_RECORD: record, FAKE_OMP_CONFIG_FILE: config },
		undefined,
		{ noCwd: true },
	);
	const p = l.page;

	// 1. Boas-vindas
	await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({
		timeout: 30_000,
	});
	await expect(p.getByText(/não é assinado digitalmente/i)).toBeVisible();
	await expect(p.getByText("O que ele não faz")).toBeVisible();
	await p.screenshot({ path: "test-results/onboarding-1-boas-vindas.png" });

	// 2. Ambiente: caminho/versão reais do fake e componentes
	await p.getByRole("button", { name: "Continuar" }).click();
	await expect(p.getByRole("heading", { name: "Seu ambiente" })).toBeVisible();
	await expect(p.getByText(/fake-omp\.ts/)).toBeVisible();
	await expect(p.getByText(/18\.16\.0/)).toBeVisible();
	await expect(p.getByText("Protocolo")).toBeVisible();
	await expect(p.getByText("Bun do host")).toBeVisible();
	await p.screenshot({ path: "test-results/onboarding-2-ambiente.png" });

	// 3. Contas: uso real do fake, percentual e indisponível
	await p.getByRole("button", { name: "Continuar" }).click();
	await expect(p.getByRole("heading", { name: "Suas contas" })).toBeVisible();
	await expect(p.getByText("dev@example.com")).toBeVisible({ timeout: 20_000 });
	await expect(p.getByText("42%")).toBeVisible();
	await expect(p.getByText("Indisponível para esta conta.").first()).toBeVisible();
	await expect(p.getByRole("button", { name: "Abrir Configurações → Contas" })).toBeDisabled();
	await p.screenshot({ path: "test-results/onboarding-3-contas.png" });

	// 4. Modelo padrão: catálogo, busca, Esc sem perder a etapa, salvamento
	await p.getByRole("button", { name: "Continuar" }).click();
	await expect(p.getByRole("heading", { name: "Modelo padrão" })).toBeVisible();
	await expect(p.getByText("Fake Model")).toBeVisible({ timeout: 20_000 });
	await expect(p.getByText("Padrão atual: fake/fake-model")).toBeVisible();
	const search = p.getByRole("searchbox", { name: "Buscar modelo" });
	await search.fill("smart");
	await expect(p.getByText("Smart Model")).toBeVisible();
	await expect(p.getByText("Fake Model")).toHaveCount(0);
	await search.press("Escape");
	await expect(search).toHaveValue("");
	await expect(p.getByRole("heading", { name: "Modelo padrão" })).toBeVisible();
	await search.fill("smart");
	await p.getByRole("button", { name: /Smart Model/ }).click();
	await p.getByRole("button", { name: "Usar como padrão" }).click();
	await expect(p.getByText("Modelo padrão atualizado para outro/smart-model.")).toBeVisible({
		timeout: 20_000,
	});
	await expect.poll(() => readFileSync(record, "utf8"), { timeout: 20_000 }).toContain(
		'"type":"config_set"',
	);
	await expect.poll(() => readFileSync(config, "utf8"), { timeout: 20_000 }).toContain(
		'"default": "outro/smart-model"',
	);
	await p.screenshot({ path: "test-results/onboarding-4-modelo.png" });

	// 5. Tema e primeiro projeto
	await p.getByRole("button", { name: "Continuar" }).click();
	await expect(p.getByRole("heading", { name: "Do seu jeito" })).toBeVisible();
	await p.getByRole("radio", { name: "Claro" }).click();
	await expect
		.poll(() => p.evaluate(() => document.documentElement.dataset.theme))
		.toBe("light");
	await p.getByRole("button", { name: "Concluir" }).click();
	await expect(p.getByRole("button", { name: /abrir pasta/i }).first()).toBeVisible({
		timeout: 20_000,
	});
	expect(
		await p.evaluate(() => window.localStorage.getItem("omp-desktop.onboarding.done")),
	).toBe("1");
	await p.screenshot({ path: "test-results/onboarding-5-concluido.png" });
	await quit(l);
});

test("pular no início não altera tema nem configuração", async () => {
	const { record, config } = fixturePaths();
	const l = await launch(
		"basic",
		{ FAKE_OMP_RECORD: record, FAKE_OMP_CONFIG_FILE: config },
		undefined,
		{ noCwd: true },
	);
	const p = l.page;
	await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({
		timeout: 30_000,
	});
	await p.getByRole("button", { name: "Pular introdução" }).click();
	await expect(p.getByRole("button", { name: /abrir pasta/i }).first()).toBeVisible({
		timeout: 20_000,
	});
	expect(await p.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();
	expect(existsSync(config)).toBe(false);
	expect(readFileSync(record, "utf8")).not.toContain("config_set");
	await quit(l);
});

test("Configurações → Geral reabre a introdução", async () => {
	const { record, config } = fixturePaths();
	const l = await launch("basic", { FAKE_OMP_RECORD: record, FAKE_OMP_CONFIG_FILE: config });
	const p = l.page;
	await openSettings(p);
	await p.getByRole("tab", { name: "Geral" }).click();
	await p.getByRole("button", { name: "Abrir introdução novamente" }).click();
	await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({
		timeout: 20_000,
	});
	await p.screenshot({ path: "test-results/onboarding-reaberto.png" });
	await p.getByRole("button", { name: "Pular introdução" }).click();
	await expect(p.getByRole("button", { name: "Nova sessão" }).first()).toBeVisible({
		timeout: 20_000,
	});
	await quit(l);
});

test("busca de contas filtra por e-mail e Esc limpa a busca", async () => {
	const { record, config } = fixturePaths();
	const l = await launch("basic", { FAKE_OMP_RECORD: record, FAKE_OMP_CONFIG_FILE: config });
	const p = l.page;
	await openSettings(p);
	await p.getByRole("tab", { name: "Contas" }).click();
	await expect(p.getByText("dev@example.com")).toBeVisible({ timeout: 20_000 });
	const search = p.getByRole("searchbox", { name: "Buscar contas e provedores" });
	await search.fill("equipe");
	await expect(p.getByText("equipe@example.com")).toBeVisible();
	await expect(p.getByText("dev@example.com")).toHaveCount(0);
	await search.press("Escape");
	await expect(search).toHaveValue("");
	await expect(p.getByText("dev@example.com")).toBeVisible();
	await expect(p.getByRole("dialog", { name: "Configurações" })).toBeVisible();
	await p.screenshot({ path: "test-results/contas-busca.png" });
	await search.press("Escape");
	await expect(p.getByRole("dialog", { name: "Configurações" })).toHaveCount(0);
	await quit(l);
});

test("seletor de idioma troca os textos do aplicativo", async () => {
	const { record, config } = fixturePaths();
	const l = await launch("basic", { FAKE_OMP_RECORD: record, FAKE_OMP_CONFIG_FILE: config });
	const p = l.page;
	await openSettings(p);
	await p.getByRole("tab", { name: "Geral" }).click();
	await p.getByRole("combobox", { name: "Idioma" }).selectOption("en-US");
	await expect(p.getByRole("heading", { name: "Settings" })).toBeVisible();
	await expect(p.getByText("Appearance and language")).toBeVisible();
	await p.getByRole("combobox", { name: "Language" }).selectOption("zh-CN");
	await expect(p.getByRole("heading", { name: "设置" })).toBeVisible();
	await expect(p.getByText("外观和语言")).toBeVisible();
	await p.screenshot({ path: "test-results/settings-idioma.png" });
	await quit(l);
});

test("Esc no seletor de modelo fecha só o seletor e preserva o rascunho", async () => {
	const { record, config } = fixturePaths();
	const l = await launch("basic", { FAKE_OMP_RECORD: record, FAKE_OMP_CONFIG_FILE: config });
	const p = l.page;
	await p.getByText("workspace", { exact: true }).first().click();
	await p.getByRole("button", { name: "Criar sessão" }).click();
	await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toBeVisible({
		timeout: 30_000,
	});
	await p.getByRole("button", { name: "Configurações" }).first().click();
	const settings = p.getByRole("dialog", { name: "Configurações" });
	await expect(settings).toBeVisible({ timeout: 20_000 });

	// Rascunho de preset em andamento dentro de Configurações.
	await p.getByRole("button", { name: "Criar preset" }).click();
	const editor = p.getByRole("group", { name: "Editor de preset" });
	const name = editor.getByLabel("Nome");
	await name.fill("rascunho-esc");

	await p.getByRole("button", { name: "Escolher modelo" }).click();
	const picker = p.getByRole("dialog", { name: "Modelos" });
	await expect(picker).toBeVisible({ timeout: 20_000 });
	// Foco sai do input de busca para um item do seletor: o Esc tem de ser
	// consumido pelo diálogo aninhado, não pelo modal de Configurações.
	await p.keyboard.press("Tab");
	await p.keyboard.press("Escape");
	await expect(picker).toHaveCount(0);
	await expect(settings).toBeVisible();
	await expect(name).toHaveValue("rascunho-esc");
	await quit(l);
});

test("catálogo vazio e uso com erro não recarregam em loop", async () => {
	const { record, config } = fixturePaths();
	const l = await launch(
		"basic",
		{
			FAKE_OMP_RECORD: record,
			FAKE_OMP_CONFIG_FILE: config,
			FAKE_OMP_MODELS: "empty",
			FAKE_OMP_USAGE: "error",
		},
		undefined,
		{ noCwd: true },
	);
	const p = l.page;
	await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({
		timeout: 30_000,
	});
	await p.getByRole("button", { name: "Continuar" }).click();
	await p.getByRole("button", { name: "Continuar" }).click();
	await expect(p.getByText(/Não foi possível consultar o uso/)).toBeVisible({ timeout: 20_000 });
	await p.getByRole("button", { name: "Continuar" }).click();
	await expect(p.getByText("O OMP não anunciou modelos.")).toBeVisible({ timeout: 20_000 });

	const count = (type: string) =>
		readFileSync(record, "utf8")
			.split("\n")
			.filter((line) => line.includes(`"type":"${type}"`)).length;
	await p.waitForTimeout(1500);
	const models = count("models_ls");
	const usage = count("usage");
	await p.waitForTimeout(1500);
	expect(count("models_ls")).toBe(models);
	expect(count("usage")).toBe(usage);
	// Uma tentativa automática por etapa; o botão continua disponível.
	expect(models).toBe(1);
	expect(usage).toBe(1);
	await quit(l);
});

test("diagnóstico embutido atualiza o checklist ao escolher outro OMP", async () => {
	const { record, config, dir } = fixturePaths();
	const alternative = join(dir, "fake-omp-alt.ts");
	copyFileSync(resolve("tests/fixtures/fake-omp.ts"), alternative);
	const l = await launch(
		"basic",
		{ FAKE_OMP_RECORD: record, FAKE_OMP_CONFIG_FILE: config },
		undefined,
		{ noCwd: true },
	);
	const p = l.page;
	await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({
		timeout: 30_000,
	});
	await p.getByRole("button", { name: "Continuar" }).click();
	await expect(p.getByRole("heading", { name: "Seu ambiente" })).toBeVisible();
	await p.getByRole("button", { name: "Abrir diagnóstico" }).first().click();
	const diagnostics = p.locator(".onb__diagnostics");
	await expect(diagnostics).toBeVisible();

	await l.app.evaluate(({ dialog }, file) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
	}, alternative);
	await diagnostics.getByRole("button", { name: /Selecionar.*OMP/i }).click();
	// Selecionar outro executável reinicia o host; a introdução volta à
	// primeira etapa. Retome o ambiente e confira o checklist atualizado.
	await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({
		timeout: 40_000,
	});
	await p.getByRole("button", { name: "Continuar" }).click();
	await expect(p.getByText(alternative, { exact: false }).first()).toBeVisible({
		timeout: 20_000,
	});
	await quit(l);
});
