import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, subscribe } from "../../api";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n";
import { StatusIcon } from "../agents/StatusIcon";
import { errorText, isRecord, unwrapRpcData } from "../agents/ui-utils";
import {
	normalizeLoginProviders,
	normalizeLogoutAccounts,
	normalizeUsage,
	type LoginProviderView,
	type LogoutAccountView,
	type UsageAccountView,
	type UsageView,
	type UsageWindowView,
} from "../settings/config";
import { filterProviders, isEventForSession, matchesAccountQuery, redactUrlForDisplay } from "./accounts-filter";
import "./accounts.css";

interface ProviderAccountsState {
	loading: boolean;
	error?: string;
	accounts: LogoutAccountView[];
}

interface OpenUrlRequest {
	url: string;
	displayUrl: string;
	instructions?: string;
}

function safeHttpUrl(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
		return parsed.toString();
	} catch {
		return undefined;
	}
}

function isTerminalLoginError(message: string): boolean {
	return /secret input|interactive prompts|terminal UI|not supported in RPC/i.test(message);
}

function percentTone(percent: number | undefined): "normal" | "warning" | "error" {
	if (percent === undefined) return "normal";
	if (percent >= 100) return "error";
	if (percent >= 80) return "warning";
	return "normal";
}

function UsageWindowRow({ window }: { window: UsageWindowView }) {
	const { t, formatDate, formatPercent } = useI18n();
	const tone = percentTone(window.usedPercent);
	const label = window.label || t("accounts.windowFallback");
	const width =
		window.usedPercent === undefined ? 0 : Math.max(0, Math.min(100, window.usedPercent));
	return (
		<div className={`omp-usage-window omp-usage-${tone}`}>
			<div className="omp-usage-window-head">
				<span>{label}</span>
				<span className="omp-usage-percent">
					{window.usedPercent === undefined ? t("common.unavailable") : formatPercent(window.usedPercent)}
				</span>
			</div>
			{window.usedPercent === undefined ? null : (
				<div
					className="omp-usage-bar"
					role="meter"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.min(100, Math.round(window.usedPercent))}
					aria-label={t("accounts.windowUsage", { label })}
				>
					<span className={`omp-usage-fill omp-usage-fill-${tone}`} style={{ width: `${width}%` }} />
				</div>
			)}
			{window.resetsAt ? (
				<span className="omp-muted">
					{t("accounts.resetsAt", { date: formatDate(window.resetsAt) ?? t("common.unavailable") })}
				</span>
			) : null}
		</div>
	);
}

function UsageAccount({ account, providerLabel }: { account: UsageAccountView; providerLabel: string }) {
	const { t } = useI18n();
	return (
		<div className="omp-usage-account">
			<div className="omp-usage-account-head">
				<span>{account.label ?? providerLabel}</span>
				{account.active ? <span className="omp-badge">{t("accounts.active")}</span> : null}
			</div>
			{account.detail ? <p className="omp-muted">{account.detail}</p> : null}
			{account.windows.length === 0 ? (
				<p className="omp-muted">{t("accounts.accountUnavailable")}</p>
			) : (
				account.windows.map((window, index) => (
					<UsageWindowRow key={`${window.label}-${index}`} window={window} />
				))
			)}
		</div>
	);
}

