import { join } from "node:path";
import { expect, test } from "bun:test";

const childScript = join(import.meta.dir, "process-tree-windows-cases.ts");

interface ChildResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * `mock.module` do Bun não é isolado por arquivo. Os casos Windows rodam em um
 * processo Bun filho (arquivo sem sufixo de teste, não descoberto pela suíte)
 * para não substituir `node:child_process`, `process.platform` e `process.kill`
 * no processo dos demais testes.
 */
async function runWindowsCases(): Promise<ChildResult> {
	const { promise, resolve } = Promise.withResolvers<ChildResult>();
	const child = Bun.spawn([process.execPath, "test", childScript], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1" },
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	void child.exited.then(async (code) => {
		resolve({ code, stdout: await stdout, stderr: await stderr });
	});
	return promise;
}

test(
	"encerramento no Windows recusa identidade incompleta e não sinaliza descendentes após falha",
	async () => {
		const result = await runWindowsCases();
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("PROCESS_TREE_WINDOWS_CASES_OK");
	},
	30_000,
);

