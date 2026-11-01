/**
 * `import script from "./helper.sh" with { type: "text" }` (and `./helper.ps1`, the Windows launcher's): Bun embeds the
 * file's text, also in the compiled server and the compiled launcher.
 */
declare module "*.sh" {
	const text: string;
	export default text;
}
declare module "*.ps1" {
	const text: string;
	export default text;
}
