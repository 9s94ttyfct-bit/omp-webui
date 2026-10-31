import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { APPROVAL_MODES, approvalModeNeeds } from "../../shared/approval.ts";
import { compareVersions, OMP_COMPAT, OMP_FEATURES, ompLacks } from "../../shared/omp-install.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load: they are loaded after the stubs are in place.
installGlobals();
const { useApp } = await import("../../web/src/store/app.ts");
const { ApprovalSettings } = await import("../../web/src/components/ApprovalSettings.tsx");

/**
 * The oldest omp the web UI says it supports (`OMP_COMPAT.min`) is one that has everything it offers, and one CI tests it
 * on (audit A-001, A-002). An omp older than that is warned about on every page; on it, what it lacks is not offered.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

describe("the floor", () => {
	test("OMP_COMPAT.min is at least the release of every feature the web UI offers", () => {
		for (const [feature, since] of Object.entries(OMP_FEATURES))
			expect({ feature, atLeast: compareVersions(OMP_COMPAT.min, since) >= 0 }).toEqual({ feature, atLeast: true });
	});

	test("CI tests unit + contract on OMP_COMPAT.min and the latest omp, and every day on the latest", () => {
		const ci = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8")) as {
			on: Record<string, unknown>;
			jobs: Record<string, { if?: string; strategy?: { matrix: Record<string, unknown> }; steps: { run?: string }[] }>;
		};
		const matrix = ci.jobs.tests.strategy?.matrix.omp;
		// `${{ fromJSON(<daily run> && '[…]' || '[…]') }}`: the lists of omp releases, as JSON, the daily run's first.
		expect(typeof matrix).toBe("string");
		const lists = [...String(matrix).matchAll(/'(\[[^']*\])'/g)].map((m) => JSON.parse(m[1]) as string[]);
		expect(String(matrix)).toContain("github.event_name == 'schedule'");
		expect(lists).toEqual([["latest"], [OMP_COMPAT.min, "latest"]]);
		expect(ci.on).toHaveProperty("schedule");
		// Each leg installs the omp of its own entry (a GitHub expression, `$` + `{{ matrix.omp }}`).
		const install = `"@oh-my-pi/pi-coding-agent@$${"{{ matrix.omp }}"}"`;
		expect(ci.jobs.tests.steps.some((s) => s.run?.includes(install))).toBe(true);
		// The end-to-end suite is not part of the daily run.
		expect(ci.jobs.e2e.if).toContain("github.event_name != 'schedule'");
	});
});

describe("what an omp older than a feature is not handed", () => {
	test("Ask and remember needs omp 18.12.3; the other modes need nothing beyond the floor", () => {
		expect(ompLacks("approvalModeCached", "18.12.2")).toBe("18.12.3");
		expect(approvalModeNeeds("always-ask-cached", "18.12.2")).toBe("18.12.3");
		expect(approvalModeNeeds("always-ask-cached", "18.12.3-canary.1")).toBe("18.12.3");
		expect(approvalModeNeeds("always-ask-cached", "18.12.3")).toBeNull();
		expect(approvalModeNeeds("always-ask-cached", "18.14.1")).toBeNull();
		// A version omp could not report holds nothing back on a guess.
		expect(approvalModeNeeds("always-ask-cached", "unknown")).toBeNull();
		expect(approvalModeNeeds("always-ask-cached", undefined)).toBeNull();
		for (const mode of APPROVAL_MODES.filter((m) => m !== "always-ask-cached"))
			expect(approvalModeNeeds(mode, "18.11.0")).toBeNull();
	});

	/**
	 * The settings as a page renders them where omp reports `ompVersion`. A server render reads the store's first state
	 * (zustand's server snapshot), so that is where the version goes for the render, and is put back after it.
	 */
	const settings = (ompVersion: string): string => {
		const first = useApp.getInitialState();
		const meta = first.meta;
		first.meta = { ...(meta ?? {}), ompVersion } as typeof meta;
		try {
			return renderToString(createElement(ApprovalSettings));
		} finally {
			first.meta = meta;
		}
	};
	/** The radio of `mode` in the default-mode settings, as rendered. */
	const radio = (html: string, mode: string) =>
		new RegExp(`<input[^>]*data-testid="approval-default-${mode}"[^>]*>`).exec(html)?.[0] ?? "";

	test("the default-mode settings show Ask and remember disabled, with the omp it needs, on omp 18.12.2", () => {
		const old = settings("18.12.2");
		expect(old).toContain("Needs omp 18.12.3 or newer");
		expect(radio(old, "always-ask-cached")).toContain("disabled");

		const current = settings("18.12.3");
		expect(current).not.toContain("Needs omp");
	});
});
