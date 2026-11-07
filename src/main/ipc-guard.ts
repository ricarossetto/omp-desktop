/**
 * Validação do remetente de IPC. Somente o main frame da janela autorizada
 * pode invocar `omp:invoke`; iframes, WebViews e origens externas são recusados.
 *
 * Tipos estruturais para poder testar sem Electron.
 */
import { pathToFileURL } from "node:url";
import * as path from "node:path";

export interface FrameLike {
	url: string;
	parent?: FrameLike | null;
	processId?: number;
	routingId?: number;
	frameTreeNodeId?: number;
}

export interface SenderLike {
	id: number;
	mainFrame: FrameLike;
}

export interface IpcInvokeEventLike {
	sender: SenderLike;
	senderFrame: FrameLike | null;
}

export interface AuthorizedWindow {
	webContentsId: number;
	mainFrame: FrameLike;
	/** URL `file://` do index.html de produção. */
	productionFileUrl?: string;
	/** URL de desenvolvimento permitida (somente loopback 127.0.0.1). */
	devUrl?: string;
}

function normalizeFileUrl(value: string): string | undefined {
	try {
		const url = new URL(value);
		if (url.protocol !== "file:") return undefined;
		return decodeURIComponent(url.pathname).replace(/\\/g, "/").toLowerCase();
	} catch {
		return undefined;
	}
}

/** Aceita exatamente o index de produção ou a URL dev em loopback. */
export function isAllowedRendererUrl(rawUrl: string, authorized: AuthorizedWindow): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (authorized.devUrl) {
		let dev: URL;
		try {
			dev = new URL(authorized.devUrl);
		} catch {
			return false;
		}
		const loopback = dev.hostname === "127.0.0.1" || dev.hostname === "[::1]";
		if (loopback && url.protocol === "http:" && url.host === dev.host) return true;
	}
	if (authorized.productionFileUrl && url.protocol === "file:") {
		const expected = normalizeFileUrl(authorized.productionFileUrl);
		const actual = normalizeFileUrl(url.toString());
		if (expected && actual === expected) return true;
	}
	return false;
}

function sameFrame(a: FrameLike, b: FrameLike): boolean {
	if (a === b) return true;
	if (a.processId !== undefined && a.routingId !== undefined) {
		return a.processId === b.processId && a.routingId === b.routingId;
	}
	return false;
}

/** Função pura usada pelo handler IPC; nunca confia em `event.sender` sozinho. */
export function isAuthorizedSender(event: IpcInvokeEventLike, authorized: AuthorizedWindow): boolean {
	if (!event.senderFrame) return false;
	if (event.sender.id !== authorized.webContentsId) return false;
	if (!sameFrame(event.senderFrame, authorized.mainFrame)) return false;
	if (event.senderFrame.parent) return false;
	return isAllowedRendererUrl(event.senderFrame.url, authorized);
}

/** Produção: `file://` do index empacotado. */
export function rendererFileUrl(rendererIndexPath: string): string {
	return pathToFileURL(path.resolve(rendererIndexPath)).toString();
}

/** Dev: aceita somente http://127.0.0.1[:porta]; qualquer outro host é recusado. */
export function validateDevRendererUrl(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:") return undefined;
		if (url.hostname !== "127.0.0.1") return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}
