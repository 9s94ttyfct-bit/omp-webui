import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformId } from "../../server/platform/capabilities.ts";
import { RemoteStore } from "../../server/remote-config.ts";
import { assetDigest, cloudflaredAsset, Tunnel } from "../../server/remote-tunnel.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * The install of cloudflared off the Mac: Cloudflare's own build, fetched from cloudflared's latest GitHub release and
 * kept only when its SHA-256 is the one the release gives for it. A local server stands in for GitHub.
 */

const dirs: string[] = [];
const servers: { stop(): void }[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop();
	for (const d of dirs.splice(0)) removeScratch(d);
});

const ASSET = "cloudflared-test-build";
const BINARY = new TextEncoder().encode("#!/bin/sh\necho cloudflared\n");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A stand-in for GitHub: the release's description, and the asset it names (whose bytes may not be what it says). */
function github(o: { digest?: string | null; body?: string; served?: Uint8Array; status?: number } = {}) {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/latest") {
				if (o.status) return new Response("rate limited", { status: o.status });
				return Response.json({
					tag_name: "2026.10.0",
					body: o.body ?? "",
					assets: [
						{
							name: "cloudflared-other",
							browser_download_url: `${url.origin}/other`,
							digest: `sha256:${"0".repeat(64)}`,
						},
						{
							name: ASSET,
							browser_download_url: `${url.origin}/asset`,
							...(o.digest === null ? {} : { digest: o.digest ?? `sha256:${sha(BINARY)}` }),
						},
					],
				});
			}
			if (url.pathname === "/asset") return new Response(Buffer.from(o.served ?? BINARY));
			return new Response("not found", { status: 404 });
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}/latest`;
}

function tunnel(releases: string) {
	const dir = mkdtempSync(join(tmpdir(), "ompw-cf-download-"));
	dirs.push(dir);
	const dataDir = join(dir, "data");
	const t = new Tunnel({
		dataDir,
		port: () => 1,
		store: new RemoteStore(join(dataDir, "remote.json")),
		env: { PATH: join(dir, "empty"), OMP_WEBUI_CLOUDFLARED_RELEASES: releases },
		home: join(dir, "home"),
		extraDirs: [],
		downloads: true,
		asset: ASSET,
	});
	const own = join(dataDir, "cloudflared", platformId === "win32" ? "cloudflared.exe" : "cloudflared");
	return { t, own };
}

test("the build for each system and processor Cloudflare publishes", () => {
	expect(cloudflaredAsset("linux", "x64")).toBe("cloudflared-linux-amd64");
	expect(cloudflaredAsset("linux", "arm64")).toBe("cloudflared-linux-arm64");
	expect(cloudflaredAsset("linux", "arm")).toBe("cloudflared-linux-arm");
	expect(cloudflaredAsset("linux", "ia32")).toBe("cloudflared-linux-386");
	expect(cloudflaredAsset("linux", "riscv64")).toBeNull();
	expect(cloudflaredAsset("win32", "x64")).toBe("cloudflared-windows-amd64.exe");
	// Windows on Arm runs the x64 build.
	expect(cloudflaredAsset("win32", "arm64")).toBe("cloudflared-windows-amd64.exe");
	expect(cloudflaredAsset("win32", "ia32")).toBe("cloudflared-windows-386.exe");
	expect(cloudflaredAsset("darwin", "arm64")).toBeNull();
});

test("the SHA-256 is the asset's own digest, else the line the release notes give it, else there is none", () => {
	const hex = "a".repeat(64);
	const release = (digest: string | undefined, body: string) => ({
		tag_name: "v1",
		body,
		assets: [{ name: "cloudflared-linux-amd64", browser_download_url: "https://x/y", ...(digest ? { digest } : {}) }],
	});
	expect(assetDigest(release(`sha256:${hex}`, ""), "cloudflared-linux-amd64")?.sha256).toBe(hex);
	expect(
		assetDigest(release(undefined, `cloudflared-linux-amd64: ${"B".repeat(64)}\n`), "cloudflared-linux-amd64")?.sha256,
	).toBe("b".repeat(64));
	// A line of another asset whose name ends the same is not this one's.
	expect(assetDigest(release(undefined, `x-cloudflared-linux-amd64: ${hex}`), "cloudflared-linux-amd64")).toBeNull();
	expect(assetDigest(release("md5:abc", ""), "cloudflared-linux-amd64")).toBeNull();
	expect(assetDigest(release(`sha256:${hex}`, ""), "cloudflared-linux-arm64")).toBeNull();
	expect(assetDigest("not a release", "cloudflared-linux-amd64")).toBeNull();
});

test("install downloads the build into the data dir, and then it is the cloudflared found", async () => {
	const { t, own } = tunnel(github());
	expect(t.installed()).toBe(false);
	await t.install();
	expect(t.installed()).toBe(true);
	expect(new Uint8Array(readFileSync(own))).toEqual(BINARY);
	expect(existsSync(`${own}.part`)).toBe(false);
});

test("a download whose SHA-256 is not the release's is refused, and nothing is installed", async () => {
	const { t, own } = tunnel(github({ served: new TextEncoder().encode("tampered") }));
	await expect(t.install()).rejects.toThrow(/not the one Cloudflare published/);
	expect(t.installed()).toBe(false);
	expect(existsSync(own)).toBe(false);
	expect(existsSync(`${own}.part`)).toBe(false);
});

test("a release that gives no SHA-256 for the build is refused", async () => {
	const { t } = tunnel(github({ digest: null }));
	await expect(t.install()).rejects.toThrow(/no cloudflared-test-build with a SHA-256/);
	expect(t.installed()).toBe(false);
});

test("the release notes' SHA-256 is used where the asset has no digest", async () => {
	const { t } = tunnel(github({ digest: null, body: `Checksums\n${ASSET}: ${sha(BINARY)}\n` }));
	await t.install();
	expect(t.installed()).toBe(true);
});

test("GitHub refusing the ask says so", async () => {
	const { t } = tunnel(github({ status: 403 }));
	await expect(t.install()).rejects.toThrow(/HTTP 403/);
});
