import { ArrowUp, Loader2, Paperclip, Pause, Play, Square, X, Zap } from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	lazy,
	type Ref,
	Suspense,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { flushSync } from "react-dom";
import { useT } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { appendPiece, offerComposer } from "../lib/composer-bridge.ts";
import { forgetDraft, keepDraft, readDraft } from "../lib/drafts.ts";
import { type DropRequest, pickedFiles, takeDrop } from "../lib/drop-items.ts";
import { accept, afterEdit, type Ghost, type GhostFeedback, remaining, wantsPrediction } from "../lib/ghost.ts";
import { useImeGuard } from "../lib/ime.ts";
import { useCrampedRow } from "../lib/media.ts";
import { type Recall, recallDown, recallUp } from "../lib/recall.ts";
import { matches, useShortcutLabel } from "../lib/shortcuts.ts";
import { loadedCommands, loadedSlash, unknownSlash } from "../lib/slash.ts";
import type { UploadScope } from "../lib/upload.ts";
import { socket } from "../lib/ws.ts";
import { useApp } from "../store/app.ts";
import type { SlashCommand } from "../store/live.ts";
import { QueueChip, type QueueKind } from "./QueueChip.tsx";
import { SlashNotice } from "./SlashNotice.tsx";
import { cx, IconButton, Kbd, Tip } from "./ui.tsx";

// The choice between attaching dropped files and inserting their paths, and the chips of the text files attached, are a
// chunk of its own: only a drop (or a draft that holds a file) fetches it.
const DropChoice = lazy(() => import("./DropChoice.tsx"));
const AttachedFiles = lazy(() => import("./DropChoice.tsx").then((m) => ({ default: m.AttachedFiles })));

export interface ImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
	name: string;
	/** Client-only identity for list keys and removal. */
	id: string;
}

/** A text file attached to the message: its text goes into the message after what is typed (`joinMessage`, `shared/attachment.ts`). */
export interface TextAttachment {
	type: "text";
	name: string;
	/** The file's size on disk, in bytes; for a PDF or a Word document, the weight of the text read from it (#697). */
	bytes: number;
	text: string;
	/** For a document: what was taken from it, in a few words (`12 pages · images: 2`), which the chip shows. */
	note?: string;
	/** Client-only identity for list keys and removal. */
	id: string;
}

/** Text, pictures and attached text files to put back into the composer (queued input withdrawn by Stop, a refused edit). */
export interface ComposerDraft {
	text: string;
	images?: ImageAttachment[];
	files?: TextAttachment[];
	nonce: number;
}

export type SendMode = "normal" | "steer" | "followUp";

/** What the page can ask of the composer from outside. */
export interface ComposerHandle {
	focus(): void;
}

/**
 * How the textarea and the ghost-text layer drawn over it set their text. The two must match exactly or the
 * prediction drifts off the words; touch screens get 16px, below which iOS zooms into the focused field.
 */
const FIELD_TEXT =
	"px-4 pt-3.5 pb-2 text-[15px] pointer-coarse:text-[16px] leading-relaxed break-words whitespace-pre-wrap";

/**
 * Below this width the composer's footer controls keep only their icons: with a sidebar and a side panel open (or on a
 * phone) four labelled controls fill three or four rows under a one-line field.
 */
const NARROW_COMPOSER_PX = 440;

/**
 * Whether the footer's controls, as they are laid out now, take more than one line: the vertical centres of their boxes
 * (through wrappers that are `display: contents`, like the "⋯" panel's) are not all the same. The row centres its
 * items, so those on one line share a centre and a wrapped line's are a line away.
 */
function wrapsOntoLines(row: HTMLElement): boolean {
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	const walk = (parent: Element) => {
		for (const child of parent.children) {
			const { display, position } = getComputedStyle(child);
			if (display === "contents") walk(child);
			else if (display !== "none" && position !== "absolute" && position !== "fixed") {
				const box = child.getBoundingClientRect();
				const centre = box.top + box.height / 2;
				first = Math.min(first, centre);
				last = Math.max(last, centre);
			}
		}
	};
	walk(row);
	return last - first > 8;
}

