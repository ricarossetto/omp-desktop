import type { RuntimeStatus } from "@shared/contracts";
import {
	NATIVE_GIT_COMMANDS,
	type DependencyKind,
	type NativeGitDistro,
} from "@shared/dependency-install-types";

export type DesktopPlatform = "win32" | "linux" | "darwin";

/** Plataforma anunciada pelo main; status antigo/sem campo cai no Windows. */
export function runtimePlatform(runtime: RuntimeStatus | null | undefined): DesktopPlatform {
	const platform = runtime?.platform;
	return platform === "linux" || platform === "darwin" ? platform : "win32";
}

export interface ManualInstruction {
	/** Página oficial de download; nunca usada para instalar sozinha. */
	url: string;
	/** Comandos fixos por distribuição (somente Git no Linux). */
	commands: Array<{ distro: NativeGitDistro; command: string }>;
}

/**
 * Instruções manuais por plataforma. No Linux o Git é nativo e o aplicativo
 * nunca executa apt/pacman/sudo; a UI apenas mostra e copia o comando fixo.
 */
export function manualInstructions(
	platform: DesktopPlatform,
	kind: DependencyKind,
): ManualInstruction {
	if (kind === "git") {
		if (platform === "linux") {
			return {
				url: "https://git-scm.com/download/linux",
				commands: [
					{ distro: "debian", command: NATIVE_GIT_COMMANDS.debian },
					{ distro: "arch", command: NATIVE_GIT_COMMANDS.arch },
				],
			};
		}
		return { url: "https://git-scm.com/download/win", commands: [] };
	}
	return { url: "https://nodejs.org/en/download", commands: [] };
}
