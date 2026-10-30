import type { Element, Root as HastRoot } from "hast";
import { Check, Copy } from "lucide-react";
import type { Root as MdastRoot } from "mdast";
import {
	Children,
	createContext,
	createElement,
	Fragment,
	isValidElement,
	memo,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import ReactMarkdown, { type Components, defaultUrlTransform, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { highlight, highlighted } from "../lib/highlight.ts";
import { isAllowedImageSrc } from "../lib/image-src.ts";
import { linkTarget } from "../lib/link-target.ts";
import { type Nesting, nestsTooDeep, scanNesting } from "../lib/markdown-depth.ts";
import { type Block, type Blocks, type Group, splitBlocks } from "./markdown-blocks.ts";

/** Longer blocks are left plain: tokenising them is slow and the HTML would be thousands of elements. */
const MAX_HIGHLIGHT_CHARS = 60_000;

export function CopyButton({ text, label }: { text: string; label?: string }) {
	const t = useT();
	const [done, setDone] = useState(false);
	label ??= t("common.copy");
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
			onClick={() => {
				void navigator.clipboard.writeText(text);
				setDone(true);
				setTimeout(() => setDone(false), 1200);
			}}
		>
			{done ? <Check size={14} /> : <Copy size={14} />}
		</button>
	);
}

export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang: string }) {
	const t = useT();
	const language = lang || "text";
	// The last block highlighted, with the code it was for: a block that has grown since (it is streaming) shows its
	// current text until it is highlighted again, never the old colours of text that is gone.
	const [done, setDone] = useState<{ code: string; language: string; html: string } | null>(null);
	const html = highlighted(code, language) ?? (done?.code === code && done.language === language ? done.html : null);
	useEffect(() => {
		if (html !== null || code.length > MAX_HIGHLIGHT_CHARS) return;
		let alive = true;
		const timer = setTimeout(() => {
			void highlight(code, language).then((h) => alive && h !== null && setDone({ code, language, html: h }));
		}, 120);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [code, language, html]);
	return (
		<div className="group/code my-3 overflow-hidden rounded-xl border border-border bg-code">
			<div className="flex items-center justify-between border-b border-border px-3 py-1 text-xs text-faint">
				<span className="font-mono">{language}</span>
				<CopyButton text={code} label={t("chat.copyCode")} />
			</div>
			{html ? (
				<div
					className="overflow-x-auto p-3 text-xs leading-relaxed [&_pre]:font-mono"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: shiki escapes the code it highlights
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : (
				<pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{code}</pre>
			)}
		</div>
	);
});

/** Scroll to the footnote (or back to its reference) `id` names, within the message the button is in. */
function scrollToNote(from: HTMLElement, id: string): void {
	const root = from.closest(".prose-omp");
	const note = root ? [...root.querySelectorAll<HTMLElement>("[id]")].find((el) => el.id === id) : undefined;
	if (!note) return;
	note.scrollIntoView({ block: "center" });
	// Keyboard and screen reader users arrive where the page does.
	note.tabIndex = -1;
	note.focus({ preventScroll: true });
}

/**
 * A link of the text. One that opens somewhere else (a web or mail address) opens in a window of its own. A footnote
 * reference scrolls within the message. Anything else (an empty address, which is what a scheme the sanitiser refuses
 * leaves; a file path; `irc:`, which the macOS app does not open) has nowhere to go and is shown as text: such a link
 * opened this page again, in a second tab.
 */
function MarkdownLink({
	href,
	id,
	label,
	describedBy,
	children,
}: {
	href?: string;
	id?: string;
	label?: string;
	describedBy?: string;
	children?: ReactNode;
}) {
	const target = linkTarget(href);
	if (target.kind === "open") {
		return (
			<a href={target.href} id={id} target="_blank" rel="noreferrer noopener">
				{children}
			</a>
		);
	}
	if (target.kind === "anchor") {
		return (
			<button
				type="button"
				id={id}
				aria-label={label}
				aria-describedby={describedBy}
				className="md-anchor"
				data-testid="md-anchor"
				onClick={(e) => scrollToNote(e.currentTarget, target.id)}
			>
				{children}
			</button>
		);
	}
	// A path is kept as a hint to what the text points at, not as an address.
	return href ? (
		<span id={id} className="md-ref" title={href}>
			{children}
		</span>
	) : (
		<span id={id}>{children}</span>
	);
}

const components: Components = {
	pre: ({ children }) => <>{children}</>,
	code({ className, children }) {
		const text = String(children ?? "");
		const m = /language-([\w+#.-]+)/.exec(className ?? "");
		if (!m && !text.includes("\n")) return <code>{children}</code>;
		return <CodeBlock code={text.replace(/\n$/, "")} lang={m?.[1] ?? ""} />;
	},
	// The footnote links carry the ids they point at each other by, and their labels.
	a: ({ href, children, id, "aria-label": label, "aria-describedby": describedBy }) => (
		<MarkdownLink href={href} id={id} label={label} describedBy={describedBy}>
			{children}
		</MarkdownLink>
	),
	// An <img> is fetched the moment it renders, so a model (or a page it read) could leak data through the URL.
	// Only this server's stored attachments and inline images render; any other source becomes a link.
	img: ({ src, alt }) => {
		if (isAllowedImageSrc(src, location.origin)) return <img src={src} alt={alt ?? ""} className="rounded-lg" />;
		const href = defaultUrlTransform(src ?? "");
		const label = alt || src || "";
		const target = linkTarget(href);
		return target.kind === "open" ? (
			<a href={target.href} target="_blank" rel="noreferrer noopener" title={target.href} data-testid="md-image-link">
				{label}
			</a>
		) : (
			<span>{label}</span>
		);
	},
};

/** Image sources reach the `img` component untouched, which judges them; every other URL gets react-markdown's scheme filter. */
const urlTransform: UrlTransform = (url, key, node) =>
	key === "src" && node.tagName === "img" ? url : defaultUrlTransform(url);

const remarkPlugins = [remarkGfm];

/** One top-level block of the text, rendered on its own: a block whose text did not change is not rendered again. */
export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
	return (
		<ReactMarkdown remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>
			{text}
		</ReactMarkdown>
	);
});

// A long list, table or quote is rendered in two kinds of pieces (see `Group`). The last chunk renders as Markdown does,
// whatever it holds: the rest of the list, and the blocks that follow it when the next parse has not come yet. The
// element its first node makes is marked, and holds the complete chunks in front of what it was given. Each complete
// chunk renders on its own, as a list, table or quote, and only what that holds is kept. What this puts together is
// what the whole text renders, element for element.

/** Marks the first node of a text, the element that holds a group: a list or quote, a table and its body. */
function markHost() {
	return (tree: HastRoot) => {
		const host = tree.children.find((node): node is Element => node.type === "element");
		if (!host) return;
		host.properties.dataMdHost = true;
		for (const node of host.tagName === "table" ? host.children : []) {
			if (node.type === "element" && node.tagName === "tbody") node.properties.dataMdHost = true;
		}
	};
}

/** The list a chunk is, whole, renders every item as a loose list does when `loose`. A chunk read alone does not see the blank lines between the other chunks' items. */
function makeLoose() {
	return (tree: MdastRoot) => {
		const list = tree.children[0];
		if (list?.type === "list") list.spread = true;
	};
}

const markHostPlugins = [markHost];
const chunkPlugins = [remarkGfm];
const looseChunkPlugins = [remarkGfm, makeLoose];

/** What the marked element of the last chunk is given: the chunks before it, and the group's own mark on the element. */
const GroupContext = createContext<{ frozen: ReactNode[]; start?: number; task: boolean } | null>(null);

interface HostProps {
	node?: Element;
	className?: string;
	start?: number;
	children?: ReactNode;
}

type HostTag = "ul" | "ol" | "blockquote" | "tbody";

/**
 * The children react-markdown made of a list, quote or table body, to move into another element. A list or quote's
 * begin with the newline that follows the opening tag and have one after each; a table body has none (react-markdown
 * leaves out the whitespace between the elements of a table).
 */
const childrenOf = (tag: HostTag, children: ReactNode): ReactNode[] =>
	tag === "tbody" ? Children.toArray(children) : Children.toArray(children).slice(1);

/**
 * `tag` as react-markdown renders it, except the marked one of a group's last chunk, which holds the complete chunks
 * before the rest of what it held.
 */
function host(tag: HostTag) {
	return function Host({ node, className, start, children }: HostProps) {
		const group = useContext(GroupContext);
		if (!group || !node?.properties.dataMdHost) return createElement(tag, { className, start }, children);
		return createElement(
			tag,
			{ className: group.task ? "contains-task-list" : className, start: group.start },
			tag === "tbody" ? null : "\n",
			group.frozen,
			childrenOf(tag, children),
		);
	};
}

/**
 * `tag` as react-markdown renders it, except the marked one of a chunk, which renders as what it holds: its children,
 * so that the chunks add up to the children of the element they are in.
 */
function extract(tag: HostTag) {
	return function Extract({ node, className, start, children }: HostProps) {
		if (!node?.properties.dataMdHost) return createElement(tag, { className, start }, children);
		return <>{childrenOf(tag, children)}</>;
	};
}

const extractTbody = extract("tbody");

/** In a chunk of rows the table is only what its body holds. */
function ExtractTable({ node, children }: Pick<HostProps, "node" | "children">) {
	if (!node?.properties.dataMdHost) return <table>{children}</table>;
	return <>{Children.toArray(children).find((child) => isValidElement(child) && child.type === extractTbody)}</>;
}

const hostComponents: Components = {
	...components,
	ul: host("ul"),
	ol: host("ol"),
	blockquote: host("blockquote"),
	table: ({ children }) => <table>{children}</table>,
	tbody: host("tbody"),
};

const chunkComponents: Components = {
	...components,
	ul: extract("ul"),
	ol: extract("ol"),
	blockquote: extract("blockquote"),
	table: ExtractTable,
	tbody: extractTbody,
};

/** A complete chunk of a group, rendered on its own (with the table's head, for rows) and not again while its text is the same. */
const MarkdownChunk = memo(function MarkdownChunk({
	head,
	text,
	loose,
}: {
	head: string;
	text: string;
	loose: boolean;
}) {
	return (
		<ReactMarkdown
			remarkPlugins={loose ? looseChunkPlugins : chunkPlugins}
			rehypePlugins={markHostPlugins}
			components={chunkComponents}
			urlTransform={urlTransform}
		>
			{head + text}
		</ReactMarkdown>
	);
});

/** A long list, table or quote: the complete chunks once each, and the rest of the text as it comes. */
const MarkdownGroup = memo(function MarkdownGroup({ group }: { group: Group }) {
	const last = group.chunks.length - 1;
	const frozen = group.chunks.slice(0, last).map((chunk, i) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: chunks are only ever added at the end
		<MarkdownChunk key={i} head={group.head} text={chunk} loose={group.loose} />
	));
	return (
		<GroupContext.Provider value={{ frozen, start: group.start, task: group.task }}>
			<ReactMarkdown
				remarkPlugins={group.loose ? looseChunkPlugins : chunkPlugins}
				rehypePlugins={markHostPlugins}
				components={hostComponents}
				urlTransform={urlTransform}
			>
				{group.head + group.chunks[last]}
			</ReactMarkdown>
		</GroupContext.Provider>
	);
});

