// Gera resources/icon.ico (16 a 256 px) a partir de resources/brand/omp-logo.svg.
// Uso: bun scripts/build-icon.ts .
import sharp from "sharp";
import { readFileSync, writeFileSync } from "node:fs";
const root = process.argv[2];
const svg = readFileSync(`${root}/resources/brand/omp-logo.svg`);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = await Promise.all(sizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()));
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length; const dir: Buffer[] = [];
sizes.forEach((s, i) => { const e = Buffer.alloc(16); e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length; dir.push(e); });
writeFileSync(`${root}/resources/icon.ico`, Buffer.concat([header, ...dir, ...pngs]));
writeFileSync(`${root}/resources/brand/omp-logo-256.png`, pngs[6]);
writeFileSync(`${root}/resources/brand/omp-logo-32.png`, pngs[2]);
console.log("ok", offset);
