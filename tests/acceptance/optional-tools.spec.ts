import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { launch, quit, type Launched } from "./helpers";

/**
 * PATH sem git.exe/node.exe (a máquina de desenvolvimento pode tê-los) e com
 * Bun explícito. O perfil/LOCALAPPDATA temporários isolam a pasta gerenciada
 * `omp-desktop/tools`, então o teste nunca lê nem escreve as ferramentas do dono.
 */
function isolatedEnvironment(): {
	env: Record<string, string>;
	profile: string;
	root: string;
} {
	const exec = process.execPath;
	const bunPath = /bun(\.exe)?$/i.test(exec)
		? exec
		: execFileSync("where.exe", ["bun"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim() ?? exec;
	const dirs = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter((dir) => dir.length > 0)
		.filter(
			(dir) =>
				!existsSync(path.join(dir, "git.exe")) &&
				!existsSync(path.join(dir, "git.cmd")) &&
				!existsSync(path.join(dir, "node.exe")) &&
				!existsSync(path.join(dir, "node.cmd")),
		);
	const root = mkdtempSync(path.join(tmpdir(), "omp-optional-ui-"));
	const profile = path.join(root, "profile");
	mkdirSync(profile, { recursive: true });
	return {
		root,
		profile,
		env: {
			PATH: dirs.join(path.delimiter),
			OMP_DESKTOP_BUN_PATH: bunPath,
			USERPROFILE: profile,
			HOME: profile,
			APPDATA: path.join(profile, "AppData", "Roaming"),
			LOCALAPPDATA: path.join(profile, "AppData", "Local"),
		},
	};
}

async function openEnvironmentStep(l: Launched): Promise<Page> {
	const p = l.page;
	await p.setViewportSize({ width: 1024, height: 768 });
	await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({
		timeout: 30_000,
	});
	await p.getByRole("button", { name: "Continuar" }).click();
	await expect(p.getByRole("heading", { name: "Seu ambiente" })).toBeVisible();
	return p;
}

async function quitGracefully(l: Launched): Promise<void> {
	await l.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
	await l.app.close().catch(() => undefined);
}

test("introdução mostra Git/Node opcionais, consentimento e método manual em 1024x768", async () => {
	const { env, root } = isolatedEnvironment();
	const l = await launch("basic", env, undefined, { noCwd: true });
	try {
		const p = await openEnvironmentStep(l);
		await expect(
			p.getByRole("heading", { name: "Ferramentas de desenvolvimento opcionais" }),
		).toBeVisible();
		await expect(p.getByText("Git", { exact: true }).first()).toBeVisible();
		await expect(p.getByText("Node.js LTS", { exact: true })).toBeVisible();
		await expect(p.getByText("Não instalado").first()).toBeVisible();
		await expect(p.getByText("Incluído no aplicativo").first()).toBeVisible();

		// Ausência de Git/Node não bloqueia a introdução.
		const continueButton = p.getByRole("button", { name: "Continuar" });
		await expect(continueButton).toBeEnabled();
		await expect(p.getByRole("button", { name: "Fechar introdução" })).toBeVisible();

		// Clique explícito abre o consentimento; cancelar não instala nada.
		await p.getByTestId("install-git").click();
		await expect(p.getByText(/baixa Git da fonte oficial/i)).toBeVisible();
		await expect(p.getByRole("button", { name: "Baixar e instalar" })).toBeVisible();
		await p.getByRole("button", { name: "Cancelar" }).click();
		await expect(p.getByText(/baixa Git da fonte oficial/i)).toHaveCount(0);

		// Método manual continua disponível sem executar nada.
		const gitRow = p.locator('[data-dependency="git"]');
		const nodeRow = p.locator('[data-dependency="node"]');
		await gitRow.getByText("Prefere instalar manualmente? Use a página oficial:").click();
		await expect(gitRow.getByText("https://git-scm.com/download/win")).toBeVisible();
		await nodeRow.getByText("Prefere instalar manualmente? Use a página oficial:").click();
		await expect(nodeRow.getByText("https://nodejs.org/en/download")).toBeVisible();

		// A mesma seção aparece no diagnóstico embutido.
		await p.getByRole("button", { name: "Abrir diagnóstico" }).first().click();
		const diagnostics = p.locator(".omp-diagnostics");
		await expect(diagnostics).toBeVisible();
		await expect(
			diagnostics.getByRole("heading", { name: "Ferramentas de desenvolvimento opcionais" }),
		).toBeVisible();
		await p.screenshot({ path: "test-results/optional-tools-1024.png" });
	} finally {
		await quitGracefully(l);
		rmSync(root, { recursive: true, force: true });
	}
});

test("Configurações → Geral mostra a mesma seção de ferramentas opcionais", async () => {
	const { env, root } = isolatedEnvironment();
	const l = await launch("basic", env);
	try {
		const p = l.page;
		await p.setViewportSize({ width: 1024, height: 768 });
		const workspaceItem = p.getByText("workspace", { exact: true }).first();
		await expect(workspaceItem).toBeVisible({ timeout: 30_000 });
		await workspaceItem.click();
		await expect(p.getByRole("button", { name: "Nova sessão" }).first()).toBeVisible({
			timeout: 30_000,
		});
		await p.getByRole("button", { name: "Configurações" }).first().click();
		const dialog = p.getByRole("dialog", { name: "Configurações" });
		await expect(dialog).toBeVisible({ timeout: 20_000 });
		await dialog.getByRole("tab", { name: "Geral" }).click();
		await expect(
			dialog.getByRole("heading", { name: "Ferramentas de desenvolvimento opcionais" }),
		).toBeVisible();
		await expect(dialog.getByTestId("install-git")).toBeVisible();
		await expect(dialog.getByTestId("install-node")).toBeVisible();
		await p.screenshot({ path: "test-results/optional-tools-settings-1024.png" });
	} finally {
		await quitGracefully(l);
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * QA opt-in do caminho real: um clique em cada ferramenta baixa o artefato
 * oficial, confere o SHA-256 e ativa no perfil temporário. Não usa o HOME do
 * dono, não instala dependências de projeto e não envia prompt a modelo.
 * Rode com `OMP_DESKTOP_REAL_DEPENDENCY_INSTALL=1`.
 */
test("instalação real de Git e Node pela interface em perfil temporário", async () => {
	test.skip(
		process.env.OMP_DESKTOP_REAL_DEPENDENCY_INSTALL !== "1",
		"defina OMP_DESKTOP_REAL_DEPENDENCY_INSTALL=1 para o download real pela UI",
	);
	test.setTimeout(1_800_000);
	const { env, profile, root } = isolatedEnvironment();
	const l = await launch("basic", env, undefined, { noCwd: true });
	try {
		const p = await openEnvironmentStep(l);
		const gitRow = p.locator('[data-dependency="git"]');
		const nodeRow = p.locator('[data-dependency="node"]');

		await p.getByTestId("install-git").click();
		await p.getByRole("button", { name: "Baixar e instalar" }).click();
		await expect(gitRow.getByText("Instalado")).toBeVisible({ timeout: 600_000 });
		await expect(gitRow.getByText(/Versão 2\./)).toBeVisible();

		await p.getByTestId("install-node").click();
		await p.getByRole("button", { name: "Baixar e instalar" }).click();
		await expect(nodeRow.getByText("Instalado")).toBeVisible({ timeout: 600_000 });
		await expect(nodeRow.getByText(/Versão 2[0-9]\./)).toBeVisible();
		await expect(nodeRow.getByText("Inclui npm.")).toBeVisible();

		const tools = path.join(profile, "AppData", "Local", "omp-desktop", "tools");
		const gitExe = path.join(tools, "git", "cmd", "git.exe");
		const nodeExe = path.join(tools, "node", "node.exe");
		const npmCmd = path.join(tools, "node", "npm.cmd");
		expect(existsSync(gitExe)).toBe(true);
		expect(existsSync(nodeExe)).toBe(true);
		expect(existsSync(npmCmd)).toBe(true);
		const cleanEnv = {
			...process.env,
			PATH: [path.dirname(gitExe), path.dirname(nodeExe), "C:\\Windows\\System32", "C:\\Windows"].join(
				path.delimiter,
			),
			USERPROFILE: profile,
			HOME: profile,
			APPDATA: path.join(profile, "AppData", "Roaming"),
			LOCALAPPDATA: path.join(profile, "AppData", "Local"),
		};
		expect(execFileSync(gitExe, ["--version"], { encoding: "utf8", env: cleanEnv })).toMatch(
			/git version 2\./,
		);
		expect(execFileSync(nodeExe, ["--version"], { encoding: "utf8", env: cleanEnv })).toMatch(/^v2[0-9]\./);
		// Um processo novo, com o PATH do app, resolve as três ferramentas para a
		// pasta gerenciada (não para uma instalação global).
		expect(
			execFileSync("where.exe", ["git.exe"], { encoding: "utf8", env: cleanEnv }).toLowerCase(),
		).toContain(path.dirname(gitExe).toLowerCase());
		expect(
			execFileSync("where.exe", ["node.exe"], { encoding: "utf8", env: cleanEnv }).toLowerCase(),
		).toContain(path.dirname(nodeExe).toLowerCase());
		expect(
			execFileSync("where.exe", ["npm.cmd"], { encoding: "utf8", env: cleanEnv }).toLowerCase(),
		).toContain(path.dirname(npmCmd).toLowerCase());
		const npmCli = path.join(tools, "node", "node_modules", "npm", "bin", "npm-cli.js");
		expect(existsSync(npmCli)).toBe(true);
		expect(
			execFileSync(nodeExe, [npmCli, "--version"], { encoding: "utf8", env: cleanEnv }).trim(),
		).toMatch(/^\d+\.\d+\.\d+/);
		await p.screenshot({ path: "test-results/optional-tools-installed.png" });
	} finally {
		await quitGracefully(l);
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* o host pode ainda estar liberando os arquivos; o diretório é temporário */
		}
	}
});
