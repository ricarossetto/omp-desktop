import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface Launched {
	app: ElectronApplication;
	page: Page;
	workspace: string;
	userData: string;
	errors: string[];
}

export async function launch(
	scenario = "stream",
	extraEnv: Record<string, string> = {},
	reuse?: { workspace: string; userData: string },
	options: { noCwd?: boolean; args?: string[] } = {},
): Promise<Launched> {
	const root = mkdtempSync(join(process.env.OMP_DESKTOP_TEST_ROOT ?? tmpdir(), "omp-desktop-acc-"));
	const workspace = reuse?.workspace ?? join(root, "workspace");
	const userData = reuse?.userData ?? join(root, "userdata");
	if (!reuse) mkdirSync(workspace);
	const installedExe = process.env.OMP_DESKTOP_EXE;
	const app = await electron.launch({
		...(installedExe ? { executablePath: installedExe } : {}),
		args: [
			...(installedExe ? [] : [resolve(".")]),
			// Mantém os cenários de base iguais em Windows pt-BR, en-US ou zh-CN.
			"--lang=pt-BR",
			...(options.noCwd ? [] : ["--cwd", workspace]),
			"--user-data-dir",
			userData,
			...(options.args ?? []),
		],
		env: {
			...(process.env as Record<string, string>),
			...(process.env.REAL_OMP ? {} : { OMP_DESKTOP_OMP_PATH: resolve("tests/fixtures/fake-omp.ts") }),
			OMP_DESKTOP_TEST: "1",
			FAKE_OMP_SCENARIO: scenario,
			...extraEnv,
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text());
	});
	await page.waitForLoadState("domcontentloaded");
	return { app, page, workspace, userData, errors };
}

/** Encerra sem o diálogo de confirmação de trabalho ativo. */
export async function quit(l: Launched): Promise<void> {
	await l.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
}

export function buildEntries(count: number) {
	const entries: unknown[] = [];
	let parent: string | null = null;
	const push = (message: unknown) => {
		const id = `e${entries.length + 1}`;
		entries.push({ type: "message", id, parentId: parent, timestamp: new Date().toISOString(), message });
		parent = id;
	};
	for (let i = 0; i < count; i++) {
		push({ role: "user", content: [{ type: "text", text: `pergunta ${i} `.repeat(1 + (i % 7)) }], timestamp: Date.now() });
		const blocks: unknown[] = [{ type: "text", text: `Resposta ${i}\n\n` + "linha de texto longa com **markdown**.\n".repeat(1 + (i % 15)) }];
		if (i % 5 === 0) blocks.push({ type: "text", text: "```ts\n" + "const x = 1;\n".repeat(5 + (i % 40)) + "```" });
		if (i % 4 === 0) blocks.unshift({ type: "thinking", thinking: "raciocínio ".repeat(30 + (i % 50)) });
		if (i % 3 === 0) blocks.push({ type: "toolCall", id: `t${i}`, name: "read", arguments: { path: `arquivo-${i}.txt` } });
		push({ role: "assistant", content: blocks, model: "fake-model", timestamp: Date.now() });
		if (i % 3 === 0)
			push({ role: "toolResult", toolCallId: `t${i}`, toolName: "read", content: [{ type: "text", text: "saída\n".repeat(5 + ((i * 37) % 400)) }], isError: i % 11 === 0, timestamp: Date.now() });
	}
	return { entries, leafId: parent };
}

