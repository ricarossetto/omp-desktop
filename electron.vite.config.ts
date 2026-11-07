import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: { outDir: "out/main", rollupOptions: { input: { index: resolve("src/main/index.ts") } } },
	},
	preload: {
		plugins: [externalizeDepsPlugin({ exclude: ["zod"] })],
		build: {
			outDir: "out/preload",
			rollupOptions: { input: { index: resolve("src/preload/index.ts") }, output: { format: "cjs", entryFileNames: "[name].cjs" } },
		},
	},
	renderer: {
		root: resolve("src/renderer"),
		plugins: [react()],
		resolve: {
			alias: [
				{ find: "@shared", replacement: resolve("src/shared") },
				// Monaco inclui uma cópia própria: use a versão corrigida também no bundle.
				{
					find: /^(?:.*\/)?dompurify\/dompurify\.js$/,
					replacement: resolve("node_modules/dompurify/dist/purify.es.mjs"),
				},
			],
		},
		server: { host: "127.0.0.1" },
		build: { outDir: resolve("out/renderer"), rollupOptions: { input: { index: resolve("src/renderer/index.html") } } },
	},
});
