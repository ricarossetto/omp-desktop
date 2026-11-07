/**
 * Leitura/escrita de JSON com gravação atômica em userData.
 * Sem import de Electron para permitir testes.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
	try {
		const raw = await readFile(file, "utf8");
		const parsed: unknown = JSON.parse(raw);
		return parsed as T;
	} catch {
		return fallback;
	}
}

/**
 * Grava primeiro em um temporário no mesmo diretório e renomeia; no Windows
 * `rename` substitui o destino existente. Um crash não deixa JSON meio escrito.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	const dir = path.dirname(file);
	await mkdir(dir, { recursive: true });
	const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	const payload = `${JSON.stringify(value, null, 2)}\n`;
	try {
		await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
		await rename(temp, file);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}

/** JSON válido e plano o suficiente para layout/tema; limite de 1 MiB. */
export function isSerializableState(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const encoded = JSON.stringify(value);
		return typeof encoded === "string" && encoded.length <= 1_048_576;
	} catch {
		return false;
	}
}
