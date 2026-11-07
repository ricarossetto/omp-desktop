import type { DesktopEvent, DesktopRequest, HostErrorBody } from "@shared/contracts";

export class DesktopError extends Error {
	constructor(public readonly body: HostErrorBody) {
		super(body.message);
		this.name = "DesktopError";
	}
}

/** Chama o main; devolve `data` ou lança DesktopError com código e mensagem em português. */
export async function invoke<T = unknown>(request: DesktopRequest): Promise<T> {
	const result = await window.ompDesktop.invoke(request);
	if (!result.ok) throw new DesktopError(result.error);
	return result.data as T;
}

export function subscribe(listener: (event: DesktopEvent) => void): () => void {
	return window.ompDesktop.subscribe(listener);
}