/** Blocks cut from one text (see `splitBlocks`), rendered as that text renders whole: react-markdown puts a newline between top-level nodes, and so does this between blocks. */
export function MarkdownBlocks({ blocks }: { blocks: readonly Block[] }) {
	return (
		<div className="prose-omp">
			{blocks.map((block, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a block is identified by its place; the text only grows at the end
				<Fragment key={i}>
					{i > 0 ? "\n" : null}
					{typeof block === "string" ? <MarkdownBlock text={block} /> : <MarkdownGroup group={block} />}
				</Fragment>
			))}
		</div>
	);
}

/**
 * The text as Markdown. An answer streams in at its end: it is cut into blocks and each token renders and parses only
 * the last one, instead of everything written so far.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	const t = useT();
	const nesting = useRef<Nesting | undefined>(undefined);
	const last = useRef<Blocks | undefined>(undefined);
	const scanned = scanNesting(text, nesting.current);
	nesting.current = scanned;
	// Text that nests quotes or lists beyond anything written is shown as written: converting it overflows the stack,
	// and parsing it takes seconds (see `lib/markdown-depth.ts`).
	if (nestsTooDeep(scanned)) {
		return (
			<div className="prose-omp" data-testid="markdown-plain">
				<p className="text-xs text-muted">{t("chat.markdownPlain")}</p>
				<div className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{text}</div>
			</div>
		);
	}
	const split = splitBlocks(text, last.current);
	last.current = split;
	return <MarkdownBlocks blocks={split.blocks} />;
});
