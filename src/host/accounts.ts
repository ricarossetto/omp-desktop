/**
 * Contas/cotas via `omp usage --json`.
 *
 * O DTO nunca contém tokens, cabeçalhos, apiKey, baseUrl ou providerPayload.
 * Uso desconhecido permanece desconhecido (nunca vira 0%).
 */
import { parseJsonOutput, runOmp, type RunOmpResult } from "./omp-cli";
import { projectUsage, type AccountUsageDto } from "./sanitize";

export interface AccountUsageContext {
	ompPath: string;
	cwd: string;
	/** Ambiente extra repassado ao OMP (testes/fixtures); produção herda o do host. */
	env?: Record<string, string | undefined>;
}

export class AccountError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "AccountError";
	}
}

/** Busca cotas sem renovar/drenar contas. O navegador/OAuth fica na sessão RPC. */
export async function readAccountUsage(context: AccountUsageContext): Promise<AccountUsageDto> {
	let result: RunOmpResult;
	try {
		result = await runOmp(context.ompPath, ["usage", "--json"], {
			cwd: context.cwd,
			timeoutMs: 180_000,
			env: context.env,
		});
	} catch (error) {
		throw new AccountError(
			"OMP_UNAVAILABLE",
			`Não foi possível executar o OMP para consultar as contas: ${(error as Error).message}`,
		);
	}
	const parsed = parseJsonOutput(result.stdout);
	if (parsed === undefined) {
		if (result.timedOut) {
			throw new AccountError(
				"INTERNAL",
				"O OMP demorou demais para consultar as cotas. Tente novamente em alguns instantes.",
			);
		}
		const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 400);
		throw new AccountError(
			"OMP_UNAVAILABLE",
			`Não foi possível consultar as contas no OMP${detail.length > 0 ? `: ${detail}` : "."}`,
		);
	}
	return projectUsage(parsed);
}
