/**
 * Whether a sign-in question asks for a credential: omp asks "Paste your <provider> API key" (or token, or secret key)
 * as a plain question, in its RPC and in `omp login` alike, so what answers it is masked here. An authorization code or
 * a redirect address (which the person may need to read back), an account id or a number to pick is not.
 */
export function credentialQuestion(text: string): boolean {
	return /\b(key|token|secret|password)\b/i.test(text);
}
