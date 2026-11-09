import type { Configuration } from "electron-builder";

/**
 * Arquivos base do aplicativo. O coletor de node_modules do electron-builder
 * usa apenas os padrões de exclusão (`!`) desta lista; os includes acima
 * servem para `out/` e para forçar o prebuild do PTY.
 */
const baseFiles: string[] = [
	"out/**/*",
	"package.json",
	"!out/**/*.map",
	// Garante o binário ConPTY opcional (Node-API) mesmo se o coletor de
	// dependências ignorar optionalDependencies da plataforma.
	"node_modules/@lydell/**/*",
];

/**
 * Conteúdo de dependências que não é carregado pelo host Bun/Electron:
 * source maps, declarações de tipos, testes, documentação e fontes TS de
 * pacotes cujo runtime é o JS compilado. O host do SDK importa `src/*.ts`
 * dos pacotes @oh-my-pi, por isso eles não entram aqui.
 */
const nonRuntimeFiles: string[] = [
	"!**/*.map",
	"!**/*.d.ts",
	"!**/*.d.mts",
	"!**/*.d.cts",
	"!**/test/**",
	"!**/tests/**",
	"!**/__tests__/**",
	"!**/*.test.*",
	"!**/*.spec.*",
	"!**/CHANGELOG*.md",
	"!**/README*.md",
	"!**/docs/**",
	// Pacotes cujo entrypoint é JS compilado; `src` é apenas fonte/typecheck.
	"!node_modules/zod/src/**/*",
	"!node_modules/chromium-bidi/node_modules/zod/src/**/*",
	"!node_modules/puppeteer-core/src/**/*",
	"!node_modules/onnxruntime-node/lib/**/*",
	"!node_modules/onnxruntime-node/script/**/*",
	"!node_modules/@oh-my-pi/pi-coding-agent/scripts/**/*",
	// O host Bun resolve o build `node` do transformers; os bundles web não
	// são importados (o bundle WebGPU já vem embutido no build node).
	"!node_modules/@huggingface/transformers/dist/transformers.js",
	"!node_modules/@huggingface/transformers/dist/transformers.min.js",
	"!node_modules/@huggingface/transformers/dist/transformers.web.js",
	"!node_modules/@huggingface/transformers/dist/transformers.web.min.js",
	"!node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs",
];

/**
 * O onnxruntime-node publica bins de todas as plataformas. O binding resolve
 * `bin/napi-v6/${process.platform}/${process.arch}`, então os demais diretórios
 * nunca são carregados em win32-x64/linux-x64.
 */
function nativePlatformExcludes(platform: "win32" | "linux"): string[] {
	const bin = "!node_modules/onnxruntime-node/bin/napi-v6";
	return platform === "win32"
		? [`${bin}/darwin/**/*`, `${bin}/linux/**/*`, `${bin}/win32/arm64/**/*`]
		: [`${bin}/darwin/**/*`, `${bin}/win32/**/*`, `${bin}/linux/arm64/**/*`];
}

/**
 * Configuração compartilhada do electron-builder.
 *
 * O Windows continua com o instalador NSIS x64 por usuário. O Linux gera um
 * `.deb` (Debian/Ubuntu) e um `.tar.gz` que serve de fonte local para o
 * PKGBUILD do Arch. O Bun empacotado é copiado por `scripts/dist-win.ts`
 * (`.cache/bun/bun.exe`) ou por `scripts/dist-linux.ts`
 * (`resources/bun/bun`) antes do build.
 *
 * O PTY (@lydell/node-pty) usa Node-API (N-API): o binário pré-compilado é
 * estável entre Node e Electron, por isso `npmRebuild` fica desligado. Ainda
 * assim os módulos nativos são desempacotados quando o ASAR estiver habilitado.
 */
