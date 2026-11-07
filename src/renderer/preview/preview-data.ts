/**
 * PREVIEW — dados fictícios usados apenas em desenvolvimento com `?preview=1`.
 * Nunca é carregado pelo store real nem exibido em produção.
 */
import type { SessionListItem, WorkspaceDto } from "@shared/contracts";
import type { ChatMessage, SessionViewState } from "@shared/session-types";
import { DEFAULT_LAYOUT, type AppState } from "../store/state";

const now = Date.now();

export const PREVIEW_WORKSPACE: WorkspaceDto = {
	workspaceId: "preview-workspace",
	path: "C:\\dev\\app",
	name: "omp-desktop",
	available: true,
	lastOpenedAt: now - 3 * 60_000,
	isGitRepo: true,
};

const previewSessions: SessionListItem[] = [
	{
		path: "C:\\sessions\\preview-active.jsonl",
		id: "preview-active",
		title: "Revisão do transporte RPC",
		cwd: PREVIEW_WORKSPACE.path,
		model: "deepseek-v4.1-flash",
		modified: now - 2 * 60_000,
		messageCount: 8,
		openSessionId: "preview-session",
	},
	{
		path: "C:\\sessions\\preview-locked.jsonl",
		id: "preview-locked",
		title: "Migração do sidecar",
		cwd: PREVIEW_WORKSPACE.path,
		modified: now - 3 * 60 * 60_000,
		messageCount: 42,
		locked: true,
	},
	{
		path: "C:\\sessions\\preview-free.jsonl",
		id: "preview-free",
		title: "Ajustes de acessibilidade",
		cwd: PREVIEW_WORKSPACE.path,
		modified: now - 26 * 60 * 60_000,
		messageCount: 17,
	},
];

function messages(): ChatMessage[] {
	return [
		{
			key: "entry:preview-1",
			entryId: "preview-1",
			role: "user",
			content: [
				{
					type: "text",
					text: "Revise o transporte entre o main e o host Bun. Quero saber se a sequência de eventos detecta lacunas e se o custo vem de get_session_stats.",
				},
			],
			timestamp: now - 8 * 60_000,
			streaming: false,
		},
		{
			key: "entry:preview-2",
			entryId: "preview-2",
			role: "assistant",
			model: "deepseek-v4.1-flash",
			provider: "exemplo",
			timestamp: now - 7 * 60_000,
			streaming: false,
			content: [
				{
					type: "thinking",
					thinking:
						"Verifico primeiro o decoder oficial e depois confiro se o renderer reaplica eventos fora de ordem.",
				},
				{
					type: "text",
					text: "O transporte está **estruturado** em três camadas:\n\n1. `Electron main` fala com o host por JSONL;\n2. o host mantém o processo `omp --mode rpc-ui`;\n3. o renderer só consome `window.ompDesktop`.\n\nA detecção de lacuna usa `sequence` por sessão e geração. Custo aparece como estimativa, nunca como débito.",
				},
				{
					type: "toolCall",
					id: "preview-tool-1",
					name: "bash",
					intent: "Conferir arquivos do host",
					arguments: { command: "ls src/host", description: "Lista os módulos do host" },
				},
			],
		},
		{
			key: "live:preview-assistant-3",
			role: "assistant",
			model: "deepseek-v4.1-flash",
			provider: "exemplo",
			timestamp: now - 30_000,
			streaming: true,
			content: [
				{
					type: "text",
					text: "Também vale registrar que `agent_end` com `isTerminal: false` não significa sessão ociosa. Por isso a barra superior consulta `isSettled` e `hasPendingAsyncWork` antes de dizer que a sessão está pronta.",
				},
			],
		},
	];
}

