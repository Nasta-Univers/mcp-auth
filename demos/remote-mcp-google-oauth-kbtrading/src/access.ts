/**
 * Server-side access policy for the KB Trading MCP server. Changing either list requires
 * a commit and a deploy of this Worker, so every change to who can reach KB Trading is
 * reviewed and auditable. It is independent of the AMAT Worker's list: being allowed on
 * AMAT gives no access here.
 */

// The only Google accounts allowed to obtain an MCP token. Compared after normalizeEmail().
export const ALLOWED_EMAILS: ReadonlySet<string> = new Set([
	"dg@nasta-univers.com",
	"taliby@nasta-univers.com",
	"tdiakhaby@nasta-univers.com",
	"aminatou@nasta-univers.com",
	"mbalde@nasta-univers.com",
]);

// The Google Workspace that must own the account, checked on Google's `hd` claim in addition
// to the exact address: a personal Google account created with an allowed address (or an
// old "conflicting" one) has no `hd` and is refused.
export const REQUIRED_HOSTED_DOMAIN = "nasta-univers.com";

export function isRequiredHostedDomain(hostedDomain: unknown): boolean {
	return (
		typeof hostedDomain === "string" &&
		hostedDomain.trim().toLowerCase() === REQUIRED_HOSTED_DOMAIN
	);
}

// Claude's OAuth callbacks for remote MCP connectors. An authorization request whose
// redirect_uri is not listed here is refused before any consent or Google redirect,
// so a client registered through /register cannot obtain a token for itself.
export const ALLOWED_REDIRECT_URIS: ReadonlySet<string> = new Set([
	"https://claude.ai/api/mcp/auth_callback",
	"https://claude.com/api/mcp/auth_callback",
]);

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function isAllowedEmail(email: unknown): boolean {
	return typeof email === "string" && ALLOWED_EMAILS.has(normalizeEmail(email));
}

export function isAllowedRedirectUri(redirectUri: unknown): boolean {
	return typeof redirectUri === "string" && ALLOWED_REDIRECT_URIS.has(redirectUri);
}
