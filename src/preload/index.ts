import { contextBridge, ipcRenderer } from "electron";
import type { DesktopEvent, DesktopRequest, OmpDesktopApi } from "../shared/contracts";

const api: OmpDesktopApi = {
	invoke: (request: DesktopRequest) => ipcRenderer.invoke("omp:invoke", request),
	subscribe(listener) {
		const handler = (_e: unknown, event: DesktopEvent) => listener(event);
		ipcRenderer.on("omp:event", handler);
		return () => ipcRenderer.removeListener("omp:event", handler);
	},
};
contextBridge.exposeInMainWorld("ompDesktop", api);
