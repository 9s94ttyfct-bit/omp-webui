import { expect, test } from "bun:test";

/** Run real native/process-global resources in a fresh process, independent of Bun worker reuse and global teardown. */
export function processIsolatedTests(file: string) {
	return (name: string, body: () => void | Promise<void>) => {
		const isolated = process.env.OMPW_ISOLATED_TEST;
		if (isolated && isolated !== name) return;
		test(name, async () => {
			if (isolated) return body();
			const proc = Bun.spawn([process.execPath, "test", file], {
				env: { ...process.env, OMPW_ISOLATED_TEST: name },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [code, out, err] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			expect(code, out + err).toBe(0);
		});
	};
}
