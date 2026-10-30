import type { ApprovalMode } from "@shared/approval.ts";
import type { GuardOverride } from "@shared/guard.ts";
import type { LiveGuidance, SessionGuidance } from "@shared/model-guidance.ts";
import { lazy, type MutableRefObject, type ReactNode, Suspense } from "react";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import type { PickedModel } from "../lib/new-chat-picks.ts";
import type { ModelInfo } from "../store/live.ts";
import { ApprovalPicker } from "./ApprovalPicker.tsx";
import { ComposerMore } from "./ComposerMore.tsx";
import { ModelPicker, ThinkingPicker } from "./ModelPicker.tsx";
import { ModePicker } from "./ModePicker.tsx";
import { PresetPicker } from "./PresetPicker.tsx";
import { GuardPicker } from "./SessionGuard.tsx";

// The switch for unattended mode (#646) is for a few people some of the time: a chunk of its own, fetched when this one is drawn.
const UnattendedToggle = lazy(() => import("./UnattendedToggle.tsx"));
/**
 * The pickers in the footer of New chat's composer: preset, model, thinking level, permission mode and guard of the warm-up
 * process, and the model guidance its main agent is given (#641; its own chunk, as most people never pick one), then the
 * Full / Light chip, which sets the mode of that process and of the next new chat. They are shown once that process runs, which is after the first paint, so they are a chunk of their own
 * (`NewChat` fetches it when the warm-up starts) and the menus and popovers they are made of are not in the first load.
 */
// The model guidance picker (#641) is off for almost everyone: a chunk of its own, fetched when this one is drawn.
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
	onGuidance,
	guidanceDisabled,
	more,
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
	/** New chat's own controls (the goal switches) that go with the less used pickers behind "⋯" on a narrow composer. */
	more?: ReactNode;
}) {
	return (
		<>
			<PresetPicker liveId={liveId} onPick={onPreset} />
			<ModelPicker liveId={liveId} current={model} onPick={onModel} />
			{/* On a narrow composer these are behind "⋯" (C1): the model, permission mode and unattended mode stay in the row. */}
			<ComposerMore>
				<ThinkingPicker
					liveId={liveId}
					level={thinking.selected}
					resolved={thinking.resolved}
					current={model}
					onPick={onThinking}
				/>
				<GuardPicker liveId={liveId} onChange={onGuard} />
				{/* Its own chunk lands after the others: a bar of its width holds its place, so the row does not wrap twice. */}
				<Suspense
					fallback={<span aria-hidden data-testid="guidance-skeleton" className="h-8 shrink-0 rounded-lg bg-hover" />}
				>
					<GuidancePicker value={guidance} liveId={liveId} disabled={guidanceDisabled} onPick={onGuidance} />
				</Suspense>
				<ModePicker />
				{more}
			</ComposerMore>
			<ApprovalPicker liveId={liveId} onChange={onApproval} />
			<Suspense
				fallback={
					<span aria-hidden data-testid="unattended-skeleton" className="h-8 w-8 shrink-0 rounded-lg bg-hover" />
				}
			>
				<UnattendedToggle liveId={liveId} pick={unattended} />
			</Suspense>
		</>
	);
}
