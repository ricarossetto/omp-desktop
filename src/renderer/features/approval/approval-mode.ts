import type { ApprovalMode } from "@shared/session-types";
import type { MessageKey } from "../../i18n/pt-BR";

/** Rótulo e descrição de cada `--approval-mode` na interface. */
export const APPROVAL_MODE_KEYS: Record<
	ApprovalMode,
	{ label: MessageKey; description: MessageKey }
> = {
	"always-ask": { label: "approval.alwaysAsk", description: "approval.alwaysAskHint" },
	"always-ask-cached": {
		label: "approval.alwaysAskCached",
		description: "approval.alwaysAskCachedHint",
	},
	write: { label: "approval.write", description: "approval.writeHint" },
	yolo: { label: "approval.yolo", description: "approval.yoloHint" },
};

export function approvalModeLabel(mode: ApprovalMode, t: (key: MessageKey) => string): string {
	return t(APPROVAL_MODE_KEYS[mode].label);
}

export function approvalModeDescription(
	mode: ApprovalMode,
	t: (key: MessageKey) => string,
): string {
	return t(APPROVAL_MODE_KEYS[mode].description);
}
