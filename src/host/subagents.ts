/**
 * Registro de subagentes/runners.
 *
 * - Une snapshots RPC, frames de lifecycle/progress/event e resultados `task`
 *   persistidos no transcript do pai por id (fallback sessionFile ou
 *   parentToolCallId+index).
 * - Mantém cards finalizados (o OMP poda snapshots terminais).
 * - Transcript: usa `get_subagent_messages` enquanto o processo conhece o
 *   filho; depois lê somente `<artifactsDir-do-pai>/<id>.jsonl` com
 *   `readRpcSubagentTranscript`, após realpath confinado. O renderer manda
 *   apenas `subagentId` — nunca um caminho.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { AgentRow } from "../shared/session-types";
import { isRecord } from "../shared/session-state";
import type { OmpTransport } from "./omp-transport";
import { sanitizeFrame } from "./sanitize";

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function configuredModelOf(progress: Record<string, unknown> | undefined): string | undefined {
	if (!progress) return undefined;
	const override = progress.modelOverride;
	if (typeof override === "string") return override;
	if (Array.isArray(override)) {
		const values = override.filter((item): item is string => typeof item === "string");
		return values.length > 0 ? values.join(", ") : undefined;
	}
	return stringValue(progress.modelRole);
}

function statusOf(value: unknown): AgentRow["status"] {
	switch (value) {
		case "started":
		case "running":
		case "pending":
			return value === "started" ? "running" : value;
		case "completed":
		case "failed":
		case "aborted":
			return value;
		default:
			return "unknown";
	}
}

export function agentRowFromSnapshot(raw: unknown): AgentRow | null {
	if (!isRecord(raw)) return null;
	const id = stringValue(raw.id);
	if (!id) return null;
	const progress = isRecord(raw.progress) ? raw.progress : undefined;
	const status = statusOf(raw.status ?? progress?.status);
	const sessionFile = stringValue(raw.sessionFile) ?? stringValue(progress?.sessionFile);
	return {
		key: `id:${id}`,
		id,
		index: numberValue(raw.index) ?? numberValue(progress?.index),
		agent: stringValue(raw.agent) ?? stringValue(progress?.agent) ?? "agente",
		description: stringValue(raw.description) ?? stringValue(progress?.description),
		task: stringValue(raw.task) ?? stringValue(progress?.task),
		status,
		sessionFile,
		parentToolCallId: stringValue(raw.parentToolCallId),
		effectiveModel: stringValue(progress?.resolvedModel),
		configuredModel: configuredModelOf(progress),
		lastUpdate: numberValue(raw.lastUpdate) ?? Date.now(),
		finalized: status === "completed" || status === "failed" || status === "aborted",
	};
}

/** Resultados `task` persistidos no transcript do pai (funciona após reiniciar o app). */
export function finalizedAgentsFromMessages(messages: readonly unknown[]): AgentRow[] {
	const resultsByCall = new Map<string, { details: Record<string, unknown>; timestamp?: number }>();
	for (const raw of messages) {
		if (!isRecord(raw) || raw.role !== "toolResult") continue;
		const toolCallId = stringValue(raw.toolCallId);
		if (!toolCallId) continue;
		const details = isRecord(raw.details) ? raw.details : undefined;
		if (!details) continue;
		resultsByCall.set(toolCallId, { details, timestamp: numberValue(raw.timestamp) });
	}
	const jobOutcomes = new Map<string, Record<string, unknown>>();
	for (const { details } of resultsByCall.values()) {
		if (!Array.isArray(details.jobs)) continue;
		for (const job of details.jobs) {
			if (isRecord(job) && typeof job.id === "string") jobOutcomes.set(job.id, job);
		}
	}
	const agents: AgentRow[] = [];
	for (const raw of messages) {
		if (!isRecord(raw) || raw.role !== "assistant" || !Array.isArray(raw.content)) continue;
		for (const block of raw.content) {
			if (!isRecord(block) || block.type !== "toolCall" || block.name !== "task") continue;
			const callId = stringValue(block.id);
			if (!callId) continue;
			const result = resultsByCall.get(callId);
			if (!result) continue;
			const results = Array.isArray(result.details.results) ? result.details.results : [];
			const progressList = Array.isArray(result.details.progress) ? result.details.progress : [];
			const knownIds = new Set(
				results.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : [])),
			);
			// Execução assíncrona: o resultado de task traz só o progresso inicial; o desfecho vem em `wait`.
			for (const progress of progressList) {
				if (!isRecord(progress)) continue;
				const id = stringValue(progress.id);
				if (!id || knownIds.has(id)) continue;
				const job = jobOutcomes.get(id);
				const jobStatus = stringValue(job?.status);
				const status: AgentRow["status"] =
					jobStatus === "completed"
						? "completed"
						: jobStatus === "failed"
							? "failed"
							: jobStatus === "cancelled" || jobStatus === "aborted"
								? "aborted"
								: "unknown";
				agents.push({
					key: `id:${id}`,
					id,
					index: numberValue(progress.index),
					agent: stringValue(progress.agent) ?? "agente",
					description: stringValue(progress.description),
					task: stringValue(progress.task),
					status,
					sessionFile: stringValue(progress.sessionFile),
					parentToolCallId: callId,
					effectiveModel: stringValue(job?.resolvedModel) ?? stringValue(progress.resolvedModel),
					configuredModel: configuredModelOf(progress),
					lastUpdate: result.timestamp,
					finalized: true,
				});
			}
			for (const item of results) {
				if (!isRecord(item)) continue;
				const id = stringValue(item.id);
				if (!id) continue;
				const progress = progressList.find(
					(candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.id === id,
				);
				const exitCode = numberValue(item.exitCode);
				const aborted = item.aborted === true;
				const failed = !aborted && (item.error !== undefined || (exitCode !== undefined && exitCode !== 0));
				const status: AgentRow["status"] = aborted ? "aborted" : failed ? "failed" : "completed";
				agents.push({
					key: `id:${id}`,
					id,
					index: numberValue(item.index) ?? numberValue(progress?.index),
					agent: stringValue(item.agent) ?? stringValue(progress?.agent) ?? "agente",
					description: stringValue(item.description) ?? stringValue(progress?.description),
					task: stringValue(item.task) ?? stringValue(progress?.task),
					status,
					sessionFile: stringValue(progress?.sessionFile),
					parentToolCallId: callId,
					effectiveModel: stringValue(item.resolvedModel) ?? stringValue(progress?.resolvedModel),
					configuredModel:
						configuredModelOf(progress) ??
						(typeof item.modelOverride === "string" ? item.modelOverride : stringValue(item.modelRole)),
					lastUpdate: result.timestamp,
					finalized: true,
				});
			}
		}
	}
	return agents;
}

