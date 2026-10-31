import { memo, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { useT } from "../../i18n/index.ts";
import { folder } from "../../lib/folder-api.ts";
import { type FrontMatterRow, splitFrontMatter } from "../../lib/front-matter.ts";
import { nestsTooDeep, scanNesting } from "../../lib/markdown-depth.ts";
import { linkedImage, type MdOpen, MdOpenContext } from "../../lib/md-open.ts";
import { MAX_RENDER_CHARS } from "../files/FileBody.tsx";
import { CodeBlock, MarkdownImage, markdownComponents, urlTransform } from "../Markdown.tsx";
import { MermaidBlock } from "./MermaidBlock.tsx";

/**
 * The rendering of a Markdown file in the Markdown editor (`MdEditor.tsx`), as GitHub draws one: GFM (tables, task lists,
 * strikethrough, autolinks, footnotes), code coloured by the conversation's own highlighter (`CodeBlock`), math (KaTeX,
 * `math.ts`) and Mermaid diagrams (`MermaidBlock.tsx`), each fetched the first time a text needs it, and the front matter as
 * a table of its keys (`lib/front-matter.ts`).
 *
 * It is drawn by the conversation's renderer and under its rules: HTML written in the file is shown as text, never parsed;
 * an address with a scheme react-markdown refuses (`javascript:`) is dropped; web and mail links open in a window of their
 * own; a link to another Markdown file of the folder opens it here (`MdOpenContext`); an image is shown only when it is a file
 * of the conversation's folder (by a relative path, fetched from this server) or inline, never fetched from elsewhere.
 */

/** A text that may hold math: KaTeX is fetched when one first does. */
const MATH_HINT = /\$/;

type MathPlugins = { remark: PluggableList; rehype: PluggableList };
let math: MathPlugins | null = null;
let mathLoad: Promise<MathPlugins> | null = null;

function loadMath(): Promise<MathPlugins> {
	mathLoad ??= import("./math.ts").then(
		(m) => {
			math = { remark: m.mathRemark, rehype: m.mathRehype };
			return math;
		},
		(error: unknown) => {
			mathLoad = null;
			throw error;
		},
	);
	return mathLoad;
}

/** The math plugins once `wanted` (and loaded); null until then. */
function useMath(wanted: boolean): MathPlugins | null {
	const [loaded, setLoaded] = useState(math);
	useEffect(() => {
		if (!wanted || loaded) return;
		let alive = true;
		loadMath().then(
			(m) => alive && setLoaded(m),
			() => {},
		);
		return () => {
			alive = false;
		};
	}, [wanted, loaded]);
	return wanted ? loaded : null;
}

function FrontMatterTable({ rows }: { rows: FrontMatterRow[] }) {
	const t = useT();
	// No <caption>: the prose's tables are `display: block` (so that a wide one scrolls), and a caption in one is as narrow
	// as a letter. The label is a line above it, and the table's name.
	return (
		<div data-testid="md-front-matter">
			<div className="text-xs font-medium text-faint" aria-hidden="true">
				{t("files.mdFrontMatter")}
			</div>
			<table className="md-front-matter mt-1" aria-label={t("files.mdFrontMatter")}>
				<thead className="sr-only">
					<tr>
						<th scope="col">{t("files.mdFrontMatterKey")}</th>
						<th scope="col">{t("files.mdFrontMatterValue")}</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: a key may be written twice; the rows of one text never move
						<tr key={i}>
							<th scope="row" className="font-mono">
								{row.key}
							</th>
							<td className="whitespace-pre-wrap">{row.value}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

/** A task list's box: it says what it marks (GFM draws a bare checkbox, which a screen reader reads as "checkbox"). */
function TaskBox({ checked }: { checked: boolean }) {
	const t = useT();
	return (
		<input
			type="checkbox"
			checked={checked}
			disabled
			readOnly
			aria-label={checked ? t("files.mdTaskDone") : t("files.mdTaskOpen")}
		/>
	);
}

const gfm: PluggableList = [remarkGfm];

export const MdPreview = memo(function MdPreview({
	text,
	open,
	version,
}: {
	text: string;
	/** The conversation, and the folder of the file (its relative links and images start there). */
	open: MdOpen;
	/** When the file last changed: in the address of its images, so that a picture written again is fetched again. */
	version: number;
}) {
	const t = useT();
	const { rows, body } = useMemo(() => splitFrontMatter(text), [text]);
	const tooDeep = useMemo(() => text.length <= MAX_RENDER_CHARS && nestsTooDeep(scanNesting(body)), [text, body]);
	const wantsMath = MATH_HINT.test(body);
	const mathPlugins = useMath(wantsMath);
	const { scope, base } = open;
	const components = useMemo<Components>(
		() => ({
			...markdownComponents,
			code({ className, children }) {
				const code = String(children ?? "");
				const lang = /language-([\w+#.-]+)/.exec(className ?? "")?.[1];
				if (lang === "mermaid") return <MermaidBlock code={code.replace(/\n$/, "")} />;
				if (!lang && !code.includes("\n")) return <code>{children}</code>;
				return <CodeBlock code={code.replace(/\n$/, "")} lang={lang ?? ""} />;
			},
			img({ src, alt }) {
				const path = linkedImage(src, base);
				if (path === null) return <MarkdownImage src={src} alt={alt} />;
				return (
					<img
						src={folder.imageUrl(scope, path, version)}
						alt={alt ?? ""}
						loading="lazy"
						className="rounded-lg"
						data-testid="md-folder-image"
					/>
				);
			},
			input({ type, checked }) {
				return type === "checkbox" ? <TaskBox checked={checked === true} /> : null;
			},
		}),
		[scope, base, version],
	);
	if (text.length > MAX_RENDER_CHARS || tooDeep) {
		return (
			<p className="text-sm text-muted" role="note" data-testid="md-preview-too-large">
				{t("files.mdTooLargeToRender")}
			</p>
		);
	}
	return (
		<MdOpenContext.Provider value={open}>
			<div className="prose-omp md-preview" data-testid="md-preview-body">
				{rows ? <FrontMatterTable rows={rows} /> : null}
				<ReactMarkdown
					remarkPlugins={mathPlugins ? [...gfm, ...mathPlugins.remark] : gfm}
					rehypePlugins={mathPlugins?.rehype}
					components={components}
					urlTransform={urlTransform}
				>
					{body}
				</ReactMarkdown>
				{wantsMath && !mathPlugins ? (
					<span className="sr-only" role="status" data-testid="md-math-pending">
						{t("files.mdMathPending")}
					</span>
				) : null}
			</div>
		</MdOpenContext.Provider>
	);
});
