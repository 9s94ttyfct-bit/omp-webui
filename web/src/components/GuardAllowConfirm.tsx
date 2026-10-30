import type { BenchPreview } from "@shared/guard-bench.ts";
import type { SettableKind } from "@shared/guard-policy.ts";
import { CircleAlert } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useT } from "../i18n/index.ts";
import { guardApi } from "../lib/guard-api.ts";
import { CAT_NAME } from "../lib/guard-format.ts";
import { Button, Spinner } from "./ui.tsx";

type Tried = { state: "trying" } | { state: "tried"; preview: BenchPreview } | { state: "failed"; error: string };

/**
 * The question before an Allow is applied: the classifier-only benchmark is run on the shipped harmful commands with this
 * kind set to Allow, and the answer is how many of them would then run with no reviewer and no question. Nothing is run
 * (the classifier only reads). Allow cannot be confirmed before that is known: when the benchmark cannot be tried, nothing
 * is changed.
 */
export function AllowConfirm({ kind, onYes, onNo }: { kind: SettableKind; onYes: () => void; onNo: () => void }) {
	const t = useT();
	const [tried, setTried] = useState<Tried>({ state: "trying" });
	const titleId = useId();

	useEffect(() => {
		let alive = true;
		setTried({ state: "trying" });
		guardApi.preview({ [kind]: "allow" }).then(
			(preview) => alive && setTried({ state: "tried", preview }),
			(e) => alive && setTried({ state: "failed", error: e instanceof Error ? e.message : String(e) }),
		);
		return () => {
			alive = false;
		};
	}, [kind]);

	return (
		<div
			role="alertdialog"
			aria-labelledby={titleId}
			className="mt-2 basis-full rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm"
			data-testid="guard-allow-confirm"
			data-kind={kind}
			data-state={tried.state}
		>
			<div id={titleId} className="flex items-start gap-1.5 font-medium">
				<CircleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
				{t("guard.allowConfirmTitle", { category: t(CAT_NAME[kind]) })}
			</div>
			{tried.state === "trying" ? (
				<p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
					<Spinner size={12} /> {t("guard.allowConfirmChecking")}
				</p>
			) : tried.state === "failed" ? (
				<p className="mt-1 text-xs text-danger" role="alert" data-testid="guard-allow-confirm-error">
					{t("guard.allowConfirmFailed", { error: tried.error })}
				</p>
			) : (
				<>
					<p className="mt-1 text-xs font-medium" data-testid="guard-allow-confirm-count">
						{t("guard.allowConfirmBody", { count: tried.preview.after, now: tried.preview.now })}
					</p>
					<p className="mt-1 text-xs text-muted">{t("guard.allowConfirmNote")}</p>
				</>
			)}
			<div className="mt-2 flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="danger"
					data-testid="guard-allow-confirm-yes"
					disabled={tried.state !== "tried"}
					onClick={onYes}
				>
					{t("guard.allowConfirmYes")}
				</Button>
				<Button size="sm" data-testid="guard-allow-confirm-no" onClick={onNo}>
					{t("guard.allowConfirmNo")}
				</Button>
			</div>
		</div>
	);
}