export function AccountsTab({ workspaceId, sessionId }: { workspaceId: string; sessionId?: string }) {
	const { t, formatDate } = useI18n();
	const [query, setQuery] = useState("");
	const [providers, setProviders] = useState<LoginProviderView[]>([]);
	const [providersLoading, setProvidersLoading] = useState(Boolean(sessionId));
	const [providersError, setProvidersError] = useState<string | null>(null);
	const [usage, setUsage] = useState<UsageView | null>(null);
	const [usageLoading, setUsageLoading] = useState(true);
	const [usageError, setUsageError] = useState<string | null>(null);
	const [accountsByProvider, setAccountsByProvider] = useState<Record<string, ProviderAccountsState>>({});
	const [pendingLogin, setPendingLogin] = useState<LoginProviderView | null>(null);
	const [loginBusy, setLoginBusy] = useState<string | null>(null);
	const [loginMessage, setLoginMessage] = useState<{
		level: "success" | "warning" | "error";
		text: string;
	} | null>(null);
	const [openUrls, setOpenUrls] = useState<OpenUrlRequest[]>([]);
	const [terminalGuidance, setTerminalGuidance] = useState<string | null>(null);
	const [confirmLogout, setConfirmLogout] = useState<string | null>(null);
	const [logoutBusy, setLogoutBusy] = useState<string | null>(null);
	const [accountError, setAccountError] = useState<string | null>(null);
	const [copiedCommand, setCopiedCommand] = useState(false);
	const loginSubscriptionRef = useRef<(() => void) | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);

	const loadProviders = useCallback(async () => {
		if (!sessionId) {
			setProviders([]);
			setProvidersLoading(false);
			return;
		}
		setProvidersLoading(true);
		setProvidersError(null);
		try {
			const raw = await invoke({
				op: "session.rpc",
				workspaceId,
				sessionId,
				command: { type: "get_login_providers" },
			});
			setProviders(normalizeLoginProviders(unwrapRpcData(raw)));
		} catch (error) {
			setProvidersError(errorText(error));
		} finally {
			setProvidersLoading(false);
		}
	}, [sessionId, workspaceId]);

	const loadUsage = useCallback(async () => {
		setUsageLoading(true);
		setUsageError(null);
		try {
			const raw = await invoke({ op: "account.usage", workspaceId });
			setUsage(normalizeUsage(raw));
		} catch (error) {
			setUsageError(errorText(error));
		} finally {
			setUsageLoading(false);
		}
	}, [workspaceId]);

	useEffect(() => {
		void loadProviders();
	}, [loadProviders]);

	useEffect(() => {
		void loadUsage();
	}, [loadUsage]);

	useEffect(() => {
		searchRef.current?.focus();
	}, []);

	useEffect(
		() => () => {
			loginSubscriptionRef.current?.();
			loginSubscriptionRef.current = null;
		},
		[],
	);

	const loadAccounts = useCallback(
		async (provider: LoginProviderView) => {
			if (!sessionId) return;
			setAccountsByProvider(previous => ({
				...previous,
				[provider.id]: { loading: true, accounts: previous[provider.id]?.accounts ?? [] },
			}));
			try {
				const raw = await invoke({
					op: "session.rpc",
					workspaceId,
					sessionId,
					command: { type: "get_logout_accounts", providerId: provider.id },
				});
				setAccountsByProvider(previous => ({
					...previous,
					[provider.id]: { loading: false, accounts: normalizeLogoutAccounts(unwrapRpcData(raw)) },
				}));
			} catch (error) {
				setAccountsByProvider(previous => ({
					...previous,
					[provider.id]: {
						loading: false,
						error: errorText(error),
						accounts: previous[provider.id]?.accounts ?? [],
					},
				}));
			}
		},
		[sessionId, workspaceId],
	);

	// A busca promete nome/e-mail/plano/id: carregue as contas de todos os
	// provedores antes de filtrar, não só as que já foram expandidas.
	useEffect(() => {
		if (!sessionId || query.trim().length === 0) return;
		for (const provider of providers) {
			if (!accountsByProvider[provider.id]) void loadAccounts(provider);
		}
	}, [accountsByProvider, loadAccounts, providers, query, sessionId]);

	const toggleAccounts = (provider: LoginProviderView) => {
		setAccountError(null);
		setConfirmLogout(null);
		const current = accountsByProvider[provider.id];
		if (current) {
			setAccountsByProvider(previous => {
				const next = { ...previous };
				delete next[provider.id];
				return next;
			});
			return;
		}
		void loadAccounts(provider);
	};

	const beginLogin = async (provider: LoginProviderView) => {
		if (!sessionId) return;
		setPendingLogin(null);
		setLoginBusy(provider.id);
		setLoginMessage(null);
		setTerminalGuidance(null);
		setOpenUrls([]);
		setCopiedCommand(false);
		loginSubscriptionRef.current?.();
		loginSubscriptionRef.current = subscribe(event => {
			// Outra sessão do mesmo projeto não pode injetar URLs de login aqui.
			if (!isEventForSession(event, workspaceId, sessionId)) return;
			if (event.name !== "frame" || !isRecord(event.data)) return;
			const frame = event.data;
			if (frame.type !== "extension_ui_request" || frame.method !== "open_url") return;
			const url = safeHttpUrl(typeof frame.url === "string" ? frame.url : undefined)
				?? safeHttpUrl(typeof frame.launchUrl === "string" ? frame.launchUrl : undefined);
			if (!url) return;
			const instructions = typeof frame.instructions === "string" ? frame.instructions : undefined;
			setOpenUrls(previous =>
				previous.some(item => item.url === url)
					? previous
					: [...previous, { url, displayUrl: redactUrlForDisplay(url), instructions }],
			);
		});
		try {
			await invoke({
				op: "session.rpc",
				workspaceId,
				sessionId,
				command: { type: "login", providerId: provider.id },
			});
			setLoginMessage({
				level: "success",
				text: t("accounts.loginSuccess", { provider: provider.name }),
			});
			setOpenUrls([]);
			setTerminalGuidance(null);
			setAccountsByProvider(previous => {
				const next = { ...previous };
				delete next[provider.id];
				return next;
			});
			await loadProviders();
			await loadUsage();
		} catch (error) {
			const message = errorText(error);
			setLoginMessage({
				level: "error",
				text: t("accounts.loginError", { provider: provider.name, message }),
			});
			if (isTerminalLoginError(message)) {
				setTerminalGuidance(`omp login ${provider.id}`);
			}
		} finally {
			loginSubscriptionRef.current?.();
			loginSubscriptionRef.current = null;
			setLoginBusy(null);
		}
	};

	const openAuthorizeUrl = async (url: string) => {
		try {
			await invoke({ op: "runtime.openExternal", url });
		} catch (error) {
			setLoginMessage({
				level: "error",
				text: t("accounts.openBrowserError", { message: errorText(error) }),
			});
		}
	};

	const copyCommand = async (command: string) => {
		try {
			await navigator.clipboard.writeText(command);
			setCopiedCommand(true);
		} catch {
			setLoginMessage({
				level: "warning",
				text: t("accounts.copyError"),
			});
		}
	};

	const disconnect = async (provider: LoginProviderView, account: LogoutAccountView) => {
		if (!sessionId) return;
		const key = `${provider.id}:${account.credentialId}`;
		setLogoutBusy(key);
		setAccountError(null);
		try {
			await invoke({
				op: "session.rpc",
				workspaceId,
				sessionId,
				command: {
					type: "logout",
					providerId: provider.id,
					credentialId: account.credentialId,
				},
			});
			setConfirmLogout(null);
			await loadAccounts(provider);
			await loadProviders();
			await loadUsage();
		} catch (error) {
			setAccountError(t("accounts.logoutError", { account: account.label, message: errorText(error) }));
		} finally {
			setLogoutBusy(null);
		}
	};

	const filteredUsageProviders = useMemo(() => {
		const needle = query.trim();
		if (!needle || !usage) return usage?.providers ?? [];
		return usage.providers
			.map((provider) => {
				const providerMatches = matchesAccountQuery(needle, [provider.providerId, provider.label]);
				if (providerMatches) return provider;
				const accounts = provider.accounts.filter((account) =>
					matchesAccountQuery(needle, [account.credentialId, account.label, account.detail]),
				);
				return { ...provider, accounts };
			})
			.filter((provider) => provider.accounts.length > 0);
	}, [query, usage]);

	const filteredProviders = useMemo(
		() =>
			filterProviders(providers, query, (providerId) => accountsByProvider[providerId]?.accounts ?? []),
		[accountsByProvider, providers, query],
	);

	const clearSearch = () => {
		setQuery("");
		searchRef.current?.focus();
	};
	const accountsNoMatch = query.trim().length > 0;

	return (
		<div className="omp-accounts">
			<div className="omp-accounts-search">
				<Icon name="search" className="omp-icon" />
				<input
					ref={searchRef}
					type="search"
					data-omp-escape-local={query.length > 0 ? true : undefined}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						// Esc limpa a busca quando há texto; vazia, deixa o Esc fechar a tela.
						if (event.key !== "Escape" || query.length === 0) return;
						event.preventDefault();
						event.stopPropagation();
						clearSearch();
					}}
					placeholder={t("accounts.searchPlaceholder")}
					aria-label={t("accounts.searchLabel")}
				/>
				{query.length > 0 ? (
					<button
						type="button"
						className="omp-icon-button"
						onClick={clearSearch}
						aria-label={t("accounts.clearSearch")}
					>
						×
					</button>
				) : null}
			</div>
			<section className="omp-accounts-section" aria-labelledby="omp-usage-title">
				<div className="omp-accounts-head">
					<div>
						<h2 id="omp-usage-title">{t("accounts.usageTitle")}</h2>
						<p className="omp-muted">{t("accounts.usageLead")}</p>
					</div>
					<button
						type="button"
						className="omp-button omp-button-small"
						onClick={() => void loadUsage()}
						disabled={usageLoading}
					>
						{usageLoading ? t("accounts.refreshing") : t("accounts.refreshUsage")}
					</button>
				</div>
				{usageError ? (
					<div className="omp-message omp-message-error" role="alert">
						<StatusIcon kind="error" />
						<span>{t("accounts.usageError", { message: usageError })}</span>
						<button type="button" className="omp-button omp-button-small" onClick={() => void loadUsage()}>
							{t("common.retry")}
						</button>
					</div>
				) : null}
				{usageLoading && !usage ? <p className="omp-muted">{t("accounts.usageLoading")}</p> : null}
				{usage ? (
					<>
						<p className="omp-muted">
							{t("accounts.usageUpdated", {
								date: formatDate(usage.updatedAt) ?? t("common.unavailable"),
							})}{" "}
							· {t("accounts.oauthNote")}
						</p>
						{usage.unknown || usage.providers.length === 0 ? (
							<div className="omp-accounts-empty">
								<StatusIcon kind="info" size={20} />
								<p>{t("accounts.usageUnknown")}</p>
							</div>
						) : filteredUsageProviders.length === 0 && accountsNoMatch ? (
							<div className="omp-accounts-empty">
								<StatusIcon kind="empty" size={20} />
								<p>{t("accounts.noMatch", { query: query.trim() })}</p>
							</div>
						) : (
							filteredUsageProviders.map(provider => (
								<section key={provider.providerId} className="omp-usage-provider" aria-label={provider.providerId}>
									<h3>{provider.label ?? provider.providerId}</h3>
									{provider.accounts.map((account, index) => (
										<UsageAccount
											key={`${provider.providerId}-${index}`}
											account={account}
											providerLabel={provider.label ?? provider.providerId}
										/>
									))}
								</section>
							))
						)}
					</>
				) : null}
			</section>

			<section className="omp-accounts-section" aria-labelledby="omp-providers-title">
				<div className="omp-accounts-head">
					<div>
						<h2 id="omp-providers-title">{t("accounts.providersTitle")}</h2>
						<p className="omp-muted">{t("accounts.providersLead")}</p>
					</div>
					<button
						type="button"
						className="omp-button omp-button-small"
						onClick={() => void loadProviders()}
						disabled={!sessionId || providersLoading}
					>
						{providersLoading ? t("accounts.refreshing") : t("accounts.refreshProviders")}
					</button>
				</div>

				{!sessionId ? (
					<p className="omp-message omp-message-info" role="status">
						<StatusIcon kind="info" /> {t("accounts.sessionRequired")}
					</p>
				) : null}
				{providersError ? (
					<div className="omp-message omp-message-error" role="alert">
						<StatusIcon kind="error" />
						<span>{t("accounts.providersError", { message: providersError })}</span>
					</div>
				) : null}
				{providersLoading && providers.length === 0 ? (
					<p className="omp-muted">{t("accounts.providersLoading")}</p>
				) : null}
				{providers.length === 0 && !providersLoading && sessionId ? (
					<div className="omp-accounts-empty">
						<StatusIcon kind="empty" size={20} />
						<p>{t("accounts.providersEmpty")}</p>
					</div>
				) : null}
				{accountsNoMatch && filteredProviders.length === 0 && providers.length > 0 ? (
					<div className="omp-accounts-empty">
						<StatusIcon kind="empty" size={20} />
						<p>{t("accounts.noMatch", { query: query.trim() })}</p>
					</div>
				) : null}

				{loginMessage ? (
					<div
						className={`omp-message omp-message-${loginMessage.level}`}
						role={loginMessage.level === "error" ? "alert" : "status"}
					>
						<StatusIcon
							kind={
								loginMessage.level === "success"
									? "success"
									: loginMessage.level === "warning"
										? "warning"
										: "error"
							}
						/>
						<span>{loginMessage.text}</span>
					</div>
				) : null}

				{openUrls.length > 0 ? (
					<div className="omp-open-url-panel" role="group" aria-label={t("accounts.browserAuthTitle")}>
						<h3>{t("accounts.browserAuthTitle")}</h3>
						<p className="omp-muted">{t("accounts.browserAuthBody")}</p>
						{openUrls.map(item => (
							<div key={item.url} className="omp-open-url-row">
								<code>{item.displayUrl}</code>
								{item.instructions ? <p className="omp-muted">{item.instructions}</p> : null}
								<button
									type="button"
									className="omp-button omp-button-small omp-button-primary"
									onClick={() => void openAuthorizeUrl(item.url)}
								>
									{t("accounts.openBrowser")}
								</button>
							</div>
						))}
					</div>
				) : null}

				{terminalGuidance ? (
					<div className="omp-terminal-guidance" role="group" aria-label={t("accounts.terminalLoginLabel")}>
						<h3>{t("accounts.terminalLoginTitle")}</h3>
						<p>{t("accounts.terminalLoginBody")}</p>
						<pre>{terminalGuidance}</pre>
						<div className="omp-row">
							<button
								type="button"
								className="omp-button omp-button-small"
								onClick={() => void copyCommand(terminalGuidance)}
							>
								{copiedCommand ? t("common.copied") : t("accounts.copyCommand")}
							</button>
							<button type="button" className="omp-button omp-button-small" onClick={() => setTerminalGuidance(null)}>
								{t("common.close")}
							</button>
						</div>
					</div>
				) : null}

				{pendingLogin ? (
					<div className="omp-login-consent" role="group" aria-label={t("accounts.loginConfirmLabel")}>
						<h3>{t("accounts.loginConfirmTitle", { provider: pendingLogin.name })}</h3>
						<p>{t("accounts.loginConfirmBody")}</p>
						<div className="omp-row">
							<button
								type="button"
								className="omp-button omp-button-primary"
								onClick={() => {
									if (pendingLogin) void beginLogin(pendingLogin);
								}}
								disabled={loginBusy !== null}
							>
								{t("accounts.continue")}
							</button>
							<button type="button" className="omp-button" onClick={() => setPendingLogin(null)}>
								{t("common.cancel")}
							</button>
						</div>
					</div>
				) : null}

				<ul className="omp-provider-list">
					{filteredProviders.map(provider => {
						const accountsState = accountsByProvider[provider.id];
						const providerMatches = matchesAccountQuery(query, [provider.id, provider.name]);
						const visibleAccounts =
							accountsState && accountsNoMatch && !providerMatches
								? accountsState.accounts.filter(account =>
										matchesAccountQuery(query, [
											account.credentialId,
											account.label,
											account.detail,
											account.type,
										]),
									)
								: (accountsState?.accounts ?? []);
						return (
							<li key={provider.id} className="omp-provider-card">
								<div className="omp-provider-head">
									<div>
										<p className="omp-provider-name">{provider.name}</p>
										<p className="omp-muted">{provider.id}</p>
									</div>
									<div className="omp-row">
										<span className="omp-badge">
											{provider.authenticated ? t("accounts.connected") : t("accounts.noAccount")}
										</span>
										{!provider.available ? <span className="omp-badge">{t("common.unavailable")}</span> : null}
									</div>
								</div>
								<div className="omp-row omp-row-wrap">
									<button
										type="button"
										className="omp-button omp-button-small omp-button-primary"
										onClick={() => {
											setPendingLogin(provider);
											setLoginMessage(null);
											setTerminalGuidance(null);
										}}
										disabled={!sessionId || loginBusy !== null || !provider.available}
										title={!provider.available ? t("accounts.providerUnavailableHint") : undefined}
									>
										{loginBusy === provider.id ? t("accounts.waitingAuth") : t("accounts.addAccount")}
									</button>
									{provider.authenticated ? (
										<button
											type="button"
											className="omp-button omp-button-small"
											onClick={() => toggleAccounts(provider)}
										>
											{accountsState ? t("accounts.hideAccounts") : t("accounts.manageAccounts")}
										</button>
									) : null}
								</div>

								{accountsState ? (
									<div className="omp-provider-accounts">
										{accountError ? (
											<p className="omp-message omp-message-error" role="alert">
												<StatusIcon kind="error" /> {accountError}
											</p>
										) : null}
										{accountsState.loading ? <p className="omp-muted">{t("accounts.accountsLoading")}</p> : null}
										{accountsState.error ? (
											<p className="omp-message omp-message-error" role="alert">
												<StatusIcon kind="error" /> {accountsState.error}
											</p>
										) : null}
										{!accountsState.loading && visibleAccounts.length === 0 ? (
											<p className="omp-muted">
												{accountsNoMatch && !providerMatches
													? t("accounts.noMatch", { query: query.trim() })
													: t("accounts.accountsEmpty")}
											</p>
										) : null}
										{visibleAccounts.map(account => {
											const key = `${provider.id}:${account.credentialId}`;
											return (
												<div key={key} className="omp-account-row">
													<div>
														<p>{account.label}</p>
														{account.detail ? <p className="omp-muted">{account.detail}</p> : null}
														<p className="omp-muted">
															{account.type === "oauth"
																? t("accounts.typeOauth")
																: account.type === "api_key"
																	? t("accounts.typeApiKey")
																	: t("accounts.typeAccount")}
															{account.active ? ` · ${t("accounts.inUse")}` : ""}
														</p>
													</div>
													{confirmLogout === key ? (
														<div className="omp-inline-confirm" role="group" aria-label={t("accounts.logoutConfirmLabel")}>
															<span>{t("accounts.logoutConfirm")}</span>
															<button
																type="button"
																className="omp-button omp-button-small omp-button-danger"
																onClick={() => void disconnect(provider, account)}
																disabled={logoutBusy === key}
															>
																{logoutBusy === key ? t("accounts.loggingOut") : t("common.confirm")}
															</button>
															<button
																type="button"
																className="omp-button omp-button-small"
																onClick={() => setConfirmLogout(null)}
																disabled={logoutBusy === key}
															>
																{t("common.cancel")}
															</button>
														</div>
													) : (
														<button
															type="button"
															className="omp-button omp-button-small omp-button-danger"
															onClick={() => {
																setConfirmLogout(key);
																setAccountError(null);
															}}
															disabled={logoutBusy !== null}
														>
															{t("accounts.disconnect")}
														</button>
													)}
												</div>
											);
										})}
									</div>
								) : null}
							</li>
						);
					})}
				</ul>
			</section>
		</div>
	);
}
