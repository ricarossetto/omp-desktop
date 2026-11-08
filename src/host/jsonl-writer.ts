/**
 * Escritor JSONL do host.
 *
 * Mensagens pequenas continuam em uma única linha, como no protocolo original.
 * Mensagens acima de `HOST_CHUNK_PAYLOAD_BYTES` são divididas em frames
 * `kind:"chunk"` contíguos. Cada frame é escrito antes do próximo (backpressure
 * do stdout), então os fragmentos de uma mensagem nunca se intercalam com os de
 * outra. O cliente remonta os bytes UTF-8 antes de decodificar o JSON.
 */
import {
	HOST_CHUNK_KIND,
	HOST_CHUNK_PAYLOAD_BYTES,
	type HostChunkEventMeta,
	type HostChunkFrame,
} from "../shared/host-wire";

export type HostStdoutWrite = (text: string) => number | Promise<number>;

function writeToStdout(text: string): number | Promise<number> {
	return Bun.stdout.write(text);
}

function reportToStderr(message: string): void {
	process.stderr.write(`host: ${message}\n`);
}

function responseIdOf(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as Record<string, unknown>;
	return record.kind === "response" && typeof record.id === "string" && record.id.length > 0
		? record.id
		: undefined;
}

function eventMetaOf(message: unknown): HostChunkEventMeta | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as Record<string, unknown>;
	if (record.kind !== "event") return undefined;
	const workspaceId = record.workspaceId;
	const sessionId = record.sessionId;
	const generation = record.generation;
	const sequence = record.sequence;
	const name = record.name;
	if (typeof workspaceId !== "string" || workspaceId.length === 0) return undefined;
	if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length === 0)) return undefined;
	if (typeof generation !== "number" || !Number.isFinite(generation)) return undefined;
	if (typeof sequence !== "number" || !Number.isFinite(sequence)) return undefined;
	if (typeof name !== "string" || name.length === 0) return undefined;
	return {
		workspaceId,
		...(sessionId !== undefined ? { sessionId } : {}),
		generation,
		sequence,
		name,
	};
}

export class JsonlWriter {
	private chain: Promise<void> = Promise.resolve();
	private failed = false;
	private chunkCounter = 0;
	private readonly writeStdout: HostStdoutWrite;
	private readonly reportError: (message: string) => void;

	constructor(
		writeStdout: HostStdoutWrite = writeToStdout,
		reportError: (message: string) => void = reportToStderr,
	) {
		this.writeStdout = writeStdout;
		this.reportError = reportError;
	}

	write(message: unknown): void {
		if (this.failed) return;
		let serialized: string;
		try {
			serialized = JSON.stringify(message) ?? "undefined";
		} catch (error) {
			this.failed = true;
			this.reportError(`falha ao serializar mensagem: ${(error as Error).message}`);
			return;
		}
		// 3 bytes é o máximo UTF-8 por unidade UTF-16; abaixo disso a mensagem
		// cabe em uma linha sem precisar codificar o buffer inteiro.
		if (serialized.length * 3 <= HOST_CHUNK_PAYLOAD_BYTES) {
			this.enqueue(async () => {
				await this.writeLine(`${serialized}\n`);
			});
			return;
		}
		const bytes = Buffer.from(serialized, "utf8");
		if (bytes.byteLength <= HOST_CHUNK_PAYLOAD_BYTES) {
			this.enqueue(async () => {
				await this.writeLine(`${serialized}\n`);
			});
			return;
		}
		const id = `c${++this.chunkCounter}`;
		const responseId = responseIdOf(message);
		const event = eventMetaOf(message);
		this.enqueue(async () => {
			const count = Math.ceil(bytes.byteLength / HOST_CHUNK_PAYLOAD_BYTES);
			for (let index = 0; index < count; index++) {
				if (this.failed) return;
				const start = index * HOST_CHUNK_PAYLOAD_BYTES;
				const end = Math.min(start + HOST_CHUNK_PAYLOAD_BYTES, bytes.byteLength);
				const frame: HostChunkFrame = {
					kind: HOST_CHUNK_KIND,
					id,
					index,
					count,
					bytes: bytes.byteLength,
					...(responseId ? { responseId } : {}),
					...(event ? { event } : {}),
					data: bytes.subarray(start, end).toString("base64"),
				};
				await this.writeLine(`${JSON.stringify(frame)}\n`);
			}
		});
	}

	private enqueue(task: () => Promise<void>): void {
		this.chain = this.chain.then(async () => {
			if (this.failed) return;
			try {
				await task();
			} catch (error) {
				this.failed = true;
				this.reportError(`falha ao escrever no stdout: ${(error as Error).message}`);
			}
		});
	}

	private async writeLine(line: string): Promise<void> {
		try {
			const result = this.writeStdout(line);
			if (typeof result !== "number") await result;
		} catch (error) {
			this.failed = true;
			this.reportError(`stdout fechado: ${(error as Error).message}`);
		}
	}

	async flush(): Promise<void> {
		await this.chain;
	}
}
