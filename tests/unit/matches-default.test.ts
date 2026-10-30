import { expect, test } from "bun:test";
import { FAST_TIERS, matchesDefault, SERVICE_TIER_FAMILIES } from "../../shared/session-defaults.ts";

/**
 * The star of a session control is filled when what the conversation uses is omp's default for new conversations
 * (#610). `defaults` is each setting a default can write, as omp resolves it for the folder.
 */

test("a setting is the default when its value is the one the choice writes", () => {
	const defaults = {
		"compaction.enabled": true,
		"retry.enabled": false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		interruptMode: "wait",
		"providers.cacheWarming": "idle",
	};
	expect(matchesDefault("autoCompaction", "on", null, defaults)).toBe(true);
	expect(matchesDefault("autoCompaction", "off", null, defaults)).toBe(false);
	expect(matchesDefault("autoRetry", "off", null, defaults)).toBe(true);
	expect(matchesDefault("autoRetry", "on", null, defaults)).toBe(false);
	expect(matchesDefault("steeringMode", "all", null, defaults)).toBe(true);
	expect(matchesDefault("steeringMode", "one-at-a-time", null, defaults)).toBe(false);
	expect(matchesDefault("followUpMode", "one-at-a-time", null, defaults)).toBe(true);
	expect(matchesDefault("interruptMode", "wait", null, defaults)).toBe(true);
	expect(matchesDefault("interruptMode", "immediate", null, defaults)).toBe(false);
	expect(matchesDefault("cacheWarming", "idle", null, defaults)).toBe(true);
	expect(matchesDefault("cacheWarming", "streaming", null, defaults)).toBe(false);
});

test("nothing is claimed for a value that is not shown, one the control does not offer, or a configuration that was not read", () => {
	const defaults = { steeringMode: "all", "providers.cacheWarming": "idle" };
	expect(matchesDefault("steeringMode", undefined, null, defaults)).toBe(false);
	expect(matchesDefault("steeringMode", "sometimes", null, defaults)).toBe(false);
	expect(matchesDefault("steeringMode", "all", null, null)).toBe(false);
	expect(matchesDefault("steeringMode", "all", null, undefined)).toBe(false);
	// A setting the configuration does not have is not one that matches.
	expect(matchesDefault("autoRetry", "on", null, defaults)).toBe(false);
	expect(matchesDefault("nope" as never, "on", null, defaults)).toBe(false);
});

test("fast mode is On for each fast tier of the family and Off for every other value, or none", () => {
	for (const family of SERVICE_TIER_FAMILIES) {
		const key = `tier.${family}`;
		for (const tier of ["priority", "ultrafast"]) {
			expect(FAST_TIERS).toContain(tier);
			expect(matchesDefault("fastMode", "on", family, { [key]: tier }), `${family} ${tier} on`).toBe(true);
			expect(matchesDefault("fastMode", "off", family, { [key]: tier }), `${family} ${tier} off`).toBe(false);
		}
		for (const tier of ["none", "default", "flex", "scale"]) {
			expect(matchesDefault("fastMode", "off", family, { [key]: tier }), `${family} ${tier} off`).toBe(true);
			expect(matchesDefault("fastMode", "on", family, { [key]: tier }), `${family} ${tier} on`).toBe(false);
		}
		// No tier set at all is not a fast one.
		expect(matchesDefault("fastMode", "off", family, {}), `${family} unset off`).toBe(true);
		expect(matchesDefault("fastMode", "on", family, {}), `${family} unset on`).toBe(false);
	}
});

test("fast mode looks at the tier of the family the model is in, and says nothing where it has none", () => {
	const defaults = { "tier.anthropic": "priority", "tier.openai": "flex" };
	expect(matchesDefault("fastMode", "on", "anthropic", defaults)).toBe(true);
	expect(matchesDefault("fastMode", "on", "openai", defaults)).toBe(false);
	expect(matchesDefault("fastMode", "off", "openai", defaults)).toBe(true);
	expect(matchesDefault("fastMode", "off", null, defaults)).toBe(false);
	expect(matchesDefault("fastMode", "on", "google", null)).toBe(false);
});
