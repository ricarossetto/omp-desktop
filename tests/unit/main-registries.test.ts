import { describe, expect, test } from "bun:test";
import { AttachmentRegistry, SessionRegistry, WorkspaceRegistry } from "../../src/main/registries";
import type { AttachmentDto, WorkspaceDto } from "../../src/shared/contracts";

const workspace: WorkspaceDto = {
	workspaceId: "ws-1",
	path: "C:\\Projetos\\Meu Projeto",
	name: "Meu Projeto",
	available: true,
	lastOpenedAt: 1,
};

const attachment: AttachmentDto = {
	attachmentId: "att-1",
	name: "imagem.png",
	mimeType: "image/png",
	size: 10,
	kind: "image",
};

describe("WorkspaceRegistry", () => {
	test("resolve por id e caminho sem diferenciar caixa", () => {
		const registry = new WorkspaceRegistry();
		registry.add(workspace);
		expect(registry.has("ws-1")).toBe(true);
		expect(registry.findByPath("c:\\projetos\\meu projeto")?.workspaceId).toBe("ws-1");
		registry.remove("ws-1");
		expect(registry.has("ws-1")).toBe(false);
	});
});

describe("SessionRegistry", () => {
	test("só autoriza abrir caminhos vindos da listagem", () => {
		const registry = new SessionRegistry();
		expect(registry.isPathAuthorized("ws-1", "C:\\sessoes\\a.jsonl")).toBe(false);
		registry.authorizePath("ws-1", "C:\\sessoes\\a.jsonl");
		expect(registry.isPathAuthorized("ws-1", "c:\\SESSOES\\A.JSONL")).toBe(true);
		registry.registerSession({ workspaceId: "ws-1", sessionId: "s1", sessionPath: "C:\\sessoes\\a.jsonl" });
		expect(registry.findByPath("c:\\sessoes\\a.jsonl")?.sessionId).toBe("s1");
		expect(registry.has("s1", "ws-1")).toBe(true);
		expect(registry.has("s1", "outro")).toBe(false);
		registry.unregister("s1");
		expect(registry.has("s1")).toBe(false);
		registry.clearAll();
		expect(registry.isPathAuthorized("ws-1", "C:\\sessoes\\a.jsonl")).toBe(false);
	});

	test("lista sessões abertas e limpa somente o workspace pedido", () => {
		const registry = new SessionRegistry();
		registry.registerSession({ workspaceId: "ws-1", sessionId: "s1", sessionPath: "C:\\a.jsonl" });
		registry.registerSession({ workspaceId: "ws-2", sessionId: "s2" });
		expect(registry.list().map((record) => record.sessionId).sort()).toEqual(["s1", "s2"]);
		registry.clearWorkspace("ws-1");
		expect(registry.list()).toEqual([{ workspaceId: "ws-2", sessionId: "s2" }]);
		expect(registry.isPathAuthorized("ws-1", "C:\\a.jsonl")).toBe(false);
	});
});

describe("AttachmentRegistry", () => {
	test("associa anexo ao workspace", () => {
		const registry = new AttachmentRegistry();
		registry.add("ws-1", attachment);
		expect(registry.belongsTo("att-1", "ws-1")).toBe(true);
		expect(registry.belongsTo("att-1", "ws-2")).toBe(false);
		expect(registry.workspaceOf("att-1")).toBe("ws-1");
		registry.remove("att-1");
		expect(registry.get("att-1")).toBeUndefined();
	});
});