interface Props {
	commands: SlashCommand[];
	/** Working directory for `@file` completions. */
	cwd?: string;
	/** Shows what the conversation has loaded; where it is given, `/status`, `/extensions` and `/skills` do that instead of being held back. */
	onLoaded?: () => void;
	/** Live omp process for word-prediction ghost text (`predict_word`); none → no ghost text. */
	predictLive?: string | null;
	streaming: boolean;
	/**
	 * A send is in flight: Enter and Send do nothing until it settles. The textarea stays editable,
	 * so typing and focus carry on.
	 */
	disabled?: boolean;
	placeholder?: string;
	queue?: { steering: string[]; followUp: string[]; liveSteered?: number };
	onSend: (text: string, images: ImageAttachment[], mode: SendMode) => Promise<boolean> | boolean;
	onAbort?: () => void;
	/**
	 * Work goes on that Stop ends though no reply streams: a subagent runs, which keeps the conversation busy (a wait for a
	 * provider's usage limit lasts for hours). Stop is offered for it; sending still starts a turn.
	 */
	stoppable?: boolean;
	/** Stop was pressed and the conversation has not stopped yet: the button says so, and another press does nothing. */
	stopping?: boolean;
	/** Esc while a reply runs: the page asks before it stops (the Stop button, `onAbort`, stops at once). */
	onStopKey?: () => void;
	/** Freeze the working process (shown with Stop while omp works). */
	onPause?: () => void;
	/** The process is frozen: no Stop/Pause here (the paused banner offers Resume). */
	paused?: boolean;
	/**
	 * A tool approval waits: a message typed now denies it, as the terminal does. The composer says so, so that the
	 * approval is not denied by a message the user did not read.
	 */
	approvalPending?: boolean;
	/**
	 * omp is backing off before a retry of the turn that failed: nothing runs until it retries, so what is typed (and a
	 * steer too) waits for that and does not interrupt the sleep; the composer says so (Retry now ends the wait).
	 */
	retryWait?: boolean;
	onRemoveQueued?: (text: string, queue: QueueKind) => void;
	onPromoteQueued?: (text: string) => void;
	/** Replace a queued message with an edited one; resolves once the replacement is queued (or refused, with a notice). */
	onEditQueued?: (text: string, queue: QueueKind, next: string) => Promise<void>;
	/** Text, pictures and files to put back into the composer, e.g. queued input withdrawn by Stop. Prepended to any current draft. */
	draft?: ComposerDraft | null;
	/** The conversation a file with no path on this computer is sent to (a page that is not the app's window); null: none yet. */
	uploadScope?: UploadScope | null;
	/** The controls beside Attach; a function is told whether something is typed in the box. */
	footer?: React.ReactNode | ((composer: { typing: boolean }) => React.ReactNode);
	/**
	 * The controls must fit on one line beside Attach and Send. Where they do not with their names, they keep only their
	 * icons and the less used are behind "⋯" (the conversation's). Without it they wrap onto a second line, and the icons
	 * alone start below `NARROW_COMPOSER_PX` (New chat's, which has more controls and the width of a page to itself).
	 */
	footerOneRow?: boolean;
	/** What was sent in this conversation, oldest first: Up and Down in the composer walk through it. */
	history?: string[];
	/** Whose unsent text this is (see `lib/drafts.ts`): it is kept under this key and comes back when the page does. */
	draftKey?: string | null;
	ref?: Ref<ComposerHandle>;
}

interface Suggestion {
	value: string;
	label: string;
	description?: string;
	hint?: string;
}

function suggestionsFor(text: string, commands: SlashCommand[]): Suggestion[] {
	if (!text.startsWith("/") || text.includes("\n")) return [];
	const space = text.indexOf(" ");
	if (space < 0) {
		const q = text.slice(1).toLowerCase();
		return commands
			.filter((c) => c.name.toLowerCase().includes(q) || c.aliases?.some((a) => a.toLowerCase().startsWith(q)))
			.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)))
			.slice(0, 40)
			.map((c) => ({ value: `/${c.name} `, label: `/${c.name}`, description: c.description, hint: c.input?.hint }));
	}
	const name = text.slice(1, space);
	const rest = text.slice(space + 1);
	if (rest.includes(" ")) return [];
	const cmd = commands.find((c) => c.name === name || c.aliases?.includes(name));
	return (cmd?.subcommands ?? [])
		.filter((s) => s.name.startsWith(rest))
		.map((s) => ({ value: `/${name} ${s.name} `, label: s.name, description: s.description }));
}

/** The `@path` token being typed at the end of the text, if any. */
function mentionQuery(text: string): string | null {
	const m = /(?:^|\s)@([^\s@]*)$/.exec(text);
	return m ? m[1] : null;
}

