import type { ApprovalMode } from "@shared/approval.ts";
import type { GuardOverride } from "@shared/guard.ts";
import type { LiveGuidance, SessionGuidance } from "@shared/model-guidance.ts";
import { lazy, type MutableRefObject, type ReactNode, Suspense } from "react";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import type { PickedModel } from "../lib/new-chat-picks.ts";
import { useApp } from "../store/app.ts";
import type { ModelInfo } from "../store/live.ts";
import { AdvisorToggle } from "./AdvisorToggle.tsx";
import { ApprovalPicker } from "./ApprovalPicker.tsx";
import { ModelPicker, ThinkingPicker } from "./ModelPicker.tsx";
import { ModePicker } from "./ModePicker.tsx";
import { PresetPicker } from "./PresetPicker.tsx";
import { GuardPicker } from "./SessionGuard.tsx";

// Remote computers (the list of Session controls, with the later strings): a chunk of its own, fetched when this one is drawn.
const RemotePicker = lazy(() => import("./SessionRemote.tsx").then((m) => ({ default: m.RemotePicker })));

// The switch for unattended mode (#646) is for a few people some of the time: a chunk of its own, fetched when this one is drawn.
const UnattendedToggle = lazy(() => import("./UnattendedToggle.tsx"));
/**
 * New chat's settings bar, under its composer: preset, model, thinking level and the Full / Light chip (the mode of that
 * process and of the next new chat), a divider, then the conversation's rules: guard, the guidance its main agent is
 * given (#641; its own chunk, as most people never pick one), permission mode, the advisor, unattended mode and the goal. Every one is
 * always shown; a narrow bar shows their icons. They are shown once the warm-up process runs, which is after the first
 * paint, so they are a chunk of their own (`NewChat` fetches it when the warm-up starts) and the menus and popovers they
 * are made of are not in the first load.
 */
// The guidance picker (#641) is off for almost everyone: a chunk of its own, fetched when this one is drawn.
const { Chunk: GuidancePicker } = lazyChunk(() =>
	import("./GuidancePicker.tsx").then((m) => ({ default: m.GuidancePicker })),
);

export function NewChatPickers({
	liveId,
	model,
	thinking,
	onPreset,
	onModel,
	onThinking,
	onApproval,
	onGuard,
	guidance,
	unattended,
	advisor,
	onGuidance,
	guidanceDisabled,
	goal,
}: {
	liveId: string;
	model: ModelInfo | undefined;
	thinking: { selected?: string; resolved?: string };
	onPreset: (preset: string) => void;
	onModel: (model: PickedModel) => void;
	onThinking: (level: string) => void;
	onApproval: (mode: ApprovalMode) => void;
	onGuard: (own: GuardOverride | null) => void;
	guidance: LiveGuidance | null;
	onGuidance: (pick: SessionGuidance | null) => void;
	guidanceDisabled?: boolean;
	/** What New chat has picked of unattended mode (#646): the switch reads it and writes it (a flip is kept for the processes started later). */
	unattended: MutableRefObject<boolean>;
	/** What New chat has picked of the advisor (null: omp's setting): the switch reads it and writes it. */
	advisor: MutableRefObject<boolean | null>;
	/** New chat's own controls (the goal switches), at the end of the bar. */
	goal?: ReactNode;
}) {
	// Two groups, each wrapping as one: the bar breaks between them (the rules under the model's settings, aligned at the
	// left), never inside one while it fits a line. `PickersSkeleton` in NewChat.tsx holds the same groups.
	const group = "inline-flex min-w-0 flex-wrap items-center gap-1";
	// Remote computers: a control only once a computer is saved; its own chunk, so a bar of its width holds its place.
	const remote = useApp((s) => (s.meta?.macs?.length ?? 0) > 0);
	return (
		<>
			<span className={group} data-group="model">
				<PresetPicker liveId={liveId} onPick={onPreset} />
				<ModelPicker liveId={liveId} current={model} onPick={onModel} />
				<ThinkingPicker
					liveId={liveId}
					level={thinking.selected}
					resolved={thinking.resolved}
					current={model}
					onPick={onThinking}
				/>
				<ModePicker />
			</span>
			<span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
			<span className={group} data-group="rules">
				<GuardPicker liveId={liveId} onChange={onGuard} />
				{/* The computers the conversation may run commands on (only once one is saved): picked on the warm-up process, given to a new project's conversation as it starts, never to a later warm-up. */}
				<Suspense
					fallback={
						remote ? (
							<span aria-hidden data-testid="remote-skeleton" className="h-8 shrink-0 rounded-lg bg-hover" />
						) : null
					}
				>
					<RemotePicker liveId={liveId} />
				</Suspense>
				{/* Its own chunk lands after the others: a bar of its width holds its place, so the row does not wrap twice. */}
				<Suspense
					fallback={<span aria-hidden data-testid="guidance-skeleton" className="h-8 shrink-0 rounded-lg bg-hover" />}
				>
					<GuidancePicker value={guidance} liveId={liveId} disabled={guidanceDisabled} onPick={onGuidance} />
				</Suspense>
				<ApprovalPicker liveId={liveId} onChange={onApproval} />
				<AdvisorToggle liveId={liveId} pick={advisor} />
				<Suspense
					fallback={
						<span aria-hidden data-testid="unattended-skeleton" className="h-8 w-8 shrink-0 rounded-lg bg-hover" />
					}
				>
					<UnattendedToggle liveId={liveId} pick={unattended} />
				</Suspense>
				{goal}
			</span>
		</>
	);
}
