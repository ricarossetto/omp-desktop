import { APPROVAL_MODES, isApprovalMode } from "@shared/session-types";
import { Icon } from "../../components/Icon";
import { useT } from "../../i18n";
import { useActions, useStore } from "../../store/context";
import { approvalModeDescription, approvalModeLabel } from "../approval/approval-mode";
import "./settings.css";

/** Padrão global e override por projeto do `--approval-mode` do OMP. */
export function ApprovalsTab() {
	const t = useT();
	const actions = useActions();
	const approval = useStore((state) => state.approval);
	const workspaces = useStore((state) => state.workspaces);

	return (
		<section className="omp-settings-section" aria-labelledby="omp-approvals-title">
			<h3 id="omp-approvals-title">{t("approval.settingsTitle")}</h3>
			<p className="omp-muted">{t("approval.settingsBody")}</p>

			<h4>{t("approval.defaultTitle")}</h4>
			<p className="omp-muted">{t("approval.defaultHint")}</p>
			<div className="omp-approval-modes" role="radiogroup" aria-label={t("approval.defaultTitle")}>
				{APPROVAL_MODES.map((mode) => (
					<button
						key={mode}
						type="button"
						role="radio"
						aria-checked={approval.default === mode}
						className={`omp-approval-card${approval.default === mode ? " is-active" : ""}${
							mode === "yolo" ? " is-warn" : ""
						}`}
						onClick={() => void actions.setApprovalMode(mode, { global: true })}
					>
						<span className="omp-approval-card__title">
							<Icon
								name={approval.default === mode ? "check" : "shield"}
								className="icon--sm"
							/>
							{approvalModeLabel(mode, t)}
						</span>
						<span className="omp-approval-card__hint">
							{approvalModeDescription(mode, t)}
						</span>
					</button>
				))}
			</div>

			<h4>{t("approval.projectsTitle")}</h4>
			<p className="omp-muted">{t("approval.projectsHint")}</p>
			{workspaces.length === 0 ? (
				<p className="omp-muted">{t("approval.noProjects")}</p>
			) : (
				<ul className="omp-approval-projects">
					{workspaces.map((workspace) => {
						const override = approval.projects[workspace.workspaceId];
						return (
							<li key={workspace.workspaceId} className="omp-approval-project">
								<span className="omp-approval-project__name" title={workspace.path}>
									{workspace.name}
								</span>
								<select
									value={override ?? ""}
									aria-label={workspace.name}
									onChange={(event) => {
										const value = event.target.value;
										if (value === "") {
											void actions.setApprovalMode(null, {
												workspaceId: workspace.workspaceId,
											});
											return;
										}
										if (isApprovalMode(value)) {
											void actions.setApprovalMode(value, {
												workspaceId: workspace.workspaceId,
											});
										}
									}}
								>
									<option value="">{t("approval.useDefault")}</option>
									{APPROVAL_MODES.map((mode) => (
										<option key={mode} value={mode}>
											{approvalModeLabel(mode, t)}
										</option>
									))}
								</select>
							</li>
						);
					})}
				</ul>
			)}

			<p className="omp-muted text-xs">{t("approval.restartHint")}</p>
			{approval.default === "yolo" || Object.values(approval.projects).includes("yolo") ? (
				<p className="omp-approval-warning">
					<Icon name="warning" className="icon--sm" /> {t("approval.yoloWarning")}
				</p>
			) : null}
		</section>
	);
}
