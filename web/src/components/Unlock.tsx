import { CircleAlert, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n/index.ts";
import { Button, WithCode } from "./ui.tsx";

/** Shown when the server requires its access token (see the link it printed at startup). */
export function Unlock() {
	const t = useT();
	const [token, setToken] = useState("");
	const [invalid, setInvalid] = useState(false);
	return (
		<main className="flex h-full items-center justify-center p-6">
			<form
				className="w-full max-w-md rounded-2xl border border-border bg-surface p-6 shadow-xl"
				data-testid="unlock"
				onSubmit={async (e) => {
					e.preventDefault();
					const res = await fetch("/api/auth", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ token: token.trim() }),
					});
					if (res.ok) location.reload();
					else setInvalid(true);
				}}
			>
				<h1 className="mb-3 flex items-center gap-2 text-base font-semibold">
					<LockKeyhole size={18} className="text-accent" /> {t("shell.unlockTitle")}
				</h1>
				<p className="mb-4 text-sm text-muted">
					<WithCode text={t("shell.unlockHelp")} />
				</p>
				<label className="mb-1 block text-xs font-medium" htmlFor="unlock-token">
					{t("shell.unlockTokenLabel")}
				</label>
				<input
					id="unlock-token"
					type="password"
					autoComplete="off"
					aria-invalid={invalid || undefined}
					aria-describedby={invalid ? "unlock-error" : undefined}
					className="mb-2 w-full rounded-lg border border-border bg-bg-soft px-3 py-2 font-mono text-sm outline-none focus:border-faint"
					value={token}
					onChange={(e) => setToken(e.target.value)}
				/>
				{invalid ? (
					<div
						id="unlock-error"
						role="alert"
						data-testid="unlock-error"
						className="mb-3 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
					>
						<CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden /> {t("shell.unlockInvalid")}
					</div>
				) : null}
				<Button variant="primary" type="submit" disabled={!token.trim()} className="w-full">
					{t("shell.unlockSubmit")}
				</Button>
			</form>
		</main>
	);
}
