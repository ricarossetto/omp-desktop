import { describe, expect, test } from "bun:test";
import {
	isAllowedRendererUrl,
	isAuthorizedSender,
	rendererFileUrl,
	validateDevRendererUrl,
	type AuthorizedWindow,
	type FrameLike,
} from "../../src/main/ipc-guard";

const productionFile = rendererFileUrl("C:/app/out/renderer/index.html");

const mainFrame: FrameLike = {
	url: productionFile,
	parent: null,
	processId: 10,
	routingId: 2,
};

const authorized: AuthorizedWindow = {
	webContentsId: 7,
	mainFrame,
	productionFileUrl: productionFile,
};

describe("isAuthorizedSender", () => {
	test("aceita o main frame da janela autorizada", () => {
		expect(
			isAuthorizedSender(
				{
					sender: { id: 7, mainFrame },
					senderFrame: { ...mainFrame },
				},
				authorized,
			),
		).toBe(true);
	});

	test("recusa outro webContents", () => {
		expect(
			isAuthorizedSender({ sender: { id: 8, mainFrame }, senderFrame: { ...mainFrame } }, authorized),
		).toBe(false);
	});

	test("recusa iframe (parent não nulo)", () => {
		expect(
			isAuthorizedSender(
				{
					sender: { id: 7, mainFrame },
					senderFrame: { ...mainFrame, parent: { url: productionFile } },
				},
				authorized,
			),
		).toBe(false);
	});

	test("recusa frame com routing/processo diferente", () => {
		expect(
			isAuthorizedSender(
				{
					sender: { id: 7, mainFrame },
					senderFrame: { ...mainFrame, routingId: 99 },
				},
				authorized,
			),
		).toBe(false);
	});

	test("recusa frame ausente e origem externa", () => {
		expect(isAuthorizedSender({ sender: { id: 7, mainFrame }, senderFrame: null }, authorized)).toBe(false);
		expect(
			isAuthorizedSender(
				{
					sender: { id: 7, mainFrame },
					senderFrame: { ...mainFrame, url: "https://evil.example/app" },
				},
				authorized,
			),
		).toBe(false);
		expect(
			isAuthorizedSender(
				{
					sender: { id: 7, mainFrame },
					senderFrame: { ...mainFrame, url: "javascript:alert(1)" },
				},
				authorized,
			),
		).toBe(false);
	});
});

describe("URLs do renderer", () => {
	test("aceita o index de produção e ignora caixa/consulta", () => {
		expect(isAllowedRendererUrl(productionFile, authorized)).toBe(true);
		expect(isAllowedRendererUrl(`${productionFile}?x=1#hash`, authorized)).toBe(true);
		expect(
			isAllowedRendererUrl("file:///C:/app/out/renderer/outra.html", authorized),
		).toBe(false);
	});

	if (process.platform !== "win32") {
		test("POSIX compara o caminho do arquivo com caixa exata", () => {
			const upper = productionFile.replace(/index\.html$/i, "INDEX.html");
			expect(upper).not.toBe(productionFile);
			expect(isAllowedRendererUrl(upper, authorized)).toBe(false);
		});
	}

	test("dev exige loopback 127.0.0.1", () => {
		expect(validateDevRendererUrl("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
		expect(validateDevRendererUrl("http://localhost:5173/")).toBeUndefined();
		expect(validateDevRendererUrl("https://127.0.0.1:5173/")).toBeUndefined();
		expect(validateDevRendererUrl("http://127.0.0.1.evil:5173/")).toBeUndefined();
	});

	test("aceita dev configurado somente no mesmo host:porta", () => {
		const devAuthorized: AuthorizedWindow = {
			...authorized,
			devUrl: "http://127.0.0.1:5173/",
		};
		expect(
			isAllowedRendererUrl("http://127.0.0.1:5173/index.html", devAuthorized),
		).toBe(true);
		expect(isAllowedRendererUrl("http://127.0.0.1:6000/", devAuthorized)).toBe(false);
		expect(isAllowedRendererUrl("http://localhost:5173/", devAuthorized)).toBe(false);
	});
});
