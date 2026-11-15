/**
 * Whether a sign-in question omp's RPC asks is for a credential: omp asks "Paste your <provider> API key" (or token, or
 * secret key) as a plain question, since its RPC cannot ask a `secret` one in a login, so what answers it is masked
 * here. An authorization code or a redirect address (which the person may need to read back) is not.
 */
export function credentialQuestion(text: string): boolean {
	return /\b(key|token|secret|password)\b/i.test(text);
}
