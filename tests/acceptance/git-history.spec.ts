import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, quit } from "./helpers";

test("painel Alterações mostra o histórico recente de commits", async () => {
	const first = await launch("stream");
	try {
		const repo = first.workspace;
		execFileSync("git", ["init"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
		writeFileSync(join(repo, "README.md"), "hello\n");
		execFileSync("git", ["add", "README.md"], { cwd: repo });
		execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repo });

		const p = first.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toBeVisible({
			timeout: 30_000,
		});

		await p.getByRole("tab", { name: "Alterações" }).click();
		await expect(p.getByText("Histórico recente")).toBeVisible({ timeout: 30_000 });
		await expect(p.getByText("initial commit")).toBeVisible({ timeout: 30_000 });
	} finally {
		await quit(first);
	}
});
