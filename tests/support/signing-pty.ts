/**
 * Run by tests/unit/signing-identity.test.ts under a pseudo-terminal (`script -q /dev/null`), the way a person runs
 * `bun scripts/signing-identity.ts` from Terminal: `security` then has a controlling terminal, and reads a password
 * prompt from it instead of from stdin. Prints one line, `ok <result>`, when it did not hang.
 *
 *   bun signing-pty.ts make <keychain>      first-time setup: ensureIdentity
 *   bun signing-pty.ts sign <keychain> <app>  signBundle, which unlocks the keychain
 *   bun signing-pty.ts migrate <keychain>   keychainPassword on a keychain that has the old fixed password
 */
import { ensureIdentity, keychainPassword, signBundle } from "../../scripts/signing-identity.ts";

const [mode, keychain, app] = process.argv.slice(2);
if (mode === "make") console.log(`ok ${ensureIdentity(keychain)}`);
else if (mode === "sign") console.log(`ok ${signBundle(app, { keychain }).identity}`);
else if (mode === "migrate") console.log(`ok ${keychainPassword(keychain).length}`);
else throw new Error(`unknown mode ${mode}`);
