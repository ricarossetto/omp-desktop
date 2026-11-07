import { defineConfig } from "@playwright/test";

/**
 * Aceitação Electron real (Playwright `_electron`).
 * Os testes vivem em tests/acceptance e usam workspace/fixtures isolados.
 */
export default defineConfig({
	testDir: "tests/acceptance",
	testMatch: /.*\.spec\.ts$/,
	timeout: 120_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
});
