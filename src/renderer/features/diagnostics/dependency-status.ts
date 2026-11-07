import type { DependencyRuntimeSnapshot, DependencyRuntimeState } from "@shared/contracts";
import {
	DEPENDENCY_ERROR_CODES,
	type DependencyInstallPhase,
	type DependencyKind,
} from "@shared/dependency-install-types";
import { isRecord } from "../agents/ui-utils";

const PHASES: Record<DependencyInstallPhase, true> = {
	resolving: true,
	downloading: true,
	verifying: true,
	extracting: true,
	activating: true,
};

function asState(kind: DependencyKind, raw: unknown): DependencyRuntimeState | undefined {
	if (!isRecord(raw) || raw.kind !== kind || typeof raw.state !== "string") return undefined;
	if (raw.state === "installed") {
		if (typeof raw.executablePath !== "string" || typeof raw.version !== "string") return undefined;
		return { state: "installed", kind, executablePath: raw.executablePath, version: raw.version };
	}
	if (raw.state === "missing") return { state: "missing", kind };
	if (raw.state === "error") {
		if (typeof raw.code !== "string") return undefined;
		return {
			state: "error",
			kind,
			code: raw.code as Extract<DependencyRuntimeState, { state: "error" }>["code"],
			message: typeof raw.message === "string" ? raw.message : "",
		};
	}
	if (raw.state === "installing") {
		if (typeof raw.phase !== "string" || !Object.hasOwn(PHASES, raw.phase)) return undefined;
		return {
			state: "installing",
			kind,
			phase: raw.phase as DependencyInstallPhase,
			receivedBytes: typeof raw.receivedBytes === "number" ? raw.receivedBytes : undefined,
			totalBytes: typeof raw.totalBytes === "number" ? raw.totalBytes : undefined,
		};
	}
	return undefined;
}

/**
 * Valida o snapshot vindo do main antes de renderizar. Um snapshot incompleto
 * é descartado por inteiro (nunca inventa o estado da outra ferramenta).
 */
export function asDependencySnapshot(raw: unknown): DependencyRuntimeSnapshot | undefined {
	if (!isRecord(raw)) return undefined;
	const git = asState("git", raw.git);
	const node = asState("node", raw.node);
	if (!git || !node) return undefined;
	return { git, node };
}
