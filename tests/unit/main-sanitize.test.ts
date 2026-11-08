import { describe, expect, test } from "bun:test";
import { REDACTED, sanitizeForRenderer } from "../../src/main/sanitize";

describe("sanitizeForRenderer", () => {
	test("remove tokens, headers e providerPayload preservando conteúdo", () => {
		const input = {
			workspaceId: "ws1",
			content: "texto da conversa",
			apiKey: "sk-segredo",
			Authorization: "Bearer abc",
			headers: { "x-api-key": "123", "content-type": "application/json" },
			nested: {
				providerPayload: { secret: true },
				accessToken: "token",
				list: [{ refresh_token: "r", visible: 1 }],
			},
		};
		const output = sanitizeForRenderer(input) as Record<string, unknown>;
		expect(output.workspaceId).toBe("ws1");
		expect(output.content).toBe("texto da conversa");
		expect("apiKey" in output).toBe(false);
		expect("Authorization" in output).toBe(false);
		expect("headers" in output).toBe(false);
		const nested = output.nested as Record<string, unknown>;
		expect("providerPayload" in nested).toBe(false);
		expect("accessToken" in nested).toBe(false);
		expect(nested.list).toEqual([{ visible: 1 }]);
	});

	test("preserva conteúdo de conversa mesmo com chaves parecidas com segredo", () => {
		const content = {
			headers: { "x-token": "valor do arquivo" },
			secret: "texto do usuário",
			password: "conteúdo lido pelo agente",
			apiKey: "isto é dado, não credencial",
			providerPayload: { lido: true },
		};
		const input = {
			message: {
				content: [
					{ type: "text", text: "resposta com headers e secret no texto" },
					{ type: "toolCall", arguments: content, details: { result: content } },
				],
			},
		};
		const output = sanitizeForRenderer(input);
		expect(output).toEqual(input);
		expect(output.message.content[1]?.arguments).toEqual(content);
	});

	test("preserva resultados profundos sem expor credenciais de transporte", () => {
		let details: unknown = { text: "resultado íntegro á🚀", apiKey: "chave lida em um arquivo" };
		for (let index = 0; index < 30; index++) details = { nested: details };
		const input = {
			state: {
				messages: [{ content: [{ type: "toolCall", arguments: details }] }],
				tools: { read: { details } },
				apiKey: "credencial de transporte",
			},
		};
		const output = sanitizeForRenderer(input);
		expect(output.state.messages).toEqual(input.state.messages);
		expect(output.state.tools.read.details).toEqual(details);
		expect("apiKey" in output.state).toBe(false);
	});

	test("remove transporte e redige credenciais em baseUrl", () => {
		const output = sanitizeForRenderer({
			providerPayload: { raw: true },
			requestHeaders: { authorization: "Bearer x" },
			apiKey: "sk-segredo",
			baseUrl: "https://usuario:senha@exemplo.invalid/v1",
			publicBaseUrl: "https://exemplo.invalid/v1",
			runner: { baseUrl: "https://outro.invalid/v1", headers: { x: 1 } },
		}) as Record<string, unknown>;
		expect("providerPayload" in output).toBe(false);
		expect("requestHeaders" in output).toBe(false);
		expect("apiKey" in output).toBe(false);
		expect(output.baseUrl).toContain("[redigido");
		expect(output.publicBaseUrl).toBe("https://exemplo.invalid/v1");
		const runner = output.runner as Record<string, unknown>;
		expect(runner.baseUrl).toBe("https://outro.invalid/v1");
		expect("headers" in runner).toBe(false);
	});

	test("preserva Uint8Array e corta ciclos", () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const value: Record<string, unknown> = { bytes };
		value.self = value;
		const output = sanitizeForRenderer(value);
		expect(output.bytes).toBe(bytes);
		expect(output.self).toBe(REDACTED);
	});

	test("não copia chaves de poluição de protótipo", () => {
		const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"ok":true}') as Record<
			string,
			unknown
		>;
		const output = sanitizeForRenderer(input);
		expect(output.ok).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(output, "__proto__")).toBe(false);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});