function sameAgent(left: AgentRow, right: AgentRow): boolean {
	if (left.key === right.key) return true;
	if (left.id && right.id) return left.id === right.id;
	if (left.sessionFile && right.sessionFile) return left.sessionFile === right.sessionFile;
	return (
		left.parentToolCallId !== undefined &&
		left.parentToolCallId === right.parentToolCallId &&
		left.index === right.index
	);
}

/** Une finalizados persistidos, finalizados vivos e snapshots vivos, sem duplicar linhas. */
export function mergeAgentRows(
	finalized: readonly AgentRow[],
	live: readonly AgentRow[],
	existing: readonly AgentRow[] = [],
): AgentRow[] {
	const rows: AgentRow[] = [];
	const put = (row: AgentRow) => {
		const index = rows.findIndex((candidate) => sameAgent(candidate, row));
		if (index >= 0) {
			const previous = rows[index];
			rows[index] = {
				...previous,
				...row,
				key: previous.key,
				effectiveModel: row.effectiveModel ?? previous.effectiveModel,
				configuredModel: row.configuredModel ?? previous.configuredModel,
				finalized: row.finalized || previous.finalized,
			};
			return;
		}
		rows.push(row);
	};
	for (const row of existing) if (row.finalized) put(row);
	for (const row of finalized) put(row);
	for (const row of live) put(row);
	return rows.sort((a, b) => (a.index ?? 9999) - (b.index ?? 9999));
}

