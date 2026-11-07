import { describe, expect, test } from "bun:test";
import { computeOffsets, computeVirtualWindow, findIndexAt } from "../../src/renderer/features/conversation/virtual-window";

function constantHeight(height: number) {
	return () => height;
}

describe("janela de virtualização", () => {
	test("calcula início, fim e espaçadores com alturas uniformes", () => {
		const window = computeVirtualWindow({
			itemCount: 100,
			heightAt: constantHeight(40),
			scrollTop: 1000,
			viewportHeight: 400,
			overscan: 2,
		});
		expect(window.start).toBe(23);
		expect(window.end).toBe(37);
		expect(window.padTop).toBe(920);
		expect(window.padBottom).toBe((100 - 37) * 40);
		expect(window.totalHeight).toBe(4000);
	});

	test("listas vazias não geram altura", () => {
		const window = computeVirtualWindow({
			itemCount: 0,
			heightAt: constantHeight(40),
			scrollTop: 0,
			viewportHeight: 400,
		});
		expect(window).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0, startOffset: 0 });
	});

	test("alturas variáveis não deixam buracos somando padTop + renderizado + padBottom", () => {
		const heights = [10, 200, 30, 500, 40, 40, 40, 40, 400, 20];
		const heightAt = (index: number) => heights[index] ?? 40;
		const window = computeVirtualWindow({
			itemCount: heights.length,
			heightAt,
			scrollTop: 240,
			viewportHeight: 300,
			overscan: 1,
		});
		const offsets = computeOffsets(heights.length, heightAt);
		let rendered = 0;
		for (let index = window.start; index < window.end; index++) rendered += heights[index] ?? 40;
		expect(window.padTop + rendered + window.padBottom).toBe(window.totalHeight);
		const contentStart = offsets[window.start];
		expect(contentStart).toBeLessThanOrEqual(240);
		expect(offsets[window.end - 1] + (heights[window.end - 1] ?? 0)).toBeGreaterThanOrEqual(240 + 300 - 1);
	});

	test("scroll além do fim fica limitado ao último item", () => {
		const window = computeVirtualWindow({
			itemCount: 10,
			heightAt: constantHeight(50),
			scrollTop: 99999,
			viewportHeight: 300,
			overscan: 0,
		});
		expect(window.start).toBeLessThanOrEqual(9);
		expect(window.end).toBe(10);
	});

	test("findIndexAt localiza o item que contém o deslocamento", () => {
		const offsets = computeOffsets(5, constantHeight(100));
		expect(findIndexAt(offsets, 0)).toBe(0);
		expect(findIndexAt(offsets, 99)).toBe(0);
		expect(findIndexAt(offsets, 100)).toBe(1);
		expect(findIndexAt(offsets, 399)).toBe(3);
		expect(findIndexAt(offsets, 500)).toBe(4);
		expect(findIndexAt(offsets, 1000)).toBe(4);
	});
});
