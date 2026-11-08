import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	assertTrustedDownloadUrl,
	OmpInstallError,
	OmpInstaller,
	OmpInstallService,
	ompBinaryName,
	ompInstallTarget,
	resolveOmpInstallDir,
	type OmpFetch,
	type OmpInstallProgress,
} from "../../src/main/omp-install";

const VERSION = "18.16.0";
const BINARY = new TextEncoder().encode("conteúdo binário do omp de teste");
const SHA = createHash("sha256").update(BINARY).digest("hex");
const FILE_NAME = "omp-windows-x64.exe";

function apiAnswer(overrides: Record<string, unknown> = {}) {
	return {
		build: { version: VERSION },
		file: { name: FILE_NAME, sha256: SHA, size: BINARY.byteLength },
		download: `https://build.stencil.so/d/omp/${FILE_NAME}`,
		...overrides,
	};
}

function fakeFetch(options: {
	answer?: unknown;
	answerStatus?: number;
	binary?: Uint8Array;
	onDownload?: (init: RequestInit) => Promise<Response> | Response;
} = {}): { fetchImpl: OmpFetch; calls: string[] } {
	const calls: string[] = [];
	const fetchImpl: OmpFetch = async (url, init) => {
		calls.push(url);
		if (url.includes("/api/products/")) {
			return new Response(JSON.stringify(options.answer ?? apiAnswer()), {
				status: options.answerStatus ?? 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (options.onDownload) return options.onDownload(init);
		const bytes = options.binary ?? BINARY;
		// `slice` devolve um ArrayBuffer próprio; o BodyInit do DOM não aceita
		// o genérico `Uint8Array<ArrayBufferLike>` desta versão do TypeScript.
		const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		return new Response(body, {
			status: 200,
			headers: { "content-length": String(bytes.byteLength) },
		});
	};
	return { fetchImpl, calls };
}

async function tempDir(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "omp-install-"));
}

const probeOk = async () => ({ compatible: true, ompVersion: VERSION });

describe("caminho e alvo oficiais", () => {
	test("respeita PI_INSTALL_DIR e cai para LOCALAPPDATA\\omp no Windows", () => {
		expect(resolveOmpInstallDir({ PI_INSTALL_DIR: "C:\\tmp\\omp-install" }, "win32")).toBe(
			path.resolve("C:\\tmp\\omp-install"),
		);
		expect(
			resolveOmpInstallDir({ LOCALAPPDATA: "C:\\Users\\teste\\AppData\\Local" }, "win32"),
		).toBe(path.join("C:\\Users\\teste\\AppData\\Local", "omp"));
		expect(() => resolveOmpInstallDir({}, "win32")).toThrow(OmpInstallError);
	});

	test("Linux usa PI_INSTALL_DIR ou $HOME/.local/bin, como o install.sh oficial", () => {
		const home = path.join(tmpdir(), "omp-home");
		expect(resolveOmpInstallDir({ HOME: home }, "linux")).toBe(
			path.join(home, ".local", "bin"),
		);
		expect(
			resolveOmpInstallDir({ HOME: home, PI_INSTALL_DIR: path.join(home, "custom") }, "linux"),
		).toBe(path.resolve(path.join(home, "custom")));
		expect(() => resolveOmpInstallDir({}, "linux")).toThrow(OmpInstallError);
		expect(() => resolveOmpInstallDir({ HOME: home }, "darwin")).toThrow(OmpInstallError);
	});

	test("mapeia arquiteturas como os instaladores oficiais", () => {
		expect(ompInstallTarget("x64", "win32")).toBe("windows-x86_64");
		expect(ompInstallTarget("arm64", "win32")).toBe("windows-arm64");
		expect(() => ompInstallTarget("ia32", "win32")).toThrow(OmpInstallError);
		expect(ompInstallTarget("x64", "linux")).toBe("linux-x86_64");
		expect(() => ompInstallTarget("arm64", "linux")).toThrow(OmpInstallError);
		expect(ompBinaryName("win32")).toBe("omp.exe");
		expect(ompBinaryName("linux")).toBe("omp");
	});
});

describe("URL de download confiável", () => {
	test("aceita o serviço oficial e o bucket R2 assinado", () => {
		expect(
			assertTrustedDownloadUrl(`https://build.stencil.so/d/omp/${FILE_NAME}`, FILE_NAME).hostname,
		).toBe("build.stencil.so");
		expect(
			assertTrustedDownloadUrl(
				`https://abc123.r2.cloudflarestorage.com/ompcast/builds/omp/${FILE_NAME}?X-Amz-Signature=abc`,
				FILE_NAME,
			).hostname,
		).toBe("abc123.r2.cloudflarestorage.com");
	});

	test("rejeita http, credenciais, host desconhecido e arquivo divergente", () => {
		for (const url of [
			`http://build.stencil.so/d/omp/${FILE_NAME}`,
			`https://user:pass@build.stencil.so/d/omp/${FILE_NAME}`,
			`https://evil.example/d/omp/${FILE_NAME}`,
			"https://build.stencil.so/d/omp/outro.exe",
		]) {
			expect(() => assertTrustedDownloadUrl(url, FILE_NAME)).toThrow(OmpInstallError);
		}
	});
});

describe("instalação do binário", () => {
	test("baixa, confere SHA-256, executa --version e grava o executável", async () => {
		const dir = await tempDir();
		try {
			const { fetchImpl, calls } = fakeFetch();
			const progress: OmpInstallProgress[] = [];
			const installer = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "windows-x86_64",
				fetchImpl,
				probe: probeOk,
				onProgress: (entry) => progress.push(entry),
			});
			const result = await installer.install();
			expect(result.downloaded).toBe(true);
			expect(result.ompPath).toBe(path.join(dir, "omp.exe"));
			expect(result.ompVersion).toBe(VERSION);
			expect(await readFile(result.ompPath)).toEqual(Buffer.from(BINARY));
			expect(calls[0]).toContain(`/api/products/omp/versions/${VERSION}/windows-x86_64`);
			expect(progress.some((entry) => entry.phase === "downloading")).toBe(true);
			expect(progress.some((entry) => entry.phase === "verifying")).toBe(true);
			expect(progress.some((entry) => entry.phase === "activating")).toBe(true);
			expect((await readdir(dir)).filter((name) => name.startsWith(".omp.download-"))).toHaveLength(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("não sobrescreve um omp.exe compatível já existente", async () => {
		const dir = await tempDir();
		try {
			const finalPath = path.join(dir, "omp.exe");
			await writeFile(finalPath, "instalação anterior");
			let fetched = 0;
			const installer = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "windows-x86_64",
				fetchImpl: async () => {
					fetched += 1;
					throw new Error("não deveria baixar");
				},
				probe: probeOk,
			});
			const result = await installer.install();
			expect(result.downloaded).toBe(false);
			expect(result.ompVersion).toBe(VERSION);
			expect(fetched).toBe(0);
			expect(await readFile(finalPath, "utf8")).toBe("instalação anterior");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("não substitui um omp.exe existente incompatível", async () => {
		const dir = await tempDir();
		try {
			const finalPath = path.join(dir, "omp.exe");
			await writeFile(finalPath, "arquivo antigo");
			let fetched = 0;
			const installer = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "windows-x86_64",
				fetchImpl: async () => {
					fetched += 1;
					throw new Error("não deveria baixar");
				},
				probe: async () => ({ compatible: false, message: "versão 17" }),
			});
			await expect(installer.install()).rejects.toMatchObject({
				code: "EXISTING_INCOMPATIBLE",
			});
			expect(fetched).toBe(0);
			expect(await readFile(finalPath, "utf8")).toBe("arquivo antigo");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("checksum divergente descarta o download e não cria omp.exe", async () => {
		const dir = await tempDir();
		try {
			const { fetchImpl } = fakeFetch({
				answer: apiAnswer({
					file: { name: FILE_NAME, sha256: "0".repeat(64), size: BINARY.byteLength },
				}),
			});
			const installer = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "windows-x86_64",
				fetchImpl,
				probe: probeOk,
			});
			await expect(installer.install()).rejects.toMatchObject({ code: "CHECKSUM" });
			expect(existsSync(path.join(dir, "omp.exe"))).toBe(false);
			expect((await readdir(dir)).filter((name) => name.startsWith(".omp.download-"))).toHaveLength(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("versão divergente após --version remove o arquivo e falha", async () => {
		const dir = await tempDir();
		try {
			const { fetchImpl } = fakeFetch();
			const installer = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "windows-x86_64",
				fetchImpl,
				probe: async () => ({ compatible: true, ompVersion: "18.15.0" }),
			});
			await expect(installer.install()).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
			expect(existsSync(path.join(dir, "omp.exe"))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("serviço oficial indisponível vira erro acionável sem gravar caminho", async () => {
		const dir = await tempDir();
		try {
			const { fetchImpl } = fakeFetch({ answerStatus: 503 });
			const installer = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "windows-x86_64",
				fetchImpl,
				probe: probeOk,
			});
			await expect(installer.install()).rejects.toMatchObject({ code: "NETWORK" });
			expect(existsSync(path.join(dir, "omp.exe"))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("host de download não confiável é recusado antes de gravar", async () => {
		const dir = await tempDir();
		try {
			const { fetchImpl } = fakeFetch({
				answer: apiAnswer({ download: `https://evil.example/${FILE_NAME}` }),
			});
			const installer = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "windows-x86_64",
				fetchImpl,
				probe: probeOk,
			});
			await expect(installer.install()).rejects.toMatchObject({ code: "NETWORK" });
			expect(existsSync(path.join(dir, "omp.exe"))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("instalação Linux x86_64", () => {
	const LINUX_FILE = "omp-linux-x64";
	const linuxAnswer = () => ({
		build: { version: VERSION },
		file: { name: LINUX_FILE, sha256: SHA, size: BINARY.byteLength },
		download: `https://build.stencil.so/d/omp/${LINUX_FILE}`,
	});

	test("grava <dir>/omp sem .exe, aplica modo executável e limpa temporários", async () => {
		const dir = await tempDir();
		try {
			const { fetchImpl, calls } = fakeFetch({ answer: linuxAnswer() });
			const installer = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "linux-x86_64",
				fetchImpl,
				probe: probeOk,
			});
			const result = await installer.install();
			expect(result.downloaded).toBe(true);
			expect(result.ompPath).toBe(path.join(dir, "omp"));
			expect(result.installDir).toBe(dir);
			expect(existsSync(path.join(dir, "omp.exe"))).toBe(false);
			expect(await readFile(result.ompPath)).toEqual(Buffer.from(BINARY));
			if (process.platform !== "win32") {
				expect((await stat(result.ompPath)).mode & 0o111).not.toBe(0);
			}
			expect(calls[0]).toContain(`/api/products/omp/versions/${VERSION}/linux-x86_64`);
			expect((await readdir(dir)).filter((name) => name.startsWith(".omp.download-"))).toHaveLength(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("não sobrescreve um omp Linux compatível já existente", async () => {
		const dir = await tempDir();
		try {
			const finalPath = path.join(dir, "omp");
			await writeFile(finalPath, "instalação anterior");
			let fetched = 0;
			const installer = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "linux-x86_64",
				fetchImpl: async () => {
					fetched += 1;
					throw new Error("não deveria baixar");
				},
				probe: probeOk,
			});
			const result = await installer.install();
			expect(result.downloaded).toBe(false);
			expect(result.ompPath).toBe(finalPath);
			expect(fetched).toBe(0);
			expect(await readFile(finalPath, "utf8")).toBe("instalação anterior");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("checksum divergente não cria omp e versão divergente remove o promovido", async () => {
		const dir = await tempDir();
		try {
			const bad = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "linux-x86_64",
				fetchImpl: fakeFetch({
					answer: {
						...linuxAnswer(),
						file: { name: LINUX_FILE, sha256: "0".repeat(64), size: BINARY.byteLength },
					},
				}).fetchImpl,
				probe: probeOk,
			});
			await expect(bad.install()).rejects.toMatchObject({ code: "CHECKSUM" });
			expect(existsSync(path.join(dir, "omp"))).toBe(false);

			const mismatch = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "linux-x86_64",
				fetchImpl: fakeFetch({ answer: linuxAnswer() }).fetchImpl,
				probe: async () => ({ compatible: true, ompVersion: "18.15.0" }),
			});
			await expect(mismatch.install()).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
			expect(existsSync(path.join(dir, "omp"))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("recusa nome .exe para alvo Linux antes de gravar", async () => {
		const dir = await tempDir();
		try {
			const installer = new OmpInstaller({
				installDir: dir,
				version: VERSION,
				target: "linux-x86_64",
				fetchImpl: fakeFetch({
					answer: {
						...linuxAnswer(),
						file: { name: "omp-linux-x64.exe", sha256: SHA, size: BINARY.byteLength },
						download: "https://build.stencil.so/d/omp/omp-linux-x64.exe",
					},
				}).fetchImpl,
				probe: probeOk,
			});
			await expect(installer.install()).rejects.toMatchObject({ code: "NETWORK" });
			expect(existsSync(path.join(dir, "omp"))).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("single-flight e recuperação", () => {
	test("cliques concorrentes compartilham a mesma instalação", async () => {
		const gate = Promise.withResolvers<void>();
		let created = 0;
		const service = new OmpInstallService(() => {
			created += 1;
			return {
				install: async () => {
					await gate.promise;
					return {
						ompPath: "C:\\tmp\\omp.exe",
						ompVersion: VERSION,
						installDir: "C:\\tmp",
						downloaded: true,
					};
				},
			} as unknown as OmpInstaller;
		});
		const first = service.install();
		const second = service.install();
		expect(first).toBe(second);
		expect(service.installing).toBe(true);
		gate.resolve();
		await first;
		await Promise.resolve();
		expect(created).toBe(1);
		expect(service.installing).toBe(false);
	});

	test("falha não fica em cache; a próxima tentativa cria nova execução", async () => {
		let attempts = 0;
		const service = new OmpInstallService(() => {
			attempts += 1;
			const current = attempts;
			return {
				install: async () => {
					if (current === 1) throw new OmpInstallError("NETWORK", "sem rede");
					return {
						ompPath: "C:\\tmp\\omp.exe",
						ompVersion: VERSION,
						installDir: "C:\\tmp",
						downloaded: true,
					};
				},
			} as unknown as OmpInstaller;
		});
		await expect(service.install()).rejects.toMatchObject({ code: "NETWORK" });
		const result = await service.install();
		expect(result.ompPath).toBe("C:\\tmp\\omp.exe");
		expect(attempts).toBe(2);
	});

	test("cancelar aborta a consulta e devolve ABORTED", async () => {
		const service = new OmpInstallService(
			(signal) =>
				new OmpInstaller({
					installDir: "C:\\tmp\\omp-install-abort",
					version: VERSION,
					target: "windows-x86_64",
					signal,
					fetchImpl: (_url, init) => {
						if (init.signal?.aborted) {
							return Promise.reject(new DOMException("aborted", "AbortError"));
						}
						return new Promise<Response>((_resolve, reject) => {
							init.signal?.addEventListener(
								"abort",
								() => reject(new DOMException("aborted", "AbortError")),
								{ once: true },
							);
						});
					},
					probe: probeOk,
				}),
		);
		const promise = service.install();
		service.cancel();
		await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
	});
});
