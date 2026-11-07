export {};
// Gera out/host/index.js para rodar com Bun. Pacotes OMP ficam externos.
const result = await Bun.build({
	entrypoints: ["src/host/index.ts"],
	outdir: "out/host",
	target: "bun",
	format: "esm",
	external: ["@oh-my-pi/*", "zod"],
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log("host ok");
