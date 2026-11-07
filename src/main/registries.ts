/**
 * Registros em memória do main para validar associação de workspace, sessão,
 * terminal e anexo antes de encaminhar qualquer pedido ao host.
 *
 * Módulo puro (sem Electron), testável.
 */
import * as path from "node:path";
import type { AttachmentDto, WorkspaceDto } from "../shared/contracts";

function pathKey(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export class WorkspaceRegistry {
	private readonly byId = new Map<string, WorkspaceDto>();

	add(dto: WorkspaceDto): WorkspaceDto {
		this.byId.set(dto.workspaceId, dto);
		return dto;
	}

	get(workspaceId: string): WorkspaceDto | undefined {
		return this.byId.get(workspaceId);
	}

	has(workspaceId: string): boolean {
		return this.byId.has(workspaceId);
	}

	findByPath(dir: string): WorkspaceDto | undefined {
		const key = pathKey(dir);
		for (const dto of this.byId.values()) {
			if (pathKey(dto.path) === key) return dto;
		}
		return undefined;
	}

	remove(workspaceId: string): void {
		this.byId.delete(workspaceId);
	}

	list(): WorkspaceDto[] {
		return [...this.byId.values()];
	}

	clear(): void {
		this.byId.clear();
	}
}

export interface OpenSessionRecord {
	sessionId: string;
	workspaceId: string;
	sessionPath?: string;
}

export class SessionRegistry {
	private readonly byId = new Map<string, OpenSessionRecord>();
	private readonly authorizedPaths = new Map<string, Set<string>>();

	registerSession(record: OpenSessionRecord): void {
		this.byId.set(record.sessionId, record);
		if (record.sessionPath) this.authorizePath(record.workspaceId, record.sessionPath);
	}

	unregister(sessionId: string): void {
		this.byId.delete(sessionId);
	}

	get(sessionId: string): OpenSessionRecord | undefined {
		return this.byId.get(sessionId);
	}

	has(sessionId: string, workspaceId?: string): boolean {
		const record = this.byId.get(sessionId);
		if (!record) return false;
		return workspaceId === undefined || record.workspaceId === workspaceId;
	}

	setSessionPath(sessionId: string, sessionPath: string): void {
		const record = this.byId.get(sessionId);
		if (!record) return;
		record.sessionPath = sessionPath;
		this.authorizePath(record.workspaceId, sessionPath);
	}

	/** Só sessões que apareceram na listagem do host podem ser abertas. */
	authorizePath(workspaceId: string, sessionPath: string): void {
		let set = this.authorizedPaths.get(workspaceId);
		if (!set) {
			set = new Set<string>();
			this.authorizedPaths.set(workspaceId, set);
		}
		set.add(pathKey(sessionPath));
	}

	isPathAuthorized(workspaceId: string, sessionPath: string): boolean {
		return this.authorizedPaths.get(workspaceId)?.has(pathKey(sessionPath)) ?? false;
	}

	openInWorkspace(workspaceId: string): OpenSessionRecord[] {
		return [...this.byId.values()].filter((record) => record.workspaceId === workspaceId);
	}

	/** Todas as sessões abertas, usada para avisar a UI antes de limpar o registro. */
	list(): OpenSessionRecord[] {
		return [...this.byId.values()];
	}

	findByPath(sessionPath: string): OpenSessionRecord | undefined {
		const key = pathKey(sessionPath);
		for (const record of this.byId.values()) {
			if (record.sessionPath && pathKey(record.sessionPath) === key) return record;
		}
		return undefined;
	}

	clearWorkspace(workspaceId: string): void {
		for (const [id, record] of this.byId) {
			if (record.workspaceId === workspaceId) this.byId.delete(id);
		}
		this.authorizedPaths.delete(workspaceId);
	}

	clearAll(): void {
		this.byId.clear();
		this.authorizedPaths.clear();
	}
}

interface AttachmentRecord {
	workspaceId: string;
	dto: AttachmentDto;
}

export class AttachmentRegistry {
	private readonly byId = new Map<string, AttachmentRecord>();

	add(workspaceId: string, dto: AttachmentDto): AttachmentDto {
		this.byId.set(dto.attachmentId, { workspaceId, dto });
		return dto;
	}

	get(attachmentId: string): AttachmentDto | undefined {
		return this.byId.get(attachmentId)?.dto;
	}

	belongsTo(attachmentId: string, workspaceId: string): boolean {
		return this.byId.get(attachmentId)?.workspaceId === workspaceId;
	}

	workspaceOf(attachmentId: string): string | undefined {
		return this.byId.get(attachmentId)?.workspaceId;
	}

	remove(attachmentId: string): void {
		this.byId.delete(attachmentId);
	}

	clearWorkspace(workspaceId: string): void {
		for (const [id, record] of this.byId) {
			if (record.workspaceId === workspaceId) this.byId.delete(id);
		}
	}

	clearAll(): void {
		this.byId.clear();
	}
}
