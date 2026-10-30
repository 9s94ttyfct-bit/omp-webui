import type { QuickPrompt } from "@shared/quick-prompts.ts";

/**
 * How the command palette sends a quick prompt (#659): the message box's quick-prompt menu of the conversation on screen
 * offers its sender while it is mounted (there is at most one; the latest to mount is it). No conversation on screen, no
 * quick prompts in the palette.
 */

export type SendQuickPrompt = (prompt: QuickPrompt) => void;

let sender: SendQuickPrompt | null = null;

/** Offer `send`; the returned function withdraws it (only if it is still the one offered). */
export function offerQuickPrompts(send: SendQuickPrompt): () => void {
	sender = send;
	return () => {
		if (sender === send) sender = null;
	};
}

/** The sender of the conversation on screen, or null when there is none. */
export const quickPromptSender = (): SendQuickPrompt | null => sender;
