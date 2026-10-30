import type { RiskKind } from "@shared/risk-confirm.ts";
import type { MessageKey } from "../i18n/index.ts";

/** Why a call is looked at (`shared/remote-risk.ts`), in the page's words: the confirmation of a risky call and the guard's log. */
export const RISK_KIND_LABEL: Record<RiskKind, MessageKey> = {
	privilege: "panel.reqRisk_privilege",
	mass_delete: "panel.reqRisk_mass_delete",
	delete_outside: "panel.reqRisk_delete_outside",
	write_outside: "panel.reqRisk_write_outside",
	protected: "panel.reqRisk_protected",
	secret_read: "panel.reqRisk_secret_read",
	force_push: "panel.reqRisk_force_push",
	discard: "panel.reqRisk_discard",
	remote_exec: "panel.reqRisk_remote_exec",
	shell_out: "panel.reqRisk_shell_out",
	permissions: "panel.reqRisk_permissions",
	launchctl: "panel.reqRisk_launchctl",
	osascript: "panel.reqRisk_osascript",
	tunnel: "panel.reqRisk_tunnel",
	global_install: "panel.reqRisk_global_install",
	system: "panel.reqRisk_system",
	remote_tool: "panel.reqRisk_remote_tool",
	unreadable: "panel.reqRisk_unreadable",
};
