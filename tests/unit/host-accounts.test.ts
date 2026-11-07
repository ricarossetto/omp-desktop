import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AccountError, readAccountUsage } from "../../src/host/accounts";

const FAKE_OMP = path.resolve(import.meta.dir, "../fixtures/fake-omp.ts");
const cleanup: string[] = [];

afterEach(async () => {
	for (const dir of cleanup.splice(0)) {
		await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
});

async function tempDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-accounts-"));
	cleanup.push(dir);
	return dir;
}

describe("readAccountUsage", () => {
	test("projeta cotas sem inventar conta ativa", async () => {
		const cwd = await tempDir();
		const usage = await readAccountUsage({ ompPath: FAKE_OMP, cwd });
		const fake = usage.providers.find((provider) => provider.providerId === "fake");
		expect(fake?.accounts[0].windows[0].usedPercent).toBe(42);
		expect(usage.unknown).toBe(false);
		for (const provider of usage.providers) {
			for (const account of provider.accounts) {
				expect(Object.hasOwn(account, "active")).toBe(false);
			}
		}
	});

	test("aceita used/limit e devolve 50%", async () => {
		const cwd = await tempDir();
		const usage = await readAccountUsage({
			ompPath: FAKE_OMP,
			cwd,
			env: { FAKE_OMP_USAGE: "used_limit" },
		});
		const fake = usage.providers.find((provider) => provider.providerId === "fake");
		expect(fake?.accounts[0].windows[0].usedPercent).toBe(50);
	});

	test("falha do OMP vira OMP_UNAVAILABLE", async () => {
		const cwd = await tempDir();
		try {
			await readAccountUsage({ ompPath: FAKE_OMP, cwd, env: { FAKE_OMP_USAGE: "error" } });
			throw new Error("esperava AccountError");
		} catch (error) {
			expect(error).toBeInstanceOf(AccountError);
			expect((error as AccountError).code).toBe("OMP_UNAVAILABLE");
		}
	});
});
