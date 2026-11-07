/**
 * Cadastro de pastas de projeto escolhidas pelo usuário.
 *
 * - ID estável derivado do caminho real normalizado (case-insensitive no Windows).
 * - Deduplica por caminho; remover só apaga o item recente, nunca os arquivos.
 * - Pasta ausente vira `available: false` e aceita relocalização.
 * - Persistência em JSON com escrita atômica no diretório de dados do host.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceDto } from "../shared/contracts";
import { isRecord } from "../shared/session-state";
import { writeFileAtomic } from "./log";

interface WorkspaceRecord {
	workspaceId: string;
	path: string;
	name: string;
	lastOpenedAt: number;
	isGitRepo?: boolean;
}

interface WorkspacesFile {
	version: 1;
	workspaces: WorkspaceRecord[];
}

export function pathKey(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function realDirectory(input: string): Promise<string> {
	const absolute = path.resolve(input);
	const real = await fs.promises.realpath(absolute);
	const stat = await fs.promises.stat(real);
	if (!stat.isDirectory()) throw new Error(`O caminho não é uma pasta: ${absolute}`);
	return real;
}

async function isGitRepo(dir: string): Promise<boolean> {
	try {
		const stat = await fs.promises.stat(path.join(dir, ".git"));
		return stat.isDirectory() || stat.isFile();
	} catch {
		return false;
	}
}

function workspaceIdFor(realPath: string): string {
	const digest = createHash("sha256").update(pathKey(realPath), "utf8").digest("hex");
	return `ws_${digest.slice(0, 16)}`;
}

function displayName(realPath: string): string {
	const base = path.basename(realPath);
	return base.length > 0 ? base : realPath;
}

export class WorkspaceStore {
	private readonly file: string;
	private records: WorkspaceRecord[] = [];
	private loaded = false;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(dataDir: string) {
		this.file = path.join(dataDir, "workspaces.json");
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = JSON.parse(await fs.promises.readFile(this.file, "utf8")) as unknown;
			if (isRecord(raw) && Array.isArray(raw.workspaces)) {
				this.records = raw.workspaces
					.filter(isRecord)
					.map((item) => ({
						workspaceId:
							typeof item.workspaceId === "string" ? item.workspaceId : workspaceIdFor(String(item.path)),
						path: typeof item.path === "string" ? item.path : "",
						name: typeof item.name === "string" ? item.name : displayName(String(item.path)),
						lastOpenedAt: typeof item.lastOpenedAt === "number" ? item.lastOpenedAt : 0,
						isGitRepo: item.isGitRepo === true ? true : undefined,
					}))
					.filter((item) => item.path.length > 0);
			}
		} catch {
			this.records = [];
		}
	}

	private async persist(): Promise<void> {
		const payload: WorkspacesFile = { version: 1, workspaces: this.records };
		const previous = this.writeChain;
		this.writeChain = previous.then(() =>
			writeFileAtomic(this.file, `${JSON.stringify(payload, null, 2)}\n`).catch(() => undefined),
		);
		await this.writeChain;
	}

	async list(): Promise<WorkspaceDto[]> {
		await this.load();
		const dtos = await Promise.all(this.records.map((record) => this.toDto(record)));
		return dtos.sort((a, b) => (b.available ? 1 : 0) - (a.available ? 1 : 0) || b.lastOpenedAt - a.lastOpenedAt);
	}

	private async toDto(record: WorkspaceRecord): Promise<WorkspaceDto> {
		let available = false;
		try {
			available = (await fs.promises.stat(record.path)).isDirectory();
		} catch {
			available = false;
		}
		return {
			workspaceId: record.workspaceId,
			path: record.path,
			name: record.name,
			available,
			lastOpenedAt: record.lastOpenedAt,
			isGitRepo: record.isGitRepo,
		};
	}

	async get(workspaceId: string): Promise<WorkspaceDto | undefined> {
		await this.load();
		const record = this.records.find((item) => item.workspaceId === workspaceId);
		return record ? this.toDto(record) : undefined;
	}

	async require(workspaceId: string): Promise<WorkspaceDto> {
		const dto = await this.get(workspaceId);
		if (!dto) {
			throw new WorkspaceError("UNKNOWN_WORKSPACE", "Este projeto não está mais no cadastro. Abra a pasta novamente.");
		}
		if (!dto.available) {
			throw new WorkspaceError(
				"UNKNOWN_WORKSPACE",
				`A pasta do projeto não está disponível (${dto.path}). Use "Localizar novamente" ou abra outra pasta.`,
			);
		}
		return dto;
	}

	async add(inputPath: string): Promise<WorkspaceDto> {
		await this.load();
		const real = await realDirectory(inputPath);
		const key = pathKey(real);
		const existing = this.records.find((item) => pathKey(item.path) === key);
		const isGit = await isGitRepo(real);
		if (existing) {
			existing.path = real;
			existing.name = displayName(real);
			existing.lastOpenedAt = Date.now();
			existing.isGitRepo = isGit;
			await this.persist();
			return this.toDto(existing);
		}
		const record: WorkspaceRecord = {
			workspaceId: workspaceIdFor(real),
			path: real,
			name: displayName(real),
			lastOpenedAt: Date.now(),
			isGitRepo: isGit,
		};
		this.records.push(record);
		await this.persist();
		return this.toDto(record);
	}

	async relocate(workspaceId: string, inputPath: string): Promise<WorkspaceDto> {
		await this.load();
		const record = this.records.find((item) => item.workspaceId === workspaceId);
		if (!record) {
			throw new WorkspaceError("UNKNOWN_WORKSPACE", "Este projeto não está mais no cadastro.");
		}
		const real = await realDirectory(inputPath);
		record.path = real;
		record.name = displayName(real);
		record.lastOpenedAt = Date.now();
		record.isGitRepo = await isGitRepo(real);
		await this.persist();
		return this.toDto(record);
	}

	async removeRecent(workspaceId: string): Promise<void> {
		await this.load();
		this.records = this.records.filter((item) => item.workspaceId !== workspaceId);
		await this.persist();
	}
}

export class WorkspaceError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "WorkspaceError";
	}
}
