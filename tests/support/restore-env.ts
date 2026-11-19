/**
 * Put the process's environment back as `saved` (a copy taken before the test changed it), key by key.
 *
 * `process.env = saved` is not enough in Bun (#314): child processes get the restored `TMPDIR` again, but `os.tmpdir()`
 * keeps returning the one the test set, and when the test then removes its scratch root every later file of the same
 * process makes its folders under a directory that is gone.
 */
export function restoreEnv(saved: Readonly<Record<string, string | undefined>>): void {
	for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
	for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
}
