import { describe, expect, test } from "bun:test";
import { formatContextPercent, formatCostUsd, normalizeStats } from "../../src/renderer/store/stats";

describe("normalização de get_session_stats", () => {
	test("lê o custo do envelope RPC e nunca soma eventos", () => {
		const stats = normalizeStats({
			type: "response",
			command: "get_session_stats",
			success: true,
			data: {
				cost: 0.0234,
				tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, total: 135 },
			},
		});
		expect(stats?.costUsd).toBe(0.0234);
		expect(stats?.tokens).toEqual({ input: 100, output: 20, cacheRead: 10, cacheWrite: 5, total: 135 });
	});

	test("aceita data direto e custo zero", () => {
		const stats = normalizeStats({ cost: 0, tokens: { total: 0 } });
		expect(stats?.costUsd).toBe(0);
	});

	test("ausência de estatística continua indisponível", () => {
		expect(normalizeStats(null)).toBeNull();
		expect(normalizeStats({})).toBeNull();
		expect(normalizeStats({ foo: 1 })).toBeNull();
	});

	test("formata custo e contexto em pt-BR sem transformar 3,2 em 100", () => {
		expect(formatCostUsd(undefined)).toBe("Indisponível");
		expect(formatCostUsd(0)).toBe("US$ 0,00");
		expect(formatCostUsd(0.0234)).toBe("US$ 0,02");
		expect(formatCostUsd(0.0004)).toBe("US$ 0,0004");
		expect(formatCostUsd(1.5)).toBe("US$ 1,50");
		expect(formatContextPercent(3.2)).toBe("3,2%");
		expect(formatContextPercent(100)).toBe("100%");
		expect(formatContextPercent(undefined)).toBe("Indisponível");
	});
});
