// Gera os ícones do aplicativo a partir de resources/brand/omp-logo.svg.
//
// Uso:
//   bun scripts/build-icon.ts [root]            # Windows (.ico) + Linux (PNG)
//   bun scripts/build-icon.ts [root] --linux    # somente recursos Linux
//
// `--linux` evita reescrever resources/icon.ico e resources/brand/*.png quando
// apenas o conjunto freedesktop (resources/icons e resources/icon.png) mudou.
import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const linuxOnly = args.includes("--linux");
const root = args.find((arg) => !arg.startsWith("--")) ?? ".";
const svg = readFileSync(`${root}/resources/brand/omp-logo.svg`);

if (!linuxOnly) {
	const sizes = [16, 24, 32, 48, 64, 128, 256];
	const pngs = await Promise.all(
		sizes.map((size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()),
	);
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(sizes.length, 4);
	let offset = 6 + 16 * sizes.length;
	const dir: Buffer[] = [];
	sizes.forEach((size, index) => {
		const entry = Buffer.alloc(16);
		entry[0] = size >= 256 ? 0 : size;
		entry[1] = size >= 256 ? 0 : size;
		entry.writeUInt16LE(1, 4);
		entry.writeUInt16LE(32, 6);
		entry.writeUInt32LE(pngs[index].length, 8);
		entry.writeUInt32LE(offset, 12);
		offset += pngs[index].length;
		dir.push(entry);
	});
	writeFileSync(`${root}/resources/icon.ico`, Buffer.concat([header, ...dir, ...pngs]));
	writeFileSync(`${root}/resources/brand/omp-logo-256.png`, pngs[6]);
	writeFileSync(`${root}/resources/brand/omp-logo-32.png`, pngs[2]);
}

// Conjunto freedesktop usado pelo .deb e pelo PKGBUILD do Arch. O nome
// `<size>x<size>.png` é o esperado pelo resolvedor de ícones do electron-builder.
const linuxSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const linuxPngs = await Promise.all(
	linuxSizes.map((size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()),
);
mkdirSync(`${root}/resources/icons`, { recursive: true });
linuxSizes.forEach((size, index) => {
	writeFileSync(`${root}/resources/icons/${size}x${size}.png`, linuxPngs[index]);
});
// Fallback para ferramentas que procuram resources/icon.png.
writeFileSync(`${root}/resources/icon.png`, linuxPngs[linuxSizes.indexOf(512)]);
console.log(`ok ${linuxSizes.join(",")}`);
