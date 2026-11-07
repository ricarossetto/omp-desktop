import { describe, expect, test } from "bun:test";
import {
	clampPanelWidths,
	CONVERSATION_MIN_WIDTH,
	cycleTab,
	isEditableTarget,
	RIGHT_PANEL_MAX_WIDTH,
	RIGHT_PANEL_MIN_WIDTH,
	SIDEBAR_MAX_WIDTH,
	SIDEBAR_MIN_WIDTH,
} from "../../src/renderer/layout/layout-policy";

describe("teclado da moldura", () => {
	test("campos de texto e áreas editáveis são ignorados", () => {
		expect(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
		expect(isEditableTarget({ tagName: "textarea" } as unknown as EventTarget)).toBe(true);
		expect(isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
		expect(isEditableTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
		expect(isEditableTarget(null)).toBe(false);
	});

	test("setas circulam entre as abas e Home/End vão aos extremos", () => {
		const tabs = ["agents", "changes"] as const;
		expect(cycleTab(tabs, "agents", "ArrowRight")).toBe("changes");
		expect(cycleTab(tabs, "changes", "ArrowRight")).toBe("agents");
		expect(cycleTab(tabs, "agents", "ArrowLeft")).toBe("changes");
		expect(cycleTab(tabs, "changes", "Home")).toBe("agents");
		expect(cycleTab(tabs, "agents", "End")).toBe("changes");
		expect(cycleTab(tabs, "agents", "Enter")).toBeNull();
	});
});

describe("larguras dos painéis", () => {
	test("mantém as larguras normais em janela ampla", () => {
		expect(
			clampPanelWidths({
				viewportWidth: 1440,
				sidebarOpen: true,
				rightOpen: true,
				sidebarWidth: 256,
				rightWidth: 340,
			}),
		).toEqual({ sidebar: 256, right: 340 });
	});

	test("em 1000px encolhe o painel direito para preservar 320px de conversa", () => {
		const widths = clampPanelWidths({
			viewportWidth: 1000,
			sidebarOpen: true,
			rightOpen: true,
			sidebarWidth: SIDEBAR_MAX_WIDTH,
			rightWidth: RIGHT_PANEL_MAX_WIDTH,
		});
		expect(widths.sidebar).toBe(SIDEBAR_MAX_WIDTH);
		expect(widths.right).toBeGreaterThanOrEqual(RIGHT_PANEL_MIN_WIDTH);
		expect(widths.sidebar + widths.right).toBeLessThanOrEqual(
			1000 - CONVERSATION_MIN_WIDTH - 12,
		);
	});

	test("com o painel direito fechado a barra lateral pode chegar ao máximo", () => {
		expect(
			clampPanelWidths({
				viewportWidth: 1000,
				sidebarOpen: true,
				rightOpen: false,
				sidebarWidth: SIDEBAR_MAX_WIDTH,
				rightWidth: RIGHT_PANEL_MAX_WIDTH,
			}),
		).toEqual({ sidebar: SIDEBAR_MAX_WIDTH, right: RIGHT_PANEL_MAX_WIDTH });
	});

	test("nunca devolve largura abaixo do mínimo", () => {
		const widths = clampPanelWidths({
			viewportWidth: 700,
			sidebarOpen: true,
			rightOpen: true,
			sidebarWidth: 100,
			rightWidth: 100,
		});
		expect(widths.sidebar).toBe(SIDEBAR_MIN_WIDTH);
		expect(widths.right).toBe(RIGHT_PANEL_MIN_WIDTH);
	});
});
