import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolve } from "node:path";
import { launch, type Launched } from "./helpers";

/**
 * PATH sem nenhum `omp` (a máquina de desenvolvimento pode ter um instalado),
 * mantendo System32/Git/PowerShell e apontando o Bun explicitamente. O diretório
 * vazio fica no início do PATH para o teste de detecção externa.
 */
function isolatedPath(): { pathValue: string; lateDir: string; bunPath: string } {
	const lateDir = mkdtempSync(path.join(tmpdir(), "omp-late-"));
	const exec = process.execPath;
	const bunPath = /bun(\.exe)?$/i.test(exec)
		? exec
		: execFileSync("where.exe", ["bun"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim() ?? exec;
	const dirs = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter((dir) => dir.length > 0)
		.filter(
			(dir) =>
				!existsSync(path.join(dir, "omp.exe")) &&
				!existsSync(path.join(dir, "omp.cmd")) &&
				!existsSync(path.join(dir, "omp")),
		);
	return { pathValue: [lateDir, ...dirs].join(path.delimiter), lateDir, bunPath };
}

function launchWithoutOmp(bunPath: string, pathValue: string) {
	return launch(
		"basic",
		{
			PATH: pathValue,
			OMP_DESKTOP_BUN_PATH: bunPath,
			OMP_DESKTOP_OMP_PATH: "",
		},
		undefined,
		{ noCwd: true, noOmp: true },
	);
}

/**
 * Fecha pelo fluxo normal do app (sem trabalho ativo, portanto sem diálogo)
 * para o host e o processo OMP serem encerrados junto; `app.exit(0)` deixaria
 * filhos órfãos entre specs.
 */
async function quitGracefully(l: Launched): Promise<void> {
	await l.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
	await l.app.close().catch(() => undefined);
}

test("primeiro uso sem OMP mostra instalação e seleção manual em 1024x768", async () => {
	const { pathValue, lateDir, bunPath } = isolatedPath();
	const l = await launchWithoutOmp(bunPath, pathValue);
	const p = l.page;
	await p.setViewportSize({ width: 1024, height: 768 });

	await expect(p.getByRole("heading", { name: "Diagnóstico" })).toBeVisible({ timeout: 30_000 });
	await expect(p.getByText("OMP não encontrado").first()).toBeVisible();
	await expect(p.getByRole("button", { name: "Instalar OMP", exact: true })).toBeVisible();
	await expect(p.getByRole("button", { name: "Instalar OMP automaticamente" })).toBeVisible();
	await expect(p.getByRole("button", { name: "Selecionar omp.exe" })).toBeVisible();
	await expect(p.getByRole("button", { name: "Verificar novamente" }).first()).toBeVisible();
	await p.screenshot({ path: "test-results/omp-ausente-1024.png" });
	await quitGracefully(l);
});

test("OMP que aparece depois é detectado e retoma a introdução sem reiniciar", async () => {
	const { pathValue, lateDir, bunPath } = isolatedPath();
	const l = await launchWithoutOmp(bunPath, pathValue);
	const p = l.page;
	await p.setViewportSize({ width: 1024, height: 768 });
	await expect(p.getByRole("heading", { name: "Diagnóstico" })).toBeVisible({ timeout: 30_000 });

	// Instalação externa simulada: shim .cmd no diretório que já está no PATH
	// do processo principal. O host resolve o shim para o script fake.
	copyFileSync(resolve("tests/fixtures/fake-omp.ts"), path.join(lateDir, "fake-omp.ts"));
	writeFileSync(
		path.join(lateDir, "omp.cmd"),
		`@echo off\r\n"${bunPath}" "%~dp0fake-omp.ts" %*\r\n`,
	);

	await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({
		timeout: 60_000,
	});
	await expect(p.getByRole("button", { name: "Pular introdução" })).toBeVisible();
	await expect(p.getByRole("button", { name: "Fechar introdução" })).toBeVisible();
	await p.screenshot({ path: "test-results/omp-detectado-1024.png" });
	await quitGracefully(l);
});

/**
 * QA opt-in do caminho completo da interface: clica em "Instalar OMP", deixa o
 * main baixar o binário oficial, confere o SHA-256 e ativa o host. Usa perfil e
 * PI_INSTALL_DIR temporários; não toca no `~/.omp` nem no OMP do dono e não
 * envia prompt. Rode com `OMP_DESKTOP_REAL_INSTALL_DOWNLOAD=1`.
 */
test("instalação real pela interface baixa e ativa o OMP isolado", async () => {
	test.skip(
		process.env.OMP_DESKTOP_REAL_INSTALL_DOWNLOAD !== "1",
		"defina OMP_DESKTOP_REAL_INSTALL_DOWNLOAD=1 para o download real pela UI",
	);
	test.setTimeout(900_000);
	const { pathValue, bunPath } = isolatedPath();
	const root = mkdtempSync(path.join(tmpdir(), "omp-ui-install-"));
	const profile = path.join(root, "profile");
	const installDir = path.join(root, "omp");
	const l = await launch(
		"basic",
		{
			PATH: pathValue,
			OMP_DESKTOP_BUN_PATH: bunPath,
			OMP_DESKTOP_OMP_PATH: "",
			PI_INSTALL_DIR: installDir,
			USERPROFILE: profile,
			HOME: profile,
			APPDATA: path.join(profile, "AppData", "Roaming"),
			LOCALAPPDATA: path.join(profile, "AppData", "Local"),
		},
		undefined,
		{ noCwd: true, noOmp: true },
	);
	try {
		const p = l.page;
		await expect(p.getByRole("heading", { name: "Diagnóstico" })).toBeVisible({ timeout: 30_000 });
		await expect(p.getByText("OMP não encontrado").first()).toBeVisible();
		await p.getByRole("button", { name: "Instalar OMP", exact: true }).click();
		// A instalação só termina quando o host reinicia com o binário baixado.
		await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({
			timeout: 600_000,
		});
		const ompPath = path.join(installDir, "omp.exe");
		expect(existsSync(ompPath)).toBe(true);
		expect(statSync(ompPath).size).toBeGreaterThan(200_000_000);
		const version = execFileSync(ompPath, ["--version"], {
			env: {
				...process.env,
				PATH: "C:\\Windows\\System32;C:\\Windows",
				USERPROFILE: profile,
				HOME: profile,
			},
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(version).toContain("18.16.0");
		// A UI também precisa refletir o caminho/versão reais após o clique.
		await p.getByRole("button", { name: "Continuar" }).click();
		await expect(p.getByRole("heading", { name: "Seu ambiente" })).toBeVisible();
		await expect(p.getByText(ompPath)).toBeVisible();
		await expect(p.getByText(/18\.16\.0/)).toBeVisible();
		await expect(p.getByText("Pronto").first()).toBeVisible();
		await p.screenshot({ path: "test-results/omp-instalado-ui.png" });
	} finally {
		await quitGracefully(l);
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* o host pode ainda estar liberando o binário; o diretório é temporário */
		}
	}
});

/**
 * Smoke real opcional: rode `bun scripts/smoke-omp-install.ts --keep` e depois
 * `OMP_DESKTOP_REAL_INSTALL=<omp.exe> bunx playwright test ...`. O perfil do
 * OMP é redirecionado para um diretório temporário, então o `~/.omp` do dono
 * da máquina não é tocado.
 */
test("instalação real é adotada pelo app e aparece no ambiente", async () => {
	const realOmp = process.env.OMP_DESKTOP_REAL_INSTALL ?? "";
	test.skip(realOmp.length === 0, "defina OMP_DESKTOP_REAL_INSTALL para o smoke real");
	const profile = mkdtempSync(path.join(tmpdir(), "omp-real-profile-"));
	const l = await launch(
		"basic",
		{
			OMP_DESKTOP_OMP_PATH: realOmp,
			USERPROFILE: profile,
			HOME: profile,
			APPDATA: path.join(profile, "AppData", "Roaming"),
			LOCALAPPDATA: path.join(profile, "AppData", "Local"),
		},
		undefined,
		{ noCwd: true, noOmp: true },
	);
	const p = l.page;
	await expect(p.getByRole("heading", { name: /o OMP, agora com janela/i })).toBeVisible({
		timeout: 60_000,
	});
	await p.getByRole("button", { name: "Continuar" }).click();
	await expect(p.getByRole("heading", { name: "Seu ambiente" })).toBeVisible();
	await expect(p.getByText(realOmp)).toBeVisible();
	await expect(p.getByText(/18\.16\.0/)).toBeVisible();
	await expect(p.getByText("Pronto").first()).toBeVisible();
	await p.screenshot({ path: "test-results/omp-real-ambiente.png" });
	await quitGracefully(l);
	try {
		rmSync(profile, { recursive: true, force: true });
	} catch {
		/* o host pode ainda estar liberando o perfil; o diretório é temporário */
	}
});
