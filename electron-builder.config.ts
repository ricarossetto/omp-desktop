import type { Configuration } from "electron-builder";

/**
 * Instalador NSIS x64 por usuário (sem admin).
 *
 * `asar: false` mantém o host Bun (`out/host/index.js`) e as dependências de
 * produção (OMP/zod) executáveis fora do arquivo ASAR. O Bun empacotado é
 * copiado para `resources/bun/bun.exe` por `scripts/dist-win.ts` antes do build.
 *
 * O PTY (@lydell/node-pty) usa Node-API (N-API): o binário pré-compilado é
 * estável entre Node e Electron, por isso `npmRebuild` fica desligado. Ainda
 * assim os módulos nativos são desempacotados quando o ASAR estiver habilitado.
 */
const config: Configuration = {
	appId: "local.omp.desktop",
	productName: "OMP Desktop",
	copyright: "Copyright © 2026 OMP Desktop contributors",
	artifactName: "OMP-Desktop-${version}-setup.${ext}",
	directories: {
		output: "release",
		buildResources: "resources",
	},
	asar: false,
	asarUnpack: ["**/@lydell/node-pty*/**", "**/*.node"],
	files: [
		"out/**/*",
		"package.json",
		"!out/**/*.map",
		// Garante o binário ConPTY opcional (Node-API) mesmo se o coletor de
		// dependências ignorar optionalDependencies da plataforma.
		"node_modules/@lydell/**/*",
	],
	extraResources: [
		{ from: ".cache/bun/bun.exe", to: "bun/bun.exe" },
		{ from: "resources/licenses", to: "licenses" },
	],
	// Node-API estável; os prebuilds win32-x64 já vêm no pacote.
	npmRebuild: false,
	buildDependenciesFromSource: false,
	nodeGypRebuild: false,
	compression: "normal",
	win: {
		target: [{ target: "nsis", arch: ["x64"] }],
		icon: "resources/icon.ico",
		requestedExecutionLevel: "asInvoker",
		signAndEditExecutable: true,
	},
	nsis: {
		oneClick: false,
		perMachine: false,
		allowElevation: false,
		createDesktopShortcut: true,
		createStartMenuShortcut: true,
		shortcutName: "OMP Desktop",
		uninstallDisplayName: "OMP Desktop",
		deleteAppDataOnUninstall: false,
		differentialPackage: false,
		runAfterFinish: false,
	},
};

export default config;
