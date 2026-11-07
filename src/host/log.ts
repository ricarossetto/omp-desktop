/**
 * Log operacional do host: arquivo local com rotação e redação.
 *
 * Nunca registra prompts, respostas, credenciais, cabeçalhos ou payloads de
 * provider. Campos passam por redação e truncamento antes de serializar.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SECRET_KEY = /(token|secret|password|passwd|credential|api[_-]?key|authorization|cookie|bearer)/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/;

function redactValue(value: unknown, depth = 0): unknown {
	if (depth > 4) return "[limite]";
	if (typeof value === "string") {
		if (SECRET_VALUE.test(value)) return "[redigido]";
		return value.length > 300 ? `${value.slice(0, 300)}…` : value;
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item, depth + 1));
	if (typeof value === "object" && value !== undefined) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = SECRET_KEY.test(key) ? "[redigido]" : redactValue(item, depth + 1);
		}
		return out;
	}
	return undefined;
}

export type LogLevel = "info" | "warn" | "error";

export class HostLogger {
	private readonly file: string;
	private readonly maxBytes: number;
	private failed = false;

	constructor(dataDir: string, maxBytes = 2 * 1024 * 1024) {
		this.file = path.join(dataDir, "logs", "host.log");
		this.maxBytes = maxBytes;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
		} catch {
			this.failed = true;
		}
	}

	info(event: string, fields?: Record<string, unknown>): void {
		this.write("info", event, fields);
	}

	warn(event: string, fields?: Record<string, unknown>): void {
		this.write("warn", event, fields);
	}

	error(event: string, fields?: Record<string, unknown>): void {
		this.write("error", event, fields);
	}

	private write(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
		if (this.failed) return;
		try {
			const stat = fs.statSync(this.file, { throwIfNoEntry: false });
			if (stat && stat.size > this.maxBytes) {
				fs.renameSync(this.file, `${this.file}.1`);
			}
		} catch {
			/* ausência ou arquivo travado: segue anexando */
		}
		try {
			const line = JSON.stringify({
				at: new Date().toISOString(),
				level,
				event,
				...(fields ? { fields: redactValue(fields) } : {}),
			});
			fs.appendFileSync(this.file, `${line}\n`, "utf8");
		} catch {
			this.failed = true;
		}
	}
}

export interface AtomicWriteOptions {
	encoding?: "utf8";
}

/** Escrita atômica: arquivo temporário na mesma pasta + rename. */
export async function writeFileAtomic(
	filePath: string,
	content: string,
	_options: AtomicWriteOptions = {},
): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.promises.mkdir(dir, { recursive: true });
	const temp = path.join(
		dir,
		`.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
	);
	await fs.promises.writeFile(temp, content, "utf8");
	await fs.promises.rename(temp, filePath);
}