const common: Configuration = {
	appId: "local.omp.desktop",
	copyright: "Copyright © 2026 OMP Desktop contributors",
	directories: {
		output: "release",
		buildResources: "resources",
	},
	asar: false,
	asarUnpack: ["**/@lydell/node-pty*/**", "**/*.node"],
	files: baseFiles,
	// Node-API estável; os prebuilds da plataforma já vêm no pacote.
	npmRebuild: false,
	buildDependenciesFromSource: false,
	nodeGypRebuild: false,
	compression: "normal",
};

/**
 * Dependências mínimas de runtime do Electron no Debian/Ubuntu.
 *
 * As alternativas `|` cobrem a transição t64 do Debian 13/Ubuntu 24.04 sem
 * quebrar o Debian 12. Git e Node continuam opcionais e não bloqueiam a
 * instalação do aplicativo.
 */
const debDepends = [
	// t64 primeiro: no Ubuntu 24.04/26.04 `libasound2` é virtual e pode ser
	// provido pelo shim liboss4-salsa-asound2, que sombreia a libasound real.
	// Debian 12 não tem t64 e cai no pacote clássico.
	"libgtk-3-0t64 | libgtk-3-0",
	"libnotify4",
	"libnss3",
	"libxss1",
	"libxtst6",
	"xdg-utils",
	"libatspi2.0-0t64 | libatspi2.0-0",
	"libuuid1",
	"libsecret-1-0",
	"libatomic1",
	"libasound2t64 | libasound2",
	"libgbm1",
];

export function createBuilderConfig(platform: "win32" | "linux"): Configuration {
	const files = [...baseFiles, ...nonRuntimeFiles, ...nativePlatformExcludes(platform)];
	if (platform === "linux") {
		return {
			...common,
			files,
			// O Electron quebra o caminho de exec no espaço de "OMP Desktop"
			// (`execvp /opt/OMP`, zygote 127). O diretório Linux usa o nome
			// sem espaços; o nome exibido continua "OMP Desktop".
			productName: "omp-desktop",
			extraResources: [
				{ from: "resources/bun/bun", to: "bun/bun" },
				{ from: "resources/licenses", to: "licenses" },
				{ from: "LICENSE", to: "licenses/LICENSE" },
				{ from: "resources/icons", to: "icons" },
			],
			linux: {
				target: [
					{ target: "deb", arch: ["x64"] },
					{ target: "tar.gz", arch: ["x64"] },
				],
				executableName: "omp-desktop",
				icon: "resources/icons",
				category: "Development",
				synopsis: "Unofficial desktop client for the OMP coding agent",
				description:
					"OMP Desktop is an unofficial Electron client for the OMP coding agent. " +
					"It bundles the Bun runtime and provides a local terminal, session management " +
					"and OMP integration. OMP, Node and Git are installed separately by the user.",
				maintainer: "OMP Desktop contributors <omp-desktop@users.noreply.github.com>",
				vendor: "OMP Desktop contributors",
				artifactName: "OMP-Desktop-${version}-linux-${arch}.${ext}",
				syncDesktopName: true,
				desktop: {
					entry: {
						Name: "OMP Desktop",
						Comment: "Unofficial desktop client for the OMP coding agent",
						Keywords: "omp;ai;coding;agent;",
					},
				},
			},
			deb: {
				packageName: "omp-desktop",
				packageCategory: "devel",
				priority: "optional",
				depends: debDepends,
				// Git é opcional: Suggests não instala por padrão e mantém o app
				// instalável em bases mínimas. O fpm não tem campo dedicado no
				// electron-builder, então passamos a opção diretamente.
				recommends: [],
				fpm: ["--deb-suggests", "git"],
			},
		};
	}

	return {
		...common,
		files,
		productName: "OMP Desktop",
		artifactName: "OMP-Desktop-${version}-setup.${ext}",
		extraResources: [
			{ from: ".cache/bun/bun.exe", to: "bun/bun.exe" },
			{ from: "resources/licenses", to: "licenses" },
			{ from: "LICENSE", to: "licenses/LICENSE" },
		],
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
}

export default createBuilderConfig(process.platform === "linux" ? "linux" : "win32");
