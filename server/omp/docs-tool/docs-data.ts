import { agentDocs } from "./source-macro.ts" with { type: "macro" };

/**
 * The documentation the `webui_docs` tool answers from: every file of `docs/agents/`, file name to Markdown. In the source
 * tree it is read by a macro; the copy the server installs beside the extension (`install.ts`) holds the same record written
 * out, so the extension in omp's process imports its docs and opens no file.
 */
const docs: Readonly<Record<string, string>> = agentDocs();

export default docs;