function isInside(parent: string, child: string): boolean {
	const parentResolved = path.resolve(parent);
	const childResolved = path.resolve(child);
	const prefix = parentResolved.endsWith(path.sep) ? parentResolved : `${parentResolved}${path.sep}`;
	return childResolved === parentResolved || childResolved.startsWith(prefix);
}

export interface SubagentTranscript {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	messages: unknown[];
}

export interface TranscriptContext {
	transport?: OmpTransport;
	parentSessionFile?: string;
	agents: readonly AgentRow[];
}

export class SubagentTranscriptError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SubagentTranscriptError";
	}
}

/**
 * Lê o transcript do filho. Sempre pelo id; qualquer caminho é derivado e
 * validado dentro dos artefatos da sessão pai.
 */
export async function readSubagentTranscript(
	context: TranscriptContext,
	subagentId: string,
	fromByte = 0,
): Promise<SubagentTranscript> {
	if (context.transport) {
		try {
			const response = await context.transport.request({
				type: "get_subagent_messages",
				subagentId,
				fromByte,
			});
			if (response.success === true && "data" in response) {
				const data: unknown = response.data;
				if (isRecord(data)) {
					const messages = Array.isArray(data.messages) ? data.messages : [];
					return {
						sessionFile: stringValue(data.sessionFile) ?? "",
						fromByte: numberValue(data.fromByte) ?? fromByte,
						nextByte: numberValue(data.nextByte) ?? fromByte,
						reset: data.reset === true,
						messages: sanitizeFrame(messages),
					};
				}
			}
		} catch {
			/* processo pode não conhecer mais o filho: cai para o arquivo */
		}
	}
	const known = context.agents.find((agent) => agent.id === subagentId || agent.key === `id:${subagentId}`);
	const parent = context.parentSessionFile;
	if (!parent || !parent.toLowerCase().endsWith(".jsonl")) {
		throw new SubagentTranscriptError(
			"UNKNOWN_SESSION",
			"O transcript deste agente não está mais disponível nesta sessão.",
		);
	}
	const artifactsDir = parent.slice(0, -".jsonl".length);
	const candidate = path.join(artifactsDir, `${subagentId}.jsonl`);
	if (!/^[A-Za-z0-9._-]+$/.test(subagentId) || subagentId.includes("..") || !isInside(artifactsDir, candidate)) {
		throw new SubagentTranscriptError("FORBIDDEN_PATH", "O identificador do agente não é válido.");
	}
	let realParent = artifactsDir;
	let realCandidate = candidate;
	try {
		realParent = await fs.promises.realpath(artifactsDir);
		realCandidate = await fs.promises.realpath(candidate);
	} catch {
		if (!known) {
			throw new SubagentTranscriptError(
				"UNKNOWN_SESSION",
				"O transcript deste agente não está mais disponível nesta sessão.",
			);
		}
	}
	if (!isInside(realParent, realCandidate)) {
		throw new SubagentTranscriptError(
			"FORBIDDEN_PATH",
			"O transcript do agente não está dentro dos artefatos da sessão pai.",
		);
	}
	try {
		const stat = await fs.promises.stat(realCandidate);
		if (!stat.isFile()) throw new Error("não é arquivo");
	} catch {
		throw new SubagentTranscriptError(
			"UNKNOWN_SESSION",
			"O transcript deste agente não foi encontrado nos artefatos da sessão.",
		);
	}
	const result = await readRpcSubagentTranscript(realCandidate, fromByte);
	return {
		sessionFile: result.sessionFile,
		fromByte: result.fromByte,
		nextByte: result.nextByte,
		reset: result.reset,
		messages: sanitizeFrame(result.messages),
	};
}
