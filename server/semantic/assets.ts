/**
 * What semantic search downloads, pinned: one llama.cpp build (its `llama-server` runs the model, on the GPU where the build
 * finds one) and one model file, each by its exact size and SHA-256. Nothing else is run or loaded: a download that is not
 * byte for byte what is listed here is refused before it is unpacked or opened.
 *
 * The llama.cpp builds are the project's own release artifacts (github.com/ggml-org/llama.cpp, release `LLAMA_BUILD`): Metal on
 * macOS on Apple silicon, Vulkan on Windows and Linux (every GPU vendor's driver has it). The Vulkan builds carry the CPU
 * backends as well and load the Vulkan one at run time: a computer without a Vulkan driver runs the model on the processor.
 * The model is ggml-org's GGUF conversion of Google's EmbeddingGemma 2 (Apache-2.0), its text part in 8-bit (Q8_0): its
 * activations need bfloat16 or float32, which llama.cpp computes Q8_0 weights in (the model card warns against float16).
 */

import { platformId } from "../platform/capabilities.ts";

export const LLAMA_BUILD = "b12340";

export interface Asset {
	/** The file's name as it is published. */
	name: string;
	/** Where it is downloaded from, in order: the next is tried when one fails. */
	urls: string[];
	size: number;
	/** Lower-case hex. */
	sha256: string;
}

export interface RuntimeAsset extends Asset {
	/** `tar` for a gzipped tarball, `zip` for a zip (Windows). */
	kind: "tar" | "zip";
}

const build = (name: string, size: number, sha256: string, kind: "tar" | "zip" = "tar"): RuntimeAsset => ({
	name,
	urls: [`https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${name}`],
	size,
	sha256,
	kind,
});

/** The build for each system (`platformId`) and processor (`process.arch`), with the GPU backend that system has. */
const RUNTIMES: Record<string, RuntimeAsset> = {
	"darwin-arm64": build(
		`llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`,
		16916010,
		"f4414a7224a2fef9e785c8673f0574be78aa914652099b40ef66890f7474e686",
	),
	"darwin-x64": build(
		`llama-${LLAMA_BUILD}-bin-macos-x64.tar.gz`,
		12666221,
		"f1e83a37961e69e3468244fa95c98a11f1cdd8f454a4a2bdb094c36c53b4a2ba",
	),
	"linux-x64": build(
		`llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-x64.tar.gz`,
		36183004,
		"bcb0b15e19e5bd4064243e347e1becbd2d9abf959ad2f4cd8768ad68fc43b51c",
	),
	"linux-arm64": build(
		`llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-arm64.tar.gz`,
		29464662,
		"9c01acd2bf8a3c661672bac2172acd2859d234c40fd7359f8997308f52922434",
	),
	"win32-x64": build(
		`llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`,
		38101437,
		"a2c7a2bfaaf57b5357f84cf584603d088143a5be08c68cb623e6d9bb7db664e8",
		"zip",
	),
	"win32-arm64": build(
		`llama-${LLAMA_BUILD}-bin-win-vulkan-arm64.zip`,
		26038125,
		"6020834a4fd9de1608349c9105d4a6d25efc7a42a7e634e69331f9d884a78414",
		"zip",
	),
};

/** The llama.cpp build for this computer, or null when there is none for its system and processor. */
export function runtimeAsset(platform: string = platformId, arch: string = process.arch): RuntimeAsset | null {
	return RUNTIMES[`${platform}-${arch}`] ?? null;
}

const MODEL_REPO = "ggml-org/embeddinggemma-2-GGUF";
/** The repository's commit the file is taken at: a later push to it changes nothing here. */
const MODEL_REVISION = "6ea3e3a309d12a4779cfda98b8c19800d2d5da71";
const MODEL_FILE = "embeddinggemma-2-Q8_0.gguf";

export const MODEL: Asset = {
	name: MODEL_FILE,
	// hf-mirror.com serves the same files where huggingface.co cannot be reached; the SHA-256 is what is trusted, not the host.
	urls: [
		`https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/${MODEL_FILE}`,
		`https://hf-mirror.com/${MODEL_REPO}/resolve/${MODEL_REVISION}/${MODEL_FILE}`,
	],
	size: 309855456,
	sha256: "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135",
};

/**
 * The hosts a download may be redirected to: GitHub's release storage, and Hugging Face's (its file storage is on `*.hf.co`).
 * Only over https; the bytes are checked against the SHA-256 whichever host gave them.
 */
export function downloadHostAllowed(url: URL): boolean {
	if (url.protocol !== "https:") return false;
	const host = url.hostname;
	return (
		host === "github.com" ||
		host.endsWith(".githubusercontent.com") ||
		host === "huggingface.co" ||
		host.endsWith(".huggingface.co") ||
		host === "hf.co" ||
		host.endsWith(".hf.co") ||
		host === "hf-mirror.com"
	);
}

/**
 * The model's prompts for search (its card's "SearchQuery" and "Document"): a query and a passage are embedded differently,
 * and a passage without a title is `title: none`.
 */
export const QUERY_PROMPT = "task: search result | query: ";
export const DOCUMENT_PROMPT = "title: none | text: ";

/**
 * The vectors are kept at 512 of the model's 768 dimensions (its Matryoshka truncation, which the card calls close to
 * lossless down to 256), normalized again after the cut.
 */
export const DIMENSIONS = 512;
