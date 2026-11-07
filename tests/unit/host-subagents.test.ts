import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { finalizedAgentsFromMessages, readSubagentTranscript, SubagentTranscriptError } from "../../src/host/subagents";
import type { AgentRow } from "../../src/shared/session-types";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-subagent-"));
	tempDirs.push(dir);
	return dir;
}

function childEntry(text: string): string {
	return `${JSON.stringify({
		type: "message",
		id: "child-e1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			provider: "fake",
			model: "runner-model",
			timestamp: 1,
		},
	})}\n`;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe("subagent transcript", () => {
	test("lê o filho finalizado do disco após reiniciar, dentro dos artefatos do pai", async () => {
		const dir = await tempDir();
		const parentSessionFile = path.join(dir, "parent.jsonl");
		const artifacts = path.join(dir, "parent");
		await fs.promises.mkdir(artifacts, { recursive: true });
		await fs.promises.writeFile(parentSessionFile, "", "utf8");
		await fs.promises.writeFile(path.join(artifacts, "sub-1.jsonl"), childEntry("child persisted"), "utf8");
		const agents: AgentRow[] = [
			{
				key: "id:sub-1",
				id: "sub-1",
				agent: "runner",
				status: "completed",
				effectiveModel: "fake/runner-model:max",
				finalized: true,
			},
		];
		const result = await readSubagentTranscript({ parentSessionFile, agents }, "sub-1", 0);
		expect(result.sessionFile).toContain("sub-1.jsonl");
		const messages = result.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("assistant");
		expect(messages[0].content[0].text).toBe("child persisted");
		expect(result.nextByte).toBeGreaterThan(0);
	});

	test("referência fora dos artefatos do pai é recusada", async () => {
		const dir = await tempDir();
		const parentSessionFile = path.join(dir, "parent.jsonl");
		await fs.promises.writeFile(parentSessionFile, "", "utf8");
		let failure: unknown;
		try {
			await readSubagentTranscript({ parentSessionFile, agents: [] }, "../escape", 0);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SubagentTranscriptError);
		expect((failure as SubagentTranscriptError).code).toBe("FORBIDDEN_PATH");
	});

	test("filho sem arquivo nem registro vivo devolve UNKNOWN_SESSION", async () => {
		const dir = await tempDir();
		const parentSessionFile = path.join(dir, "parent.jsonl");
		await fs.promises.mkdir(path.join(dir, "parent"), { recursive: true });
		await fs.promises.writeFile(parentSessionFile, "", "utf8");
		let failure: unknown;
		try {
			await readSubagentTranscript({ parentSessionFile, agents: [] }, "sub-x", 0);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SubagentTranscriptError);
		expect((failure as SubagentTranscriptError).code).toBe("UNKNOWN_SESSION");
	});
});

describe("agentes finalizados de task assíncrono", () => {
	test("reconstrói o desfecho e o modelo efetivo a partir do resultado de wait", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "task", arguments: {} }] },
			{
				role: "toolResult",
				toolCallId: "call-1",
				timestamp: 10,
				details: { results: [], progress: [{ id: "Runner", index: 0, agent: "task", modelRole: "runner", status: "pending", task: "criar arquivo" }] },
			},
			{
				role: "toolResult",
				toolCallId: "call-2",
				details: { jobs: [{ id: "Runner", status: "completed", resolvedModel: "provedor/modelo-runner:max" }] },
			},
		];
		const [row] = finalizedAgentsFromMessages(messages);
		expect(row.id).toBe("Runner");
		expect(row.status).toBe("completed");
		expect(row.effectiveModel).toBe("provedor/modelo-runner:max");
		expect(row.finalized).toBe(true);
	});

	test("sem desfecho persistido o estado fica desconhecido e o modelo não é inventado", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "task", arguments: {} }] },
			{ role: "toolResult", toolCallId: "call-1", details: { results: [], progress: [{ id: "Runner", index: 0, agent: "task", status: "pending" }] } },
		];
		const [row] = finalizedAgentsFromMessages(messages);
		expect(row.status).toBe("unknown");
		expect(row.effectiveModel).toBeUndefined();
	});
});
