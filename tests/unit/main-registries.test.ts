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
	test("resolve por id e caminho respeitando a plataforma", () => {
		const registry = new WorkspaceRegistry();
		const dto =
			process.platform === "win32"
				? workspace
				: { ...workspace, path: "/projetos/Meu Projeto" };
		registry.add(dto);
		expect(registry.has("ws-1")).toBe(true);
		if (process.platform === "win32") {
			expect(registry.findByPath("c:\\projetos\\meu projeto")?.workspaceId).toBe("ws-1");
		} else {
			expect(registry.findByPath("/projetos/Meu Projeto")?.workspaceId).toBe("ws-1");
			// No POSIX o caminho é sensível a maiúsculas; não autoriza outro.
			expect(registry.findByPath("/projetos/meu projeto")).toBeUndefined();
		}
		registry.remove("ws-1");
		expect(registry.has("ws-1")).toBe(false);
	});
});

describe("SessionRegistry", () => {
	test("só autoriza abrir caminhos vindos da listagem", () => {
		const registry = new SessionRegistry();
		const sessionPath = process.platform === "win32" ? "C:\\sessoes\\a.jsonl" : "/sessoes/a.jsonl";
		expect(registry.isPathAuthorized("ws-1", sessionPath)).toBe(false);
		registry.authorizePath("ws-1", sessionPath);
		if (process.platform === "win32") {
			expect(registry.isPathAuthorized("ws-1", "c:\\SESSOES\\A.JSONL")).toBe(true);
		} else {
			expect(registry.isPathAuthorized("ws-1", sessionPath)).toBe(true);
			expect(registry.isPathAuthorized("ws-1", "/sessoes/A.jsonl")).toBe(false);
		}
		registry.registerSession({ workspaceId: "ws-1", sessionId: "s1", sessionPath });
		const lookup = process.platform === "win32" ? "c:\\sessoes\\a.jsonl" : sessionPath;
		expect(registry.findByPath(lookup)?.sessionId).toBe("s1");
		expect(registry.has("s1", "ws-1")).toBe(true);
		expect(registry.has("s1", "outro")).toBe(false);
		registry.unregister("s1");
		expect(registry.has("s1")).toBe(false);
		registry.clearAll();
		expect(registry.isPathAuthorized("ws-1", sessionPath)).toBe(false);
	});

	test("lista sessões abertas e limpa somente o workspace pedido", () => {
		const registry = new SessionRegistry();
		const sessionPath = process.platform === "win32" ? "C:\\a.jsonl" : "/sessoes/a.jsonl";
		registry.registerSession({ workspaceId: "ws-1", sessionId: "s1", sessionPath });
		registry.registerSession({ workspaceId: "ws-2", sessionId: "s2" });
		expect(registry.list().map((record) => record.sessionId).sort()).toEqual(["s1", "s2"]);
		registry.clearWorkspace("ws-1");
		expect(registry.list()).toEqual([{ workspaceId: "ws-2", sessionId: "s2" }]);
		expect(registry.isPathAuthorized("ws-1", sessionPath)).toBe(false);
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
