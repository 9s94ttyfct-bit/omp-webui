import {
	isProjectProblem,
	PROJECT_NAME_MAX,
	type ProjectCreated,
	type ProjectProblem,
	type ProjectsInfo,
} from "@shared/projects.ts";
import type { MessageKey, Vars } from "../i18n/index.ts";
import { ApiError } from "./api.ts";
import { errorText } from "./error-text.ts";

/** A project folder the server did not make: why, in the server's own terms (`problem`), for the page to word. */
export class ProjectRefused extends Error {
	constructor(
		message: string,
		readonly problem: ProjectProblem,
	) {
		super(message);
	}
}

async function request<T>(path: string, body?: unknown): Promise<T> {
	const res = await fetch(path, {
		method: body === undefined ? "GET" : "POST",
		headers: body === undefined ? undefined : { "content-type": "application/json", "x-omp-webui": "1" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const answer = await res.json().catch(() => ({}));
	if (res.ok) return answer as T;
	const message = typeof answer.error === "string" ? answer.error : res.statusText;
	if (isProjectProblem(answer.problem)) throw new ProjectRefused(message, answer.problem);
	// A folder that cannot be chosen is told with the codes the folder picker has (`dirNotFound`, …).
	throw new ApiError(message, res.status, answer.code, answer.params);
}

/** `/api/projects*`: the folder new projects are made in, and making one. */
export const projectsApi = {
	info: () => request<ProjectsInfo>("/api/projects"),
	/** Choose the folder (this computer only); null: the default. */
	set: (folder: string | null) => request<ProjectsInfo>("/api/projects", { folder }),
	create: (name: string) => request<ProjectCreated>("/api/projects/new", { name }),
};

type Say = (key: MessageKey, vars?: Vars) => string;

const PROBLEM_KEYS: Record<ProjectProblem, MessageKey> = {
	empty: "projects.problemEmpty",
	tooLong: "projects.problemTooLong",
	separator: "projects.problemSeparator",
	dot: "projects.problemDot",
	space: "projects.problemSpace",
	invalid: "projects.problemInvalid",
	exists: "projects.problemExists",
	folderGone: "projects.problemFolderGone",
	notFolder: "projects.problemNotFolder",
	noAccess: "projects.problemNoAccess",
	failed: "projects.problemFailed",
};

/** What is wrong with a name, or why the server refused it, as a sentence of the page's language. */
export function problemText(t: Say, problem: ProjectProblem, name: string, error = ""): string {
	return t(PROBLEM_KEYS[problem], { max: PROJECT_NAME_MAX, name, error });
}

/** Why a call failed, as a sentence of the page's language: a refused project is worded by `problemText`, anything else by `errorText`. */
export function projectsErrorText(t: Say, e: unknown, name = ""): string {
	return e instanceof ProjectRefused ? problemText(t, e.problem, name, e.message) : errorText(e);
}
