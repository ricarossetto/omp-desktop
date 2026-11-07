import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ompLaunchSpec, parseJsonOutput, runOmp } from "../../src/host/omp-cli";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-cli-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe("lançamento do OMP no Windows", () => {
	test("shim .cmd com alvo %~dp0 resolve o script e evita o cmd.exe", async () => {
		const dir = await tempDir();
		const target = path.join(dir, "cli.js");
		await fs.promises.writeFile(target, "console.log('ok');\n", "utf8");
		const shim = path.join(dir, "omp.cmd");
		await fs.promises.writeFile(
			shim,
			'@ECHO off\r\nset "dp0=%~dp0"\r\n"%dp0%\\cli.js" %*\r\n',
			"utf8",
		);
		const spec = ompLaunchSpec(shim, ["config", "set", "modelPresets", '{"a":1}']);
		expect(spec.command).toBe(process.execPath);
		expect(spec.args[0].toLowerCase()).toBe(target.toLowerCase());
		expect(spec.args.slice(1)).toEqual(["config", "set", "modelPresets", '{"a":1}']);
	});

	test("shim .cmd com .exe irmão usa o executável real", async () => {
		const dir = await tempDir();
		const shim = path.join(dir, "omp.cmd");
		await fs.promises.writeFile(shim, "@ECHO off\r\nbun omp.js %*\r\n", "utf8");
		await fs.promises.writeFile(path.join(dir, "omp.exe"), "fake", "utf8");
		const spec = ompLaunchSpec(shim, ["config", "list", "--json"]);
		expect(spec.command.toLowerCase()).toBe(path.join(dir, "omp.exe").toLowerCase());
		expect(spec.windowsVerbatimArguments).toBeUndefined();
	});

	test(".cmd sem alvo resolvido passa JSON intacto pelo cmd.exe (aspas, & e parênteses)", async () => {
		const dir = await tempDir();
		const dumper = path.join(dir, "argdump.ts");
		await fs.promises.writeFile(dumper, "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
		const shim = path.join(dir, "argdump.cmd");
		await fs.promises.writeFile(
			shim,
			`@echo off\r\n"${process.execPath}" "%~dp0argdump.ts" %*\r\n`,
			"utf8",
		);
		const json = JSON.stringify({ modelRoles: { task: "fake/model" }, title: 'a "b" c' });
		const result = await runOmp(shim, ["config", "set", "modelPresets", json, "a&b c", "x(y)"], {
			timeoutMs: 20_000,
		});
		expect(result.exitCode).toBe(0);
		const args = parseJsonOutput<string[]>(result.stdout);
		expect(args).toEqual(["config", "set", "modelPresets", json, "a&b c", "x(y)"]);
	});

	test(".cmd sem alvo resolvido recusa argumento com expansão %VAR% do cmd", async () => {
		const dir = await tempDir();
		const shim = path.join(dir, "argdump.cmd");
		await fs.promises.writeFile(shim, "@echo off\r\necho %*\r\n", "utf8");
		expect(() => ompLaunchSpec(shim, ["config", "set", "x", "%PATH%"])).toThrow(/cmd\.exe/);
	});

	test("leitura real de `omp config get` funciona através de um shim .cmd", async () => {
		const omp = Bun.which("omp");
		if (!omp) return;
		const dir = await tempDir();
		const shim = path.join(dir, "omp-real.cmd");
		await fs.promises.writeFile(shim, `@echo off\r\n"${omp}" %*\r\n`, "utf8");
		const result = await runOmp(shim, ["config", "get", "modelRoleStorage", "--json"], { timeoutMs: 60_000 });
		expect(result.exitCode).toBe(0);
		const parsed = parseJsonOutput<{ key?: string; value?: unknown }>(result.stdout);
		expect(parsed?.key).toBe("modelRoleStorage");
		expect(typeof parsed?.value).toBe("string");
	});
});