export function Composer({
	commands,
	onLoaded,
	cwd,
	streaming,
	disabled,
	placeholder,
	queue,
	onSend,
	onAbort,
	stoppable,
	stopping,
	onStopKey,
	onPause,
	paused,
	approvalPending,
	retryWait,
	onRemoveQueued,
	onPromoteQueued,
	onEditQueued,
	draft,
	footer,
	footerOneRow = false,
	predictLive,
	history,
	draftKey,
	uploadScope,
	ref,
}: Props) {
	const t = useT();
	const ime = useImeGuard();
	const toast = useApp((s) => s.toast);
	// While the page has lost the server, nothing can be sent (C9): the message box still takes text, Send is grey, and a
	// line under the box says why. What is written is kept and sent with the next press once the page is back.
	const offline = useApp((s) => !s.connected);
	const [text, setText] = useState(() => (draftKey ? readDraft(draftKey)?.text : undefined) ?? "");
	const [images, setImages] = useState<ImageAttachment[]>(
		() => (draftKey ? readDraft(draftKey)?.images : undefined) ?? [],
	);
	const [files, setFiles] = useState<TextAttachment[]>(() => (draftKey ? readDraft(draftKey)?.files : undefined) ?? []);
	// Files given to the message box and not dealt with yet (the choice is made in `DropChoice`).
	const [dropped, setDropped] = useState<DropRequest | null>(null);
	const [dragging, setDragging] = useState(false);
	// The draft follows its conversation when that gains a session file (or moves to a new one: branch, fork).
	const keptUnder = useRef(draftKey);
	useEffect(() => {
		if (keptUnder.current && keptUnder.current !== draftKey) forgetDraft(keptUnder.current);
		keptUnder.current = draftKey;
		if (draftKey) keepDraft(draftKey, { text, images, ...(files.length ? { files } : {}) });
	}, [draftKey, text, images, files]);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const [sel, setSel] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	// A `/name` omp would not run is held back with the web UI's counterpart; the notice shows for that text only.
	const [held, setHeld] = useState<{ name: string; text: string; mode: SendMode } | null>(null);
	const notice = held && held.text === text.trim() ? held : null;
	/** How this platform writes the steer shortcut (⌘↵, Ctrl+Enter); empty when it was cleared. */
	const steerHint = useShortcutLabel("steer");
	/** Where the walk through earlier prompts (Up/Down) is; null when none is going on. */
	const recall = useRef<Recall | null>(null);
	const ta = useRef<HTMLTextAreaElement>(null);
	const [box, setBox] = useState<HTMLDivElement | null>(null);
	const [footerRow, setFooterRow] = useState<HTMLDivElement | null>(null);
	// The footer's controls keep only their icons where the composer is narrower than `NARROW_COMPOSER_PX` and, for a
	// footer that must be one line (`footerOneRow`), where they do not fit on one with their names; the less used are
	// then behind "⋯" (`ComposerMore`). With a sidebar and a side panel open (or on a phone) they filled two to four rows.
	// Typing hides a control (quick prompts, whose place Steer takes): that does not bring the names back for the first
	// letter typed and take them away again when the box is cleared.
	const typing = text.trim() !== "";
	const narrow = useCrampedRow(
		footerRow,
		"data-composer-narrow",
		(row, compact) =>
			(box !== null && box.clientWidth < NARROW_COMPOSER_PX) ||
			(footerOneRow && ((compact && typing) || wrapsOntoLines(row))),
	);
	useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }), []);
	// Other parts of the page put text here (the Files tab's mentions): at the end, as the box is not theirs to read.
	const [caretAtEnd, setCaretAtEnd] = useState(0);
	useEffect(
		() =>
			offerComposer((piece, focus) => {
				setText((cur) => appendPiece(cur, piece));
				if (focus) setCaretAtEnd((n) => n + 1);
			}),
		[],
	);
	useEffect(() => {
		const el = ta.current;
		if (caretAtEnd === 0 || !el) return;
		el.focus();
		el.setSelectionRange(el.value.length, el.value.length);
	}, [caretAtEnd]);
	const fileInput = useRef<HTMLInputElement>(null);
	const ghostLayer = useRef<HTMLDivElement>(null);
	const ghostRef = useRef<Ghost | null>(null);
	const [ghost, setGhost] = useState<Ghost | null>(null);
	const predictSeq = useRef(0);
	const mention = mentionQuery(text);
	const [fileHits, setFileHits] = useState<{ q: string; files: string[] }>({ q: "", files: [] });
	useEffect(() => {
		if (mention === null || !cwd) return;
		let live = true;
		const t = setTimeout(() => {
			api
				.files(cwd, mention)
				.then((files) => live && setFileHits({ q: mention, files }))
				.catch(() => live && setFileHits({ q: mention, files: [] }));
		}, 100);
		return () => {
			live = false;
			clearTimeout(t);
		};
	}, [mention, cwd]);
	const suggestions = useMemo((): Suggestion[] => {
		if (dismissed === text) return [];
		if (mention !== null) {
			if (fileHits.q !== mention) return [];
			const head = text.slice(0, text.length - mention.length);
			return fileHits.files.map((f) => ({ value: `${head}${f} `, label: `@${f}` }));
		}
		return suggestionsFor(
			text,
			onLoaded ? [...commands, ...loadedCommands(commands, t("loaded.slashDescription"))] : commands,
		);
	}, [text, commands, dismissed, mention, fileHits, onLoaded, t]);

	useEffect(() => {
		if (!draft) return;
		setText((cur) => (cur.trim() ? `${draft.text}\n\n${cur}` : draft.text));
		if (draft.images?.length) setImages((cur) => [...(draft.images ?? []), ...cur]);
		if (draft.files?.length) setFiles((cur) => [...(draft.files ?? []), ...cur]);
		ta.current?.focus();
	}, [draft]);

	const hint =
		placeholder ??
		(paused
			? t("chat.composerPlaceholderPaused")
			: approvalPending
				? t("chat.composerPlaceholderApproval")
				: streaming
					? retryWait
						? t("chat.composerPlaceholderWait")
						: steerHint
							? t("chat.composerPlaceholderQueue", { keys: steerHint })
							: t("chat.composerPlaceholderQueueBare")
					: t("chat.composerPlaceholder"));
	/**
	 * As tall as its text, or, empty, as its placeholder (which wraps at the width the field has now). It is measured by
	 * shrinking the field and growing it again, which shortens the chat's bottom block for a moment: the box around the
	 * field keeps its height meanwhile, or the transcript above would be taller for that moment and the browser would cut
	 * its scroll position back to the end of it (#586).
	 */
	const fit = useCallback(() => {
		const el = ta.current;
		if (!el) return;
		const box = el.parentElement;
		if (box) box.style.minHeight = `${box.offsetHeight}px`;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
		if (box) box.style.minHeight = "";
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the textarea's scrollHeight changes with `text` and `hint`.
	useEffect(fit, [text, hint]);
	// Opening the sidebar or the side panel, or resizing the window, changes the width its text wraps at.
	useEffect(() => {
		const el = ta.current;
		if (!el) return;
		let width = el.clientWidth;
		let frame = 0;
		const observer = new ResizeObserver(() => {
			if (el.clientWidth === width) return;
			width = el.clientWidth;
			// Not in the callback itself: it changes the height of the element being observed.
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(fit);
		});
		observer.observe(el);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, [fit]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlighted suggestion whenever the list changes.
	useEffect(() => setSel(0), [suggestions.length]);

	const ghostFeedback = (f: GhostFeedback | undefined) => {
		if (f && predictLive) void socket.rpc(predictLive, { type: "predict_word_feedback", ...f }).catch(() => {});
	};
	const setGhostBoth = (g: Ghost | null) => {
		ghostRef.current = g;
		setGhost(g);
	};

	// Reconcile the ghost with every text change, then ask omp for a new prediction (debounced, newest wins).
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs per text change; helpers are stable in effect.
	useEffect(() => {
		const r = afterEdit(ghostRef.current, text);
		ghostFeedback(r.feedback);
		if (r.ghost !== ghostRef.current) setGhostBoth(r.ghost);
		if (r.ghost || recall.current || !predictLive || !wantsPrediction(text, ta.current?.selectionEnd ?? text.length))
			return;
		const seq = ++predictSeq.current;
		const t = setTimeout(() => {
			socket
				.rpc<{ suffix: string | null }>(predictLive, { type: "predict_word", text, cursor: text.length })
				.then((res) => {
					if (seq === predictSeq.current && res?.suffix && ta.current?.value === text)
						setGhostBoth({ base: text, suffix: res.suffix });
				})
				.catch((e) => {
					// Only omp's TUI creates the prompt-history table its predictor reads (omp 18.11);
					// say so in Settings instead of failing silently forever.
					if (/no such table: history/.test(String((e as Error)?.message)))
						useApp.setState({ predictionUnavailable: true });
				});
		}, 90);
		return () => clearTimeout(t);
	}, [text, predictLive]);
	const ghostRest = suggestions.length ? null : remaining(ghost, text);
	const acceptGhost = (withSpace: boolean): boolean => {
		const r = accept(ghostRef.current, text, withSpace);
		if (!r) return false;
		ghostFeedback(r.feedback);
		setGhostBoth(null);
		setText(r.text);
		return true;
	};

	const submit = async (mode: SendMode, force = false) => {
		const trimmed = text.trim();
		if ((!trimmed && !images.length && !files.length) || disabled || offline) return;
		// A /name omp would hand to the model as plain text is held back: the notice says what to use, and can send it anyway.
		if (!force && !images.length && !files.length) {
			if (onLoaded && loadedSlash(trimmed, commands)) {
				setHeld(null);
				setText("");
				onLoaded();
				return;
			}
			const name = unknownSlash(trimmed, commands);
			if (name) {
				setHeld({ name, text: trimmed, mode });
				return;
			}
		}
		setHeld(null);
		recall.current = null;
		const original = text;
		const attached = images;
		const attachedFiles = files;
		// The message format is loaded when there is a text file to put in it (the first page does not carry it).
		const message = attachedFiles.length
			? (await import("@shared/attachment.ts")).joinMessage(trimmed, attachedFiles)
			: trimmed;
		// Clear now rather than when the send resolves: the textarea stays editable meanwhile (resuming a stopped
		// process takes seconds), and what is typed in the meantime must not be wiped by the send finishing.
		setText("");
		setImages([]);
		setFiles([]);
		ta.current?.focus();
		let sent = false;
		try {
			sent = (await onSend(message, attached, mode)) !== false;
		} finally {
			// A send that did not go through gives the draft back, in front of anything typed since — to the kept
			// draft when the user has left the conversation meanwhile.
			if (!sent && mounted.current) {
				setText((cur) => (cur.trim() ? `${original}\n\n${cur}` : original));
				setImages((cur) => [...attached, ...cur]);
				setFiles((cur) => [...attachedFiles, ...cur]);
			} else if (!sent && keptUnder.current) {
				const cur = readDraft(keptUnder.current);
				const back = [...attachedFiles, ...(cur?.files ?? [])];
				keepDraft(keptUnder.current, {
					text: cur?.text.trim() ? `${original}\n\n${cur.text}` : original,
					images: [...attached, ...(cur?.images ?? [])],
					...(back.length ? { files: back } : {}),
				});
			}
		}
	};

	// Text files are put into the message when it is sent: the format is fetched as soon as there is one, so that sending is not held up.
	useEffect(() => {
		if (files.length) void import("@shared/attachment.ts");
	}, [files.length]);

	/** Files given to the message box: the choice of what to do with them opens next to it. */
	const take = (request: DropRequest | null) => {
		if (request) setDropped(request);
	};

	/** What the choice made of the files: pictures and text files join the message. */
	const attach = (added: { images: ImageAttachment[]; files: TextAttachment[] }) => {
		if (added.images.length) setImages((cur) => [...cur, ...added.images]);
		if (added.files.length) setFiles((cur) => [...cur, ...added.files]);
	};

	/** Paths (or any text) put at the end of the message, with the caret after them. */
	const insert = (piece: string) => {
		setText((cur) => appendPiece(cur, piece));
		setCaretAtEnd((n) => n + 1);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		// Enter that confirms an input-method composition is the IME's, whichever order the browser delivers it in.
		if (ime.imeKey(e)) return;
		if (suggestions.length) {
			if (matches("menuNext", e) || matches("menuPrev", e)) {
				e.preventDefault();
				const step = matches("menuNext", e) ? 1 : suggestions.length - 1;
				setSel((s) => (s + step) % suggestions.length);
				return;
			}
			const pick = suggestions[sel];
			if (pick && (matches("menuAccept", e) || (matches("send", e) && text.trim() !== pick.value.trim()))) {
				e.preventDefault();
				setText(pick.value);
				return;
			}
			if (matches("menuDismiss", e)) {
				e.preventDefault();
				setDismissed(text);
				return;
			}
		}
		// Esc closes the held-back notice before it stops anything.
		if (notice && matches("stop", e)) {
			e.preventDefault();
			setHeld(null);
			return;
		}
		// Up and Down walk through the conversation's earlier prompts: Up from the first line, Down from the last
		// (anywhere else they move the caret), and only with nothing selected.
		const field = e.currentTarget;
		if (
			history?.length &&
			(e.key === "ArrowUp" || e.key === "ArrowDown") &&
			!e.shiftKey &&
			!e.altKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			field.selectionStart === field.selectionEnd
		) {
			const up = e.key === "ArrowUp";
			const onEdge = up
				? !text.slice(0, field.selectionStart).includes("\n")
				: !text.slice(field.selectionEnd).includes("\n");
			const step = !onEdge ? null : up ? recallUp(history, text, recall.current) : recallDown(history, recall.current);
			if (step) {
				e.preventDefault();
				recall.current = step.state;
				// A recalled /command is a message, not a command being typed: no menu for it. The caret goes to the end
				// together with the text: from a frame callback it would come late when the page is busy, and collapse a
				// selection made since (select all, then Delete) so that nothing is deleted.
				flushSync(() => {
					setDismissed(step.text);
					setText(step.text);
				});
				field.setSelectionRange(step.text.length, step.text.length);
				return;
			}
		}
		const atEnd = (ta.current?.selectionStart ?? 0) === text.length;
		if (ghostRest && atEnd && (matches("ghostAccept", e) || matches("ghostAcceptBare", e))) {
			if (acceptGhost(matches("ghostAccept", e))) {
				e.preventDefault();
				return;
			}
		}
		if (matches("send", e) || matches("steer", e)) {
			e.preventDefault();
			void submit(streaming ? (matches("steer", e) ? "steer" : "followUp") : "normal");
			return;
		}
		if (matches("stop", e) && streaming) {
			e.preventDefault();
			// A key held down repeats: the second press of a confirmation is a press, not that.
			if (!e.repeat) onStopKey?.();
		}
	};

	// Keyed by the text and which time it appears: an open editor stays with its message when others leave the queue.
	const seen = new Map<string, number>();
	const chips = (["steering", "followUp"] as const).flatMap((q) => {
		const texts = queue?.[q] ?? [];
		return texts.map((text, i) => {
			const id = `${q}\0${text}`;
			const nth = seen.get(id) ?? 0;
			seen.set(id, nth + 1);
			return {
				text,
				q,
				key: `${id}\0${nth}`,
				after: texts.length - 1 - i,
				locked: q === "steering" && i < (queue?.liveSteered ?? 0),
			};
		});
	});

	// An open queue editor with changes goes with its message when omp takes it: its text is put back here, as Stop does
	// with the queue, rather than vanishing with the chip.
	const editing = useRef(new Map<string, string>());
	const chipKeys = JSON.stringify(chips.map((c) => c.key));
	useEffect(() => {
		const live = new Set<string>(JSON.parse(chipKeys));
		const lost: string[] = [];
		for (const [key, value] of editing.current)
			if (!live.has(key)) {
				editing.current.delete(key);
				lost.push(value);
			}
		if (!lost.length) return;
		const back = lost.join("\n\n");
		setText((cur) => (cur.trim() ? `${back}\n\n${cur}` : back));
		ta.current?.focus();
		toast("info", t("chat.queueEditGone"));
	}, [chipKeys, toast, t]);

	return (
		<div className="relative">
			{chips.length ? (
				<div className="mb-2 flex flex-wrap gap-1.5" data-testid="queue">
					{chips.map((c) => (
						<QueueChip
							key={c.key}
							kind={c.q}
							text={c.text}
							after={c.after}
							locked={c.locked}
							onPromote={onPromoteQueued ? () => onPromoteQueued(c.text) : undefined}
							onRemove={onRemoveQueued ? () => onRemoveQueued(c.text, c.q) : undefined}
							onEdit={onEditQueued ? (next) => onEditQueued(c.text, c.q, next) : undefined}
							onEditing={(value) => {
								if (value === null) editing.current.delete(c.key);
								else editing.current.set(c.key, value);
							}}
						/>
					))}
				</div>
			) : null}
			{notice ? (
				<SlashNotice
					name={notice.name}
					onSendAnyway={() => void submit(notice.mode, true)}
					onDismiss={() => setHeld(null)}
				/>
			) : null}
			{suggestions.length ? (
				<div
					role="listbox"
					aria-label={mention !== null ? t("chat.composerFiles") : t("chat.composerCommands")}
					className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-xl"
					data-testid="slash-menu"
				>
					{suggestions.map((s, i) => (
						<button
							type="button"
							role="option"
							aria-selected={i === sel}
							key={s.value}
							className={cx(
								"flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm",
								i === sel ? "bg-hover" : "hover:bg-hover",
							)}
							onMouseDown={(e) => {
								e.preventDefault();
								setText(s.value);
								ta.current?.focus();
							}}
						>
							<span className="shrink-0 font-mono text-xs text-accent">{s.label}</span>
							{/* A long argument list gives way (with an ellipsis) before the description does, up to half the row. */}
							{s.hint ? (
								<span className="min-w-0 max-w-[50%] truncate font-mono text-xs text-faint" title={s.hint}>
									{s.hint}
								</span>
							) : null}
							<span className="min-w-0 flex-1 truncate text-xs text-muted">{s.description}</span>
						</button>
					))}
				</div>
			) : null}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for files; keyboard users use the Attach button. */}
			<div
				ref={setBox}
				className={cx(
					"rounded-2xl border bg-surface shadow-sm transition-[border-color,box-shadow] has-[textarea:focus-visible]:border-accent has-[textarea:focus-visible]:ring-1 has-[textarea:focus-visible]:ring-accent",
					dragging ? "border-accent ring-1 ring-accent" : "border-border",
				)}
				data-dragging={dragging ? "" : undefined}
				onDragOver={(e: DragEvent) => {
					// Text dragged in is the text field's own business; files are taken here.
					if (!e.dataTransfer.types.includes("Files")) return;
					e.preventDefault();
					setDragging(true);
				}}
				onDragLeave={(e: DragEvent) => {
					if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDragging(false);
				}}
				onDrop={(e: DragEvent) => {
					if (!e.dataTransfer.types.includes("Files")) return;
					e.preventDefault();
					setDragging(false);
					take(takeDrop(e.dataTransfer, "drop"));
				}}
			>
				{images.length || files.length ? (
					<div className="flex flex-wrap gap-2 px-3 pt-3">
						{images.map((img) => (
							<div key={img.id} className="group relative">
								<img
									alt={img.name}
									className="h-16 w-16 rounded-lg border border-border object-cover"
									src={`data:${img.mimeType};base64,${img.data}`}
								/>
								<button
									type="button"
									aria-label={t("chat.composerRemoveImage", { name: img.name })}
									className="absolute -top-1.5 -right-1.5 rounded-full border border-border bg-surface p-0.5 text-muted hover:text-fg"
									onClick={() => setImages((cur) => cur.filter((x) => x.id !== img.id))}
								>
									<X size={12} />
								</button>
							</div>
						))}
						{files.length ? (
							<Suspense fallback={null}>
								<AttachedFiles files={files} onRemove={(id) => setFiles((cur) => cur.filter((x) => x.id !== id))} />
							</Suspense>
						) : null}
					</div>
				) : null}
				<div className="relative">
					{ghostRest ? (
						<div
							ref={ghostLayer}
							aria-hidden
							className={cx("pointer-events-none absolute inset-0 overflow-hidden", FIELD_TEXT)}
						>
							<span className="invisible">{text}</span>
							<span className="text-faint" data-testid="ghost">
								{ghostRest}
							</span>
						</div>
					) : null}
					<textarea
						ref={ta}
						rows={1}
						value={text}
						aria-label={t("chat.composerMessage")}
						data-testid="composer"
						placeholder={hint}
						className={cx(
							"block max-h-80 w-full resize-none bg-transparent outline-none placeholder:text-faint",
							FIELD_TEXT,
						)}
						onChange={(e) => {
							// Typing in a recalled prompt makes it a new message: the next Up starts again from the newest.
							recall.current = null;
							setText(e.target.value);
						}}
						onScroll={(e) => {
							if (ghostLayer.current) ghostLayer.current.scrollTop = e.currentTarget.scrollTop;
						}}
						onKeyDown={onKeyDown}
						onCompositionEnd={ime.onCompositionEnd}
						onPaste={(e: ClipboardEvent) => {
							const request = takeDrop(e.clipboardData, "paste");
							if (request) {
								e.preventDefault();
								take(request);
							}
						}}
					/>
				</div>
				{offline ? (
					<p className="px-3 pb-1 text-xs text-warning" role="status" data-testid="composer-offline">
						{t("chat.composerOffline")}
					</p>
				) : null}
				<div className="flex items-start gap-1 px-2 pb-2">
					<input
						ref={fileInput}
						type="file"
						multiple
						hidden
						data-testid="composer-file-input"
						onChange={(e) => {
							take(pickedFiles(e.target.files ?? []));
							// The same file can be chosen again.
							e.target.value = "";
						}}
					/>
					<IconButton label={t("chat.composerAttach")} onClick={() => fileInput.current?.click()}>
						<Paperclip size={17} />
					</IconButton>
					{/* The footer's controls stay on one line beside Attach and Send. Where they do not fit with their names (`wrapsOntoLines`), they keep only their icons and the less used are behind "⋯", so that one line holds them. */}
					<div
						ref={setFooterRow}
						className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
						data-testid="composer-footer"
						data-composer-narrow={narrow ? "" : undefined}
					>
						{typeof footer === "function" ? footer({ typing }) : footer}
					</div>
					{paused ? null : streaming || stoppable ? (
						<>
							{streaming && text.trim() ? (
								<Tip
									label={
										<span>
											{t(retryWait ? "chat.composerSteerAfterWait" : "chat.composerSteerNow")}
											{steerHint ? (
												<>
													{" "}
													<Kbd>{steerHint}</Kbd>
												</>
											) : null}
										</span>
									}
								>
									<button
										type="button"
										aria-label={t(retryWait ? "chat.composerSteerAfterWait" : "chat.composerSteerNow")}
										className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted hover:bg-hover hover:text-fg"
										onClick={() => void submit("steer")}
									>
										<Zap size={14} /> {t("chat.composerSteer")}
									</button>
								</Tip>
							) : null}
							{streaming && onPause ? (
								<Tip label={t("chat.composerPause")}>
									<button
										type="button"
										aria-label={t("chat.composerPause")}
										data-testid="pause"
										className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border text-fg hover:bg-hover"
										onClick={onPause}
									>
										<Pause size={13} fill="currentColor" />
									</button>
								</Tip>
							) : null}
							<Tip
								label={
									<span>
										{t("chat.composerStop")} <Kbd>Esc</Kbd> <Kbd>Esc</Kbd>
									</span>
								}
							>
								<button
									type="button"
									aria-label={t(stopping ? "chat.stopping" : "chat.composerStop")}
									aria-busy={stopping || undefined}
									data-testid="stop"
									data-stopping={stopping ? "" : undefined}
									className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-fg text-bg hover:opacity-85"
									onClick={onAbort}
								>
									{stopping ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} fill="currentColor" />}
								</button>
							</Tip>
						</>
					) : null}
					{paused ? (
						// Sending to a paused conversation resumes it first, and the button says so.
						text.trim() || images.length || files.length ? (
							<button
								type="button"
								data-testid="send"
								disabled={disabled || offline}
								className="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110 disabled:opacity-30"
								onClick={() => void submit(streaming ? "followUp" : "normal")}
							>
								<Play size={12} fill="currentColor" /> {t("chat.composerResumeSend")}
							</button>
						) : null
					) : !streaming || text.trim() ? (
						<button
							type="button"
							aria-label={
								streaming
									? t(retryWait ? "chat.composerQueueAfterWait" : "chat.composerQueueMessage")
									: t("chat.composerSend")
							}
							data-testid="send"
							disabled={disabled || offline || (!text.trim() && !images.length && !files.length)}
							className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg transition hover:brightness-110 disabled:opacity-30"
							onClick={() => void submit(streaming ? "followUp" : "normal")}
						>
							<ArrowUp size={17} />
						</button>
					) : null}
				</div>
			</div>
			{dropped ? (
				<Suspense fallback={null}>
					<DropChoice
						key={dropped.id}
						request={dropped}
						anchor={box}
						scope={uploadScope ?? null}
						images={images}
						usedTextBytes={files.reduce((sum, f) => sum + f.bytes, 0)}
						onAttach={attach}
						onInsert={insert}
						onDone={() => {
							// The choice had the keyboard (Attach, Cancel, Esc and the close button all end here): it goes back to
							// the message box, unless the person has moved it to something else meanwhile.
							const active = document.activeElement;
							if (!active || active === document.body || active.closest('[data-testid="drop-choice"]'))
								ta.current?.focus();
							setDropped((cur) => (cur?.id === dropped.id ? null : cur));
						}}
					/>
				</Suspense>
			) : null}
		</div>
	);
}
