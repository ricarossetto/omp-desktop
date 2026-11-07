import { describe, expect, test } from "bun:test";
import {
	projectModel,
	projectModels,
	projectUsage,
	sanitizeForRenderer,
	sanitizeFrame,
	sanitizeRpcResult,
} from "../../src/host/sanitize";

describe("sanitização de DTOs", () => {
	test("remove metadados de transporte preservando a conversa", () => {
		const frame = {
			type: "message_end",
			messageId: "m1",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "resposta" },
					{ type: "thinking", thinking: "raciocínio" },
					{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
				],
				provider: "fake",
				model: "model",
				providerPayload: { secret: "provider raw" },
				providerMetadata: { signature: "abc" },
				baseUrl: "https://user:pass@example.com",
				headers: { authorization: "Bearer x" },
				apiKey: "sk-123456789012345",
				tokens: { accessToken: "a", refreshToken: "r" },
			},
			providerPayload: { top: true },
			systemPrompt: ["instruções internas"],
			dumpTools: [{ name: "bash" }],
		};
		const sanitized = sanitizeFrame(frame) as Record<string, unknown>;
		const message = sanitized.message as Record<string, unknown>;
		expect(sanitized.providerPayload).toBeUndefined();
		expect(sanitized.systemPrompt).toBeUndefined();
		expect(sanitized.dumpTools).toBeUndefined();
		expect(message.providerPayload).toBeUndefined();
		expect(message.providerMetadata).toBeUndefined();
		expect(message.baseUrl).toBe("[redigido: credenciais na URL]");
		expect(message.headers).toBeUndefined();
		expect(message.apiKey).toBeUndefined();
		const tokenBag = message.tokens as Record<string, unknown> | undefined;
		expect(tokenBag?.accessToken).toBeUndefined();
		expect(tokenBag?.refreshToken).toBeUndefined();
		expect(message.content).toEqual(frame.message.content);
		expect(JSON.stringify(sanitized)).not.toContain("Bearer");
		expect(JSON.stringify(sanitized)).not.toContain("sk-123456789012345");
	});

	test("conteúdo de ferramenta com chaves sensíveis NÃO é removido (é dado, não transporte)", () => {
		const frame = {
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: {
				content: [
					{
						type: "text",
						text: 'config: {"headers": {"authorization": "Bearer do arquivo"}, "apiKey": "chave-do-arquivo"}',
					},
				],
				details: { password: "valor-lido-do-arquivo", secret: "outro valor" },
			},
		};
		const sanitized = sanitizeFrame(frame) as Record<string, unknown>;
		const result = sanitized.result as Record<string, unknown>;
		const content = result.content as Array<Record<string, unknown>>;
		expect(content[0].text).toContain("headers");
		expect(content[0].text).toContain("chave-do-arquivo");
		expect(result.details).toEqual({ password: "valor-lido-do-arquivo", secret: "outro valor" });
	});

	test("texto do usuário não é redigido por prefixo de chave", () => {
		const frame = {
			type: "message_end",
			message: {
				role: "user",
				content: [{ type: "text", text: "sk-isto-e-conteudo-do-usuario e AKIAABCDEFGHIJKLMNOP" }],
			},
		};
		const sanitized = sanitizeFrame(frame) as Record<string, unknown>;
		const message = sanitized.message as Record<string, unknown>;
		const content = message.content as Array<Record<string, unknown>>;
		expect(content[0].text).toBe("sk-isto-e-conteudo-do-usuario e AKIAABCDEFGHIJKLMNOP");
	});

	test("argumentos de toolCall preservam headers/apiKey e baseUrl sem credenciais", () => {
		const frame = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "t1",
						name: "write",
						arguments: {
							path: "cfg.json",
							headers: { accept: "text/plain" },
							apiKey: "chave-escrita-pela-ferramenta",
							baseUrl: "https://user:pass@example.com/v1",
						},
					},
				],
			},
		};
		const sanitized = sanitizeFrame(frame) as Record<string, unknown>;
		const message = sanitized.message as Record<string, unknown>;
		const content = message.content as Array<Record<string, unknown>>;
		const args = content[0].arguments as Record<string, unknown>;
		expect(args.headers).toEqual({ accept: "text/plain" });
		expect(args.apiKey).toBe("chave-escrita-pela-ferramenta");
		expect(args.baseUrl).toBe("https://user:pass@example.com/v1");
	});

	test("get_state projetado remove systemPrompt/dumpTools do topo", () => {
		const data = {
			model: { provider: "fake", id: "m", apiKey: "sk-x", headers: { x: "y" } },
			systemPrompt: ["interno"],
			dumpTools: [{ name: "bash" }],
			toolResults: [{ type: "toolResult", details: { secret: "lido do disco" } }],
		};
		const sanitized = sanitizeRpcResult(data) as Record<string, unknown>;
		expect(sanitized.systemPrompt).toBeUndefined();
		expect(sanitized.dumpTools).toBeUndefined();
		expect((sanitized.model as Record<string, unknown>).apiKey).toBeUndefined();
		expect((sanitized.model as Record<string, unknown>).headers).toBeUndefined();
		const results = sanitized.toolResults as Array<Record<string, unknown>>;
		expect(results[0].details).toEqual({ secret: "lido do disco" });
	});

	test("SettingsSnapshot projeta segredos sem apagar valores de conversa/arquivo", () => {
		const snapshot = {
			effective: {
				"providers.openai.baseUrl": "https://user:pass@example.com",
				"providers.openai.apiKey": "sk-segredo",
				modelRoles: { task: "fake/model" },
			},
			schema: {},
		};
		const projected = sanitizeForRenderer(snapshot);
		expect(projected.effective["providers.openai.baseUrl"]).toBe("[redigido: credenciais na URL]");
		expect(projected.effective["providers.openai.apiKey"]).toBeUndefined();
		expect(projected.effective.modelRoles).toEqual({ task: "fake/model" });
	});

	test("modelo projetado não expõe baseUrl nem credenciais", () => {
		const models = projectModels({
			models: [
				{
					provider: "fake",
					id: "m1",
					name: "Modelo",
					baseUrl: "https://token:secret@example.com",
					input: ["text", "image"],
					apiKey: "sk-x",
				},
			],
		});
		expect(models).toHaveLength(1);
		expect(models[0]).toEqual({
			provider: "fake",
			id: "m1",
			name: "Modelo",
			contextWindow: undefined,
			maxTokens: undefined,
			input: ["text", "image"],
			reasoning: undefined,
		});
		expect(JSON.stringify(models)).not.toContain("sk-x");
		expect(projectModel({ provider: "fake", id: "m2", apiKey: "sk-y" })).toEqual({
			provider: "fake",
			id: "m2",
			name: undefined,
			contextWindow: undefined,
			maxTokens: undefined,
			input: undefined,
			reasoning: undefined,
		});
	});

	test("uso desconhecido continua desconhecido (nunca 0%)", () => {
		const unknown = projectUsage({ generatedAt: 10, reports: [] });
		expect(unknown.unknown).toBe(true);
		expect(unknown.providers).toHaveLength(0);
		expect(unknown.updatedAt).toBe(10);
		const known = projectUsage({
			generatedAt: 20,
			reports: [
				{
					provider: "fake",
					fetchedAt: 19,
					metadata: { email: "pessoa@example.com", planType: "pro" },
					limits: [
						{
							id: "5h",
							label: "Janela 5h",
							amount: { used: 8, usedFraction: 0.08, unit: "percent" },
							window: { resetsAt: 30 },
							status: "ok",
						},
					],
				},
			],
		});
		expect(known.unknown).toBe(false);
		expect(known.providers[0].providerId).toBe("fake");
		expect(known.providers[0].accounts[0].label).toBe("pessoa@example.com");
		expect(known.providers[0].accounts[0].windows[0].usedPercent).toBe(8);
		expect(known.providers[0].accounts[0].windows[0].resetsAt).toBe(30);
		expect(JSON.stringify(known)).not.toContain("accessToken");
	});

	test("percentual aceita used/limit, unidade percentual e fração restante", () => {
		const usedLimit = projectUsage({
			reports: [{ provider: "fake", limits: [{ label: "5h", amount: { used: 5, limit: 10 } }] }],
		});
		expect(usedLimit.providers[0].accounts[0].windows[0].usedPercent).toBe(50);

		const percentUnit = projectUsage({
			reports: [{ provider: "fake", limits: [{ label: "5h", amount: { used: 8, unit: "percent" } }] }],
		});
		expect(percentUnit.providers[0].accounts[0].windows[0].usedPercent).toBe(8);

		const remaining = projectUsage({
			reports: [{ provider: "fake", limits: [{ label: "5h", amount: { remainingFraction: 0.25 } }] }],
		});
		expect(remaining.providers[0].accounts[0].windows[0].usedPercent).toBe(75);
	});

	test("não inventa conta ativa e só é desconhecido sem percentual", () => {
		const usage = projectUsage({
			reports: [
				{
					provider: "fake",
					metadata: { email: "a@example.com" },
					limits: [{ label: "5h", amount: { usedFraction: 0.1 } }],
				},
				{ provider: "outro", metadata: { email: "b@example.com" }, limits: [] },
			],
			accountsWithoutUsage: [{ provider: "terceiro", email: "c@example.com" }],
		});
		for (const provider of usage.providers) {
			for (const account of provider.accounts) {
				expect(Object.hasOwn(account, "active")).toBe(false);
			}
		}
		expect(usage.unknown).toBe(false);

		const noPercent = projectUsage({
			reports: [{ provider: "fake", limits: [{ label: "5h", amount: {} }] }],
		});
		expect(noPercent.unknown).toBe(true);
		expect(noPercent.message).toContain("percentual");
	});
});
