/**
 * Relógio de eventos por sessão e evento sintético de sessão indisponível.
 *
 * O main precisa avisar a UI quando o host encerra: um `session.status` com
 * status terminal (closed/error) faz o reducer limpar diálogos pendentes. Para
 * o evento não ser descartado como fora de ordem, a sequência sintética precisa
 * ser maior que a última observada e a geração precisa ser a do processo atual.
 */
import type { DesktopEvent } from "../shared/contracts";
import type { OpenSessionRecord } from "./registries";

export interface SessionClock {
	generation: number;
	sequence: number;
}

/** Última geração/sequência vista por sessão, atualizada por eventos e snapshots. */
export class SessionEventClock {
	private readonly bySession = new Map<string, SessionClock>();

	observe(sessionId: string, generation: number, sequence: number): void {
		if (sessionId.length === 0) return;
		if (!Number.isFinite(generation) || !Number.isFinite(sequence)) return;
		const current = this.bySession.get(sessionId);
		if (!current || generation !== current.generation || sequence > current.sequence) {
			this.bySession.set(sessionId, { generation, sequence });
		}
	}

	/** Próxima sequência da sessão (incrementa o estado guardado). */
	next(sessionId: string): SessionClock {
		const current = this.bySession.get(sessionId) ?? { generation: 0, sequence: 0 };
		const clock = { generation: current.generation, sequence: current.sequence + 1 };
		this.bySession.set(sessionId, clock);
		return clock;
	}

	clear(): void {
		this.bySession.clear();
	}
}

/** Extrai geração/sequência de um snapshot devolvido pelo host. */
export function readSnapshotClock(value: unknown): SessionClock | undefined {
	if (typeof value !== "object" || value === null || !("state" in value)) return undefined;
	const { state } = value;
	if (typeof state !== "object" || state === null) return undefined;
	if (!("generation" in state) || !("sequence" in state)) return undefined;
	const { generation, sequence } = state;
	if (typeof generation !== "number" || typeof sequence !== "number") return undefined;
	if (!Number.isFinite(generation) || !Number.isFinite(sequence)) return undefined;
	return { generation, sequence };
}

/** Monta o `session.status` sintético que encerra diálogos/estado vivo da sessão. */
export function buildSessionUnavailableEvent(
	record: OpenSessionRecord,
	clock: SessionClock,
	status: "closed" | "error",
	message: string,
): DesktopEvent {
	return {
		kind: "event",
		workspaceId: record.workspaceId,
		sessionId: record.sessionId,
		generation: clock.generation,
		sequence: clock.sequence,
		name: "session.status",
		data: { status, error: message },
	};
}
