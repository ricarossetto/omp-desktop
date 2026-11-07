import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
	isOmpVersionCompatible,
	OMP_BASELINE_VERSION,
	parseGitVersion,
	parseOmpVersion,
	RuntimeResolver,
} from "../../src/main/runtime";
import { intersectsAnyDisplay, rectangleIntersectionArea, restoreWindowBounds } from "../../src/main/window-state";

describe("versões e compatibilidade", () => {
	test("lê a versão do OMP e exige major >= 18 como o host", () => {
		expect(parseOmpVersion("omp/18.16.0")).toBe("18.16.0");
		expect(parseOmpVersion("OMP 18.16.0-beta.1")).toBe("18.16.0-beta.1");
		expect(parseOmpVersion("sem versão")).toBeUndefined();
		expect(isOmpVersionCompatible(OMP_BASELINE_VERSION)).toBe(true);
		expect(isOmpVersionCompatible("18.1.0")).toBe(true);
		expect(isOmpVersionCompatible("19.0.0")).toBe(true);
		expect(isOmpVersionCompatible("25.3.1")).toBe(true);
		expect(isOmpVersionCompatible("17.99.0")).toBe(false);
		expect(isOmpVersionCompatible(undefined)).toBe(false);
	});

	test("lê a versão do Git", () => {
		expect(parseGitVersion("git version 2.47.0.windows.1")).toBe("2.47.0");
		expect(parseGitVersion("comando desconhecido")).toBeUndefined();
	});

	test("versão major > 18 é aceita com aviso e status não bloqueia", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-runtime-"));
		const fixture = path.join(dir, "omp-futuro.ts");
		await writeFile(fixture, 'console.log("omp/19.2.0");\n');
		const resolver = new RuntimeResolver({
			userDataDir: dir,
			appPath: dir,
			resourcesPath: dir,
			isPackaged: false,
			execPath: "bun",
		});
		const probe = await resolver.probeOmpPath(fixture);
		expect(probe.compatible).toBe(true);
		expect(probe.ompVersion).toBe("19.2.0");
		expect(probe.message).toMatch(/não foi validado/i);

		await resolver.saveOmpPath(fixture);
		const status = await resolver.buildStatus(true);
		expect(status.phase).not.toBe("omp-incompatible");
		expect(status.message).toMatch(/não foi validado/i);
		await rm(dir, { recursive: true, force: true });
	});

	test("seleção manual persistida vence OMP_DESKTOP_OMP_PATH; env é fallback", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-runtime-"));
		const envFixture = path.join(dir, "omp-env.ts");
		const savedFixture = path.join(dir, "omp-manual.ts");
		await writeFile(envFixture, 'console.log("omp/18.16.0");\n');
		await writeFile(savedFixture, 'console.log("omp/18.20.0");\n');
		const resolver = new RuntimeResolver({
			userDataDir: dir,
			appPath: dir,
			resourcesPath: dir,
			isPackaged: false,
			execPath: "bun",
			env: { ...process.env, OMP_DESKTOP_OMP_PATH: envFixture },
		});

		const fallback = await resolver.resolveOmp();
		expect(fallback.source).toBe("env");
		expect(fallback.ompPath).toBe(envFixture);

		await resolver.saveOmpPath(savedFixture);
		const manual = await resolver.resolveOmp();
		expect(manual.source).toBe("config");
		expect(manual.ompPath).toBe(savedFixture);
		expect(manual.ompVersion).toBe("18.20.0");
		expect(manual.compatible).toBe(true);

		const persisted = await readFile(path.join(dir, "runtime.json"), "utf8");
		expect(persisted).toContain("omp-manual.ts");
		await rm(dir, { recursive: true, force: true });
	});

	test("probe de caminho inválido não é compatível", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "omp-runtime-"));
		const resolver = new RuntimeResolver({
			userDataDir: dir,
			appPath: dir,
			resourcesPath: dir,
			isPackaged: false,
			execPath: "bun",
		});
		const missing = await resolver.probeOmpPath(path.join(dir, "omp-inexistente.exe"));
		expect(missing.compatible).toBe(false);
		expect(missing.message).toContain("não foi encontrado");
		await writeFile(path.join(dir, "omp.txt"), "não é executável");
		const invalid = await resolver.probeOmpPath(path.join(dir, "omp.txt"));
		expect(invalid.compatible).toBe(false);
		const fixture = path.join(dir, "omp-fixture.ts");
		await writeFile(fixture, 'console.log("omp/18.16.0");\n');
		const valid = await resolver.probeOmpPath(fixture);
		expect(valid.compatible).toBe(true);
		expect(valid.ompVersion).toBe("18.16.0");
		await rm(dir, { recursive: true, force: true });
	});
});

describe("geometria da janela", () => {
	const display = { x: 0, y: 0, width: 1920, height: 1080 };

	test("calcula interseção e exige área visível mínima", () => {
		expect(rectangleIntersectionArea({ x: 0, y: 0, width: 100, height: 100 }, display)).toBe(10000);
		expect(intersectsAnyDisplay({ x: 100, y: 100, width: 1000, height: 800 }, [display])).toBe(true);
		expect(intersectsAnyDisplay({ x: -5000, y: 10, width: 1000, height: 800 }, [display])).toBe(false);
	});

	test("restaura apenas posição que intersecta um monitor", () => {
		const visible = restoreWindowBounds(
			{ x: 120, y: 80, width: 1400, height: 900, maximized: true },
			[display],
			{ width: 1440, height: 920, minWidth: 1000, minHeight: 700 },
		);
		expect(visible.bounds.x).toBe(120);
		expect(visible.maximized).toBe(true);

		const offscreen = restoreWindowBounds(
			{ x: 9000, y: 9000, width: 1400, height: 900 },
			[display],
			{ width: 1440, height: 920, minWidth: 1000, minHeight: 700 },
		);
		expect(offscreen.bounds.x).toBeUndefined();
		expect(offscreen.bounds.width).toBe(1400);
		expect(offscreen.maximized).toBe(false);
	});

	test("respeita tamanho mínimo salvo", () => {
		const restored = restoreWindowBounds(
			{ x: 10, y: 10, width: 300, height: 200 },
			[display],
			{ width: 1440, height: 920, minWidth: 1000, minHeight: 700 },
		);
		expect(restored.bounds.width).toBe(1000);
		expect(restored.bounds.height).toBe(700);
	});
});
