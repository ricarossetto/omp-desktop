import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, quit } from "./helpers";

function argvEntries(path: string): string[][] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type?: string; argv?: unknown })
			.filter(
				(entry): entry is { type: "argv"; argv: string[] } =>
					entry.type === "argv" &&
					Array.isArray(entry.argv) &&
					entry.argv.every((item) => typeof item === "string"),
			)
			.map((entry) => entry.argv);
	} catch {
		return [];
	}
}

test("modo de aprovação chega ao OMP e muda ao reiniciar a sessão", async () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-approval-"));
	const recordPath = join(dir, "record.jsonl");
	const first = await launch("stream", { FAKE_OMP_RECORD: recordPath });
	try {
		const p = first.page;
		await p.getByText("workspace", { exact: true }).first().click();
		await p.getByRole("button", { name: "Criar sessão" }).click();
		await expect(p.getByRole("textbox", { name: "Mensagem para o OMP" })).toBeVisible({
			timeout: 30_000,
		});

		// O padrão do desktop é `write`, nunca o `yolo` implícito do OMP.
		await expect
			.poll(() => argvEntries(recordPath).some((argv) => argv.includes("--approval-mode=write")))
			.toBe(true);

		await p.locator(".statusbar__approval").click();
		await p.getByRole("menuitemradio", { name: /YOLO/ }).click();
		await expect
			.poll(() => argvEntries(recordPath).some((argv) => argv.includes("--approval-mode=yolo")))
			.toBe(true);
		await expect(p.locator(".statusbar__approval")).toContainText("YOLO");
	} finally {
		await quit(first);
		rmSync(dir, { recursive: true, force: true });
	}
});
