import { describe, expect, test } from "bun:test";
import { APPROVAL_MODES, isApprovalMode } from "../../src/shared/session-types";
import { normalizeApprovalSettings, resolveApprovalMode } from "../../src/renderer/store/state";

describe("approval mode", () => {
	test("aceita exatamente os valores do OMP", () => {
		for (const mode of APPROVAL_MODES) expect(isApprovalMode(mode)).toBe(true);
		expect(isApprovalMode("Write")).toBe(false);
		expect(isApprovalMode("always_ask")).toBe(false);
		expect(isApprovalMode(undefined)).toBe(false);
	});

	test("resolve override do projeto e cai no padrão global", () => {
		const state = {
			approval: { default: "write" as const, projects: { ws1: "yolo" as const } },
		};
		expect(resolveApprovalMode(state, "ws1")).toBe("yolo");
		expect(resolveApprovalMode(state, "ws2")).toBe("write");
		expect(resolveApprovalMode(state, null)).toBe("write");
	});

	test("normaliza o estado persistido e descarta valores inválidos", () => {
		expect(normalizeApprovalSettings(null)).toEqual({ default: "write", projects: {} });
		expect(
			normalizeApprovalSettings({
				default: "yolo",
				projects: { ws1: "always-ask", ws2: "invalido", ws3: 3 },
			}),
		).toEqual({ default: "yolo", projects: { ws1: "always-ask" } });
		expect(normalizeApprovalSettings({ default: "nope" })).toEqual({
			default: "write",
			projects: {},
		});
	});
});
