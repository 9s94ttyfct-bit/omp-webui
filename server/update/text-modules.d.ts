/** `import script from "./helper.sh" with { type: "text" }`: Bun embeds the file's text, also in the compiled server. */
declare module "*.sh" {
	const text: string;
	export default text;
}
