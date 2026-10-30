/**
 * What an address or a name of a saved Mac may be (#614, #628): the cases the macOS app's Swift validators (`parseRemoteAddress`,
 * `parseRemoteName`, macos/remotemacs.swift) are held to in tests/unit/macos-remote.test.ts, and the server's TypeScript ones
 * (`parseMacAddress`, `parseMacName`, shared/macs.ts) in the server's own test. One table for both, so that the sheet that
 * checks what is typed at once and the server that checks it again can never disagree about a case.
 *
 * The refusals are named as the Swift side names them (`AddressProblem` and `NameProblem` cases): a test of the server maps
 * them to its own codes (`notHTTPS` is "not-https", `ipAddress` is "ip-address", and so on).
 */

/** Inputs that mean the same Mac: the host `omp.example.com`. */
export const ADDRESS_SAME: readonly string[] = [
	"omp.example.com",
	"  Omp.Example.COM  ",
	"https://omp.example.com",
	"https://omp.example.com/",
	"HTTPS://omp.example.com",
	"https://omp.example.com\t",
];

/** The other addresses that are accepted: the input and the host it is. */
export const ADDRESS_OK: Record<string, string> = {
	"example.com": "example.com",
	"a.b": "a.b",
	"1example.com": "1example.com",
	"xn--mp-hna.example.com": "xn--mp-hna.example.com",
	"a-b.example.com": "a-b.example.com",
};

/** The addresses that are refused: the input and why (the Swift outcome: `AddressProblem`, `notHTTPS` with the scheme typed). */
export const ADDRESS_REFUSED: Record<string, string> = {
	"": "empty",
	"   ": "empty",
	"https://": "empty",
	"http://omp.example.com": "notHTTPS:http",
	"ftp://x.example.com": "notHTTPS:ftp",
	"omp.example.com:8443": "port",
	"https://omp.example.com:443": "port",
	"omp.example.com:abc": "notDomainName",
	"https://user@omp.example.com": "userInfo",
	"user:pw@omp.example.com": "userInfo",
	"omp.example.com/path": "path",
	"omp.example.com/?x=1": "path",
	"omp.example.com#x": "path",
	"https://omp.example.com/a": "path",
	"127.0.0.1": "ipAddress",
	"1.2.3.4": "ipAddress",
	"[::1]": "ipAddress",
	"https://[::1]/": "ipAddress",
	"2130706433": "ipAddress",
	"127.1": "ipAddress",
	"0x7f.1": "ipAddress",
	"0x7f.0x1": "ipAddress",
	"example.123": "ipAddress",
	localhost: "localName",
	"foo.local": "localName",
	"foo.localhost": "localName",
	"nas.internal": "localName",
	"router.lan": "localName",
	"printer.home.arpa": "localName",
	"host.localdomain": "localName",
	"omp.example.com.": "trailingDot",
	"ömp.example.com": "notASCII",
	"ｏｍｐ.example.com": "notASCII",
	"team.cloudflareaccess.com": "accessDomain",
	"cloudflareaccess.com": "accessDomain",
	a: "notDomainName",
	"a..b.com": "notDomainName",
	"-a.example.com": "notDomainName",
	"a-.example.com": "notDomainName",
	"a_b.example.com": "notDomainName",
	"exa mple.com": "notDomainName",
	"omp.example.com%2f": "notDomainName",
	"omp.example.com\\evil.com": "notDomainName",
	[`${"a".repeat(64)}.example.com`]: "notDomainName",
	[`${"a.".repeat(127)}com`]: "notDomainName",
};

/** The names that are kept: the input and the name as it is kept (trimmed). */
export const NAME_OK: Record<string, string> = {
	"Mac A": "Mac A",
	"  Mac A  ": "Mac A",
	Café: "Café",
	"💻 Studio": "💻 Studio",
	"<b>Mac</b>": "<b>Mac</b>",
	[`${"x".repeat(60)}`]: "x".repeat(60),
	// Sixty emoji are sixty characters, though far more bytes.
	[`${"💻".repeat(60)}`]: "💻".repeat(60),
};

/** The names that are refused: the input and why (`NameProblem`; uniqueness is the list's to say, not a name's). */
export const NAME_REFUSED: Record<string, string> = {
	"": "empty",
	"   ": "empty",
	[`${"x".repeat(61)}`]: "tooLong",
	// A line break, a bell, a zero-width space and a right-to-left override make a name that shows as another.
	"Mac\nA": "characters",
	"Mac\u0007": "characters",
	"Mac\u200BA": "characters",
	"Mac\u202EA": "characters",
};

/**
 * Names that are one name (the list refuses the second of two): the fold of both is the same, on the server (`foldMacName`,
 * shared/macs.ts) and in the app (`foldedName`, macos/remotemacs.swift). Case, accents, width, ligatures, and the letters whose
 * case mapping is not one to one: `ß` and `ẞ` are `ss`, `ς` is `σ`, `Ǆ` is `dž` (and both are `dz` without the caron).
 */
export const NAME_SAME: readonly (readonly [string, string])[] = [
	["Mac A", "mac a"],
	["MAC Á", "Mac A"],
	["Café", "CAFE\u0301"],
	["ＭＡＣ", "mac"],
	["Straße", "Strasse"],
	["STRASSE", "straße"],
	["ẞ", "ss"],
	["ß", "ẞ"],
	["ς", "σ"],
	["ΟΔΥΣΣΕΥΣ", "οδυσσευς"],
	["Ǆ", "dž"],
	["ǅ", "DŽ"],
	["ﬁle", "File"],
	["İstanbul", "istanbul"],
	["Å", "A\u030A"],
	["💻 Studio", "💻 STUDIO"],
];

/** Names that are two names: no fold of one is the fold of the other, on either side. */
export const NAME_DIFFERENT: readonly (readonly [string, string])[] = [
	["Mac A", "Mac B"],
	["Mac", "Mac 2"],
	["ß", "s"],
	["Ǆ", "d"],
	["日", "本"],
	["Studio", "Studios"],
	["💻 Studio", "Studio"],
];
