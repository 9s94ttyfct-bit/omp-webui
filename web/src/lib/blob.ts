/**
 * omp keeps large images outside the transcript: an image block's data is then `blob:sha256:<hash>`, and the server hands
 * the file out at `/api/blob/<hash>`. Only a sha256 in lower-case hex names one. A block comes from a session file, which
 * can be anyone's, so anything else after the prefix is never put in an address: `blob:sha256:../session?file=…` becomes
 * `/api/session?file=…` once the browser has resolved it, a request for anything the page's own API can read, whose
 * answer would go to the model as the "image".
 */
export const BLOB_REF = "blob:sha256:";

const BLOB_HASH = /^[a-f0-9]{64}$/;

/** Whether `hash` is a sha256 in lower-case hex, the name of a stored image. */
export const isBlobHash = (hash: string): boolean => BLOB_HASH.test(hash);