export function previewSessionState(withDialogs = false): SessionViewState {
	return {
		workspaceId: PREVIEW_WORKSPACE.workspaceId,
		sessionId: "preview-session",
		generation: 2,
		sequence: 42,
		status: "busy",
		messages: messages(),
		tools: {
			"preview-tool-1": {
				toolCallId: "preview-tool-1",
				name: "bash",
				arguments: { command: "ls src/host", description: "Lista os módulos do host" },
				intent: "Conferir arquivos do host",
				status: "done",
				resultText:
					"index.ts\nomp-transport.ts\nsessions.ts\nsettings.ts\nworkspaces.ts\n... (saída fictícia de preview)",
			},
			"preview-tool-2": {
				toolCallId: "preview-tool-2",
				name: "read",
				arguments: { path: "src/shared/contracts.ts" },
				status: "running",
				partialText: "Lendo contracts.ts...",
			},
		},
		queue: {
			steering: ["Inclua o caso de eventos duplicados no relatório."],
			followUp: ["Depois, rode os testes de sessão."],
			liveSteered: 1,
		},
		meta: {
			model: { provider: "exemplo", id: "deepseek-v4.1-flash", name: "DeepSeek V4 Flash" },
			thinkingLevel: "medium",
			isStreaming: true,
			isCompacting: false,
			isSettled: false,
			hasPendingAsyncWork: true,
			sessionName: "Revisão do transporte RPC",
			messageCount: 3,
			contextPercent: 3.2,
			contextTokens: 6400,
			contextWindow: 200_000,
			todoPhases: [
				{
					name: "Transporte",
					tasks: [
						{ content: "Validar sequência", status: "completed" },
						{ content: "Revisar custo", status: "in_progress" },
					],
				},
			],
			goal: null,
		},
		commands: [
			{ name: "compact", description: "Compactar o contexto da conversa" },
			{ name: "modelpreset", description: "Aplicar um preset de modelos", inputHint: "<nome>" },
			{ name: "clear", description: "Limpar a conversa atual" },
		],
		thinkingLevels: ["minimal", "low", "medium", "high"],
		agents: [
			{
				key: "agent-preview-1",
				id: "agent-preview-1",
				agent: "runner",
				description: "Revisar transporte",
				task: "Conferir lacunas de sequência",
				status: "running",
				effectiveModel: "DeepSeek V4 Flash",
				finalized: false,
				lastUpdate: now - 20_000,
			},
			{
				key: "agent-preview-2",
				id: "agent-preview-2",
				agent: "explorer",
				description: "Mapear sessões",
				status: "completed",
				effectiveModel: undefined,
				finalized: true,
				lastUpdate: now - 5 * 60_000,
			},
		],
		pendingDialogs: withDialogs
			? [
					{
						id: "preview-dialog-1",
						method: "select",
						title: "Permitir execução de comando?",
						message: "A ferramenta bash quer executar o comando abaixo no projeto.",
						options: ["Permitir nesta sessão", "Permitir somente agora", "Negar"],
						optionDetails: [
							{ description: "Aprova comandos bash nesta sessão até o fim." },
							{ description: "Aprova apenas esta execução específica." },
							{ description: "O comando não será executado." },
						],
						receivedAt: now,
					},
					{
						id: "preview-dialog-2",
						method: "ask",
						questions: [
							{
								id: "q1",
								question: "Qual estratégia de teste devo usar?",
								header: "Testes",
								options: [
									{ label: "Unitário", description: "Rápido, sem rede" },
									{ label: "Integração", description: "Usa o host de fixture" },
								],
								multi: false,
								recommended: 0,
							},
						],
						receivedAt: now,
					},
				]
			: [],
		prompts: {},
		stats: { costUsd: 0.0234, tokens: { input: 8200, output: 1200, cacheRead: 3000, total: 9400 } },
		notices: [{ level: "info", text: "Evento de preview aplicado; estes dados são fictícios.", at: now }],
	};
}

export function previewAppState(withDialogs = false): AppState {
	return {
		runtime: {
			phase: "ready",
			ompPath: "C:\\Users\\preview\\.bun\\bin\\omp.exe",
			ompVersion: "18.16.0",
			gitVersion: "2.47.1.windows.1",
			dependencies: {
				git: {
					state: "installed",
					kind: "git",
					executablePath: "C:\\Program Files\\Git\\cmd\\git.exe",
					version: "2.47.1",
				},
				node: { state: "missing", kind: "node" },
			},
			shell: "PowerShell",
			bunPath: "C:\\Users\\preview\\AppData\\Local\\OMP Desktop\\bun.exe",
			signed: false,
		},
		runtimeError: null,
		boot: "ready",
		workspaces: [PREVIEW_WORKSPACE],
		workspacesLoaded: true,
		workspacesError: null,
		activeWorkspaceId: PREVIEW_WORKSPACE.workspaceId,
		sessionsByWorkspace: { [PREVIEW_WORKSPACE.workspaceId]: previewSessions },
		sessionsLoading: {},
		sessionsError: {},
		sessionRecords: {
			"preview-session": {
				sessionId: "preview-session",
				workspaceId: PREVIEW_WORKSPACE.workspaceId,
				sessionPath: "C:\\sessions\\preview-active.jsonl",
				title: "Revisão do transporte RPC",
			},
		},
		sessionStates: { "preview-session": previewSessionState(withDialogs) },
		tabs: ["preview-session"],
		activeSessionId: "preview-session",
		drafts: {
			"preview-session": {
				text: "Verifique também o caso de IME no compositor.",
				attachments: [
					{
						attachmentId: "preview-attachment",
						name: "captura.png",
						mimeType: "image/png",
						size: 184_320,
						kind: "image",
					},
				],
			},
		},
		sending: {},
		resyncing: {},
		layout: { ...DEFAULT_LAYOUT, terminalOpen: false, rightOpen: true },
		theme: "dark",
		notices: [],
		settings: { open: false },
		modelPickerOpen: false,
		paletteOpen: false,
	paletteMode: "all",
	locale: "pt-BR",
		restoringTabs: false,
	unreadSessions: [],
		composerFocusNonce: 0,
		rightPanelRequest: 0,
	};
}
