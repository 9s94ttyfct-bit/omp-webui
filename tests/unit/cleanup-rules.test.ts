import { describe, expect, test } from "bun:test";
import {
	dependencyCandidate,
	depUse,
	type FolderUser,
	folderUse,
	isWithin,
	type Protected,
	protectedReason,
} from "../../server/sessions/cleanup-rules.ts";
import type { UsedBy } from "../../shared/delete-cleanup.ts";

const p: Protected = { home: "/Users/me", data: ["/Users/me/.omp", "/Users/me/Library/Application Support/omp-webui"] };

describe("protectedReason", () => {
	test("the home folder and every folder above it are never offered", () => {
		expect(protectedReason("/Users/me", p)).toBe("home");
		expect(protectedReason("/Users", p)).toBe("system");
		expect(protectedReason("/", p)).toBe("system");
	});

	test("shared temporary folders are not offered themselves, a folder inside one is", () => {
		for (const dir of ["/tmp", "/private/tmp", "/private/var", "/private/var/folders/ab/xyz/T"])
			expect(protectedReason(dir, p)).toBe("system");
		expect(protectedReason("/private/tmp/scratch", p)).toBeNull();
		expect(protectedReason("/private/var/folders/ab/xyz/T/ompw-scratch", p)).toBeNull();
	});

	test("nothing inside the system's folders, a volume's root or the home's Library is offered", () => {
		for (const dir of [
			"/System/Library",
			"/usr/local/lib",
			"/Applications/Foo.app",
			"/Volumes/Backup",
			"/Users/me/Library/Caches/x",
		])
			expect(protectedReason(dir, p)).toBe("system");
		expect(protectedReason("/Volumes/Backup/project", p)).toBeNull();
	});

	test("omp's and omp-webui's data, a folder above it and a folder in it are refused", () => {
		expect(protectedReason("/Users/me/.omp", p)).toBe("data");
		expect(protectedReason("/Users/me/.omp/agent/sessions", p)).toBe("data");
		expect(protectedReason("/Users/me/code/app", p)).toBeNull();
	});
});

describe("folderUse", () => {
	const user = (real: string, kind: UsedBy["kind"], name = real, pid?: number): FolderUser => ({
		real,
		who: pid === undefined ? { kind, name } : { kind, name, pid },
	});

	test("another conversation in the same folder makes it in use", () => {
		expect(folderUse("/Users/me/code/app", [user("/Users/me/code/app", "conversation", "Fix CI")], p)).toEqual({
			refused: "inUse",
			usedBy: [{ kind: "conversation", name: "Fix CI" }],
		});
	});

	test("a project or conversation in a folder that holds it makes it in use, unless that folder is the home", () => {
		expect(folderUse("/Users/me/code/app/sub", [user("/Users/me/code/app", "project")], p).refused).toBe("inUse");
		expect(folderUse("/Users/me/code/app", [user("/Users/me", "conversation")], p).refused).toBeNull();
	});

	test("a conversation in the projects folder does not hold a new project's folder in it; one in the folder does", () => {
		const withProjects = { ...p, shared: ["/Users/me/omp"] };
		const chats = [user("/Users/me/omp", "conversation", "Old chat")];
		expect(folderUse("/Users/me/omp/chat-2026-11-12-1341", chats, withProjects).refused).toBeNull();
		expect(folderUse("/Users/me/omp/chat-2026-11-12-1341", chats, p).refused).toBe("inUse");
		expect(folderUse("/Users/me/omp", chats, withProjects).refused).toBe("inUse");
	});

	test("a process or Terminal tab counts only in the folder or inside it", () => {
		expect(
			folderUse("/Users/me/code/app", [user("/", "process"), user("/Users/me/code", "terminal")], p).refused,
		).toBeNull();
		expect(folderUse("/Users/me/code/app", [user("/Users/me/code/app/web", "process", "node", 7)], p)).toEqual({
			refused: "containsOther",
			usedBy: [{ kind: "process", name: "node", pid: 7 }],
		});
	});

	test("in use wins over contains-another, and every user is named once", () => {
		const r = folderUse(
			"/Users/me/code/app",
			[
				user("/Users/me/code/app/x", "conversation", "a"),
				user("/Users/me/code/app", "project", "b"),
				user("/Users/me/code/app/y", "project", "b"),
			],
			p,
		);
		expect(r).toEqual({
			refused: "inUse",
			usedBy: [
				{ kind: "conversation", name: "a" },
				{ kind: "project", name: "b" },
			],
		});
	});

	test("a sibling folder that shares a prefix is not inside", () => {
		expect(isWithin("/Users/me/code/app-2", "/Users/me/code/app")).toBe(false);
		expect(folderUse("/Users/me/code/app", [user("/Users/me/code/app-2", "conversation")], p).refused).toBeNull();
	});
});

describe("depUse", () => {
	test("only what runs in the conversation's folder or inside it blocks a dependency folder", () => {
		const active: FolderUser[] = [
			{ real: "/Users/me/code/app/web", who: { kind: "process", name: "node", pid: 9 } },
			{ real: "/Users/me/code/other", who: { kind: "terminal", name: "" } },
		];
		expect(depUse("/Users/me/code/app", active)).toEqual([{ kind: "process", name: "node", pid: 9 }]);
		expect(depUse("/Users/me/code/elsewhere", active)).toEqual([]);
	});
});

describe("dependencyCandidate", () => {
	const none = () => false;
	const only =
		(...names: string[]) =>
		(n: string) =>
			names.includes(n);

	test("node_modules always; a virtualenv only with pyvenv.cfg; Cargo's target only with CACHEDIR.TAG", () => {
		expect(dependencyCandidate("node_modules", none, none)).toEqual({ kind: "node_modules", needsIgnored: false });
		expect(dependencyCandidate(".venv", none, none)).toBeNull();
		expect(dependencyCandidate(".venv", none, only("pyvenv.cfg"))?.kind).toBe(".venv");
		expect(dependencyCandidate("target", none, none)).toBeNull();
		expect(dependencyCandidate("target", none, only("CACHEDIR.TAG"))?.kind).toBe("target");
	});

	test("Pods beside a Podfile.lock; Gradle's and vendor folders only when git ignores them", () => {
		expect(dependencyCandidate("Pods", only("Podfile.lock"), none)?.kind).toBe("Pods");
		expect(dependencyCandidate("build", none, none)).toBeNull();
		expect(dependencyCandidate("build", only("settings.gradle.kts"), none)).toEqual({
			kind: "build",
			needsIgnored: true,
		});
		expect(dependencyCandidate("vendor", only("go.mod"), none)).toEqual({ kind: "vendor", needsIgnored: true });
		expect(dependencyCandidate("src", only("go.mod"), none)).toBeNull();
	});
});
