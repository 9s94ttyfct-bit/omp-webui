import { expect, test } from "bun:test";
import { projectLabels } from "../../web/src/lib/usage-projects.ts";

/**
 * What the usage tables call a folder. omp's stats name a project by the directory it files its conversations in (the
 * working directory with its separators turned into dashes, `-tmp-dev-acme-api`), which is not what the sidebar and the
 * conversation list call it (`acme-api`). The conversations know both: their file lies in that directory and they
 * record where they ran.
 */

const session = (dir: string, cwd: string, modifiedAt = 1) => ({
	file: `/home/me/.omp/agent/sessions/${dir}/2026-01-01T00-00-00-000Z_x.jsonl`,
	cwd,
	project: cwd.split("/").filter(Boolean).pop() ?? cwd,
	modifiedAt,
});

test("a folder is called what its conversations call their project, with the full path as its title", () => {
	const sessions = [session("-tmp-dev-acme-api", "/tmp/dev/acme-api"), session("-tmp-dev-docs", "/tmp/dev/docs")];
	const labels = projectLabels(["-tmp-dev-acme-api", "-tmp-dev-docs"], sessions);
	expect(labels.get("-tmp-dev-acme-api")).toEqual({ label: "acme-api", title: "/tmp/dev/acme-api" });
	expect(labels.get("-tmp-dev-docs")).toEqual({ label: "docs", title: "/tmp/dev/docs" });
});

test("the title writes the home folder as ~", () => {
	const labels = projectLabels(["-omp"], [session("-omp", "/Users/me/omp")], "/Users/me");
	expect(labels.get("-omp")).toEqual({ label: "omp", title: "~/omp" });
});

test("a folder with no conversation left keeps its directory name, for both label and title", () => {
	const labels = projectLabels(["--Volumes-Disk-old-thing--"], [session("-tmp-dev-docs", "/tmp/dev/docs")]);
	expect(labels.get("--Volumes-Disk-old-thing--")).toEqual({
		label: "--Volumes-Disk-old-thing--",
		title: "--Volumes-Disk-old-thing--",
	});
});

test("projects that share a name are told apart by their path", () => {
	const sessions = [
		session("-work-api", "/work/api"),
		session("-old-api", "/old/api"),
		session("-tmp-web", "/tmp/web"),
	];
	const labels = projectLabels(["-work-api", "-old-api", "-tmp-web"], sessions);
	expect(labels.get("-work-api")?.label).toBe("/work/api");
	expect(labels.get("-old-api")?.label).toBe("/old/api");
	expect(labels.get("-tmp-web")?.label).toBe("web");
});

test("a folder that is already a path is named like a project too", () => {
	const labels = projectLabels(["/tmp/ompw-fixture-project"], [], "/Users/me");
	expect(labels.get("/tmp/ompw-fixture-project")).toEqual({
		label: "ompw-fixture-project",
		title: "/tmp/ompw-fixture-project",
	});
});

test("when conversations of one directory disagree on the folder, the newest one decides", () => {
	const sessions = [session("-a-b-c", "/a/b-c", 1), session("-a-b-c", "/a-b/c", 9)];
	expect(projectLabels(["-a-b-c"], sessions).get("-a-b-c")?.title).toBe("/a-b/c");
});
