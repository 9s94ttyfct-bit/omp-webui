import { expect, type Page } from "@playwright/test";

/**
 * Counting the renders of components of the page, with no seam in the app: the page is given a React DevTools hook
 * (`COUNT_RENDERS`, an init script) that sees every commit, a component is found from an element it draws
 * (`countRendersOf`), and a commit in which that component rendered again, which React marks on its fiber, is counted. The
 * component is found by its identity, not its name, which a production build shortens. Its first instance in the page is
 * counted, or every instance that draws inside an element (`Of.within`). Several components can be counted at once, each
 * under a name of its own (the default one when no name is given).
 *
 * React never clears that mark on a fiber that a later commit passes by, so the mark alone counts a component again for
 * every commit anywhere in the page after its last render (a timer, a list refreshing, a tab drawing itself). A commit
 * that touches a component swaps in the other fiber of its pair: only a commit that left a different fiber than the one
 * before it, and marked it, is a render of the component.
 */

interface Fiber {
	type: unknown;
	flags: number;
	/** A component's props (a text's own fiber has its string instead; only components' are read). */
	memoizedProps: object;
	stateNode: unknown;
	child: Fiber | null;
	sibling: Fiber | null;
	return: Fiber | null;
}

interface Probe {
	type: unknown;
	/** Count every instance that draws inside the element this CSS selector finds; `null`: the first instance in the page. */
	within: string | null;
	/** The counted fibers as the last commit left them: a commit that renders an instance leaves the other half of its pair. */
	last: Set<Fiber>;
	renders: number;
}

/** The instances of `type` counted in the tree under `top`: the first one, or every one that draws inside `within`. */
type Instances = (top: Fiber, type: unknown, within: string | null) => Fiber[];

const DEFAULT = "default";

/** `page.addInitScript(COUNT_RENDERS)` before the page loads. */
export const COUNT_RENDERS = () => {
	const probes: Record<string, Probe> = {};
	Reflect.set(window, "__renders", probes);
	const instances: Instances = (top, type, within) => {
		const found: Fiber[] = [];
		const walk = (fiber: Fiber): boolean => {
			if (fiber.type === type) {
				if (within === null) {
					found.push(fiber);
					return true;
				}
				// Where the instance draws: the first element under it.
				let host: Fiber | null = fiber;
				while (host && typeof host.type !== "string") host = host.child;
				if (host?.stateNode instanceof Element && host.stateNode.closest(within)) found.push(fiber);
			}
			for (let child = fiber.child; child; child = child.sibling) if (walk(child)) return true;
			return false;
		};
		walk(top);
		return found;
	};
	Reflect.set(window, "__renderInstances", instances);
	Reflect.set(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
		supportsFiber: true,
		isDisabled: false,
		renderers: new Map(),
		inject() {
			return 1;
		},
		onCommitFiberRoot(_id: number, root: { current: Fiber }) {
			for (const probe of Object.values(probes)) {
				const now = instances(root.current, probe.type, probe.within);
				// React's mark for a component that rendered again (1): the constant is written out, for the page has no other way to know it.
				for (const fiber of now) if (!probe.last.has(fiber) && fiber.flags & 1) probe.renders++;
				probe.last = new Set(now);
			}
		},
		onPostCommitFiberRoot() {},
		onCommitFiberUnmount() {},
		checkDCE() {},
	});
};

/** A component to count that a test id alone does not name. */
export interface Of {
	/** An element the component draws: a CSS selector. */
	element: string;
	/** Props the component takes: the nearest component above the element that takes every one of them, not the nearest one. */
	props?: readonly string[];
	/** Every instance of the component that draws inside the element this CSS selector finds is counted, not the first one in the page. */
	within?: string;
}

/**
 * From here on, count the renders of the component that draws the element with this test id (the nearest one above it),
 * or the one `of` describes, under `name`. Counting a component again resets its count.
 */
export async function countRendersOf(page: Page, of: string | Of, name = DEFAULT): Promise<void> {
	const { element, props = [], within = null } = typeof of === "string" ? { element: `[data-testid="${of}"]` } : of;
	await page.evaluate(
		({ selector, takes, inside, probeName }) => {
			const el = document.querySelector(selector);
			if (!el) throw new Error(`${selector} is not on the page`);
			const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
			if (!key) throw new Error("the element has no fiber");
			let fiber: Fiber | null = Reflect.get(el, key);
			for (; fiber; fiber = fiber.return) {
				const props = fiber.memoizedProps;
				if (typeof fiber.type === "function" && takes.every((p) => p in props)) break;
			}
			if (!fiber) throw new Error(`no component ${takes.length ? `taking ${takes.join(", ")} ` : ""}draws the element`);
			// Where the component is now: from the top of the tree the element's fiber is in, which is the tree on screen.
			let top: Fiber = fiber;
			while (top.return) top = top.return;
			const instances: Instances = Reflect.get(window, "__renderInstances");
			const probes: Record<string, Probe> = Reflect.get(window, "__renders");
			// The top fiber's own node is React's root, whose `current` is the tree on screen.
			const root = top.stateNode as { current: Fiber };
			probes[probeName] = {
				type: fiber.type,
				within: inside,
				last: new Set(instances(root.current, fiber.type, inside)),
				renders: 0,
			};
		},
		{ selector: element, takes: props, inside: within, probeName: name },
	);
}

/** The renders counted under `name` since `countRendersOf`. */
export const rendersCounted = (page: Page, name = DEFAULT): Promise<number> =>
	page.evaluate((probeName) => {
		const probes: Record<string, Probe> = Reflect.get(window, "__renders");
		return probes[probeName]?.renders ?? 0;
	}, name);

/** After the page's next frame: what a state change schedules has been drawn. */
export const painted = (page: Page): Promise<void> =>
	page.evaluate(() => {
		const { promise, resolve } = Promise.withResolvers<void>();
		requestAnimationFrame(() => resolve());
		return promise;
	});

/**
 * Wait until the page has stopped drawing what it was still loading when counting began: the answers that come late
 * (`/api/model-config`, `/api/usage`, `/api/prefs`, a conversation's own reads) each redraw the conversation once, and a
 * snapshot taken before they are in would take that render for the test's own. The network is idle, and the count under
 * `name` holds still across a whole poll.
 */
export async function settled(page: Page, name = DEFAULT): Promise<void> {
	await page.waitForLoadState("networkidle");
	let seen = -1;
	await expect
		.poll(
			async () => {
				const now = await rendersCounted(page, name);
				const still = now === seen;
				seen = now;
				return still;
			},
			{ intervals: [1000], timeout: 20_000 },
		)
		.toBe(true);
}
