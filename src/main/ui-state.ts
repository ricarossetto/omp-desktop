/**
 * Estado visual do aplicativo (layout, tema, splitters) em userData.
 * Escrita atômica; nenhum dado do projeto é gravado aqui.
 */
import { readJsonFile, writeJsonAtomic, isSerializableState } from "./json-store";

const STATE_VERSION = 1;

interface UiStateFile {
	version: number;
	state: Record<string, unknown>;
}

export class UiStateStore {
	private readonly file: string;
	private state: Record<string, unknown> = {};
	private loaded = false;

	constructor(file: string) {
		this.file = file;
	}

	async load(): Promise<Record<string, unknown>> {
		const parsed = await readJsonFile<UiStateFile>(this.file, { version: STATE_VERSION, state: {} });
		if (parsed && typeof parsed === "object" && typeof parsed.state === "object" && parsed.state !== null) {
			this.state = parsed.state;
		}
		this.loaded = true;
		return this.state;
	}

	getState(): Record<string, unknown> {
		return this.state;
	}

	async setState(state: unknown): Promise<Record<string, unknown>> {
		if (!isSerializableState(state)) {
			throw new Error("O estado visual precisa ser um objeto JSON de até 1 MiB.");
		}
		this.state = state;
		await writeJsonAtomic(this.file, { version: STATE_VERSION, state: this.state });
		this.loaded = true;
		return this.state;
	}

	get isLoaded(): boolean {
		return this.loaded;
	}
}
