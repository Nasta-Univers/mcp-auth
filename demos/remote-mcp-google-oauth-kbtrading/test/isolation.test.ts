import { describe, expect, it } from "vitest";
// The AMAT Worker's configuration is only read, to prove the two Workers share nothing.
import amatWranglerText from "../../remote-mcp-google-oauth/wrangler.jsonc?raw";
import accessSource from "../src/access.ts?raw";
import googleHandlerSource from "../src/google-handler.ts?raw";
import indexSource from "../src/index.ts?raw";
import relaySource from "../src/kbtrading-relay.ts?raw";
import mcpPolicySource from "../src/mcp-policy.ts?raw";
import pagesSource from "../src/pages.ts?raw";
import utilsSource from "../src/utils.ts?raw";
import kbWranglerText from "../wrangler.jsonc?raw";
import { ALLOWED_EMAILS } from "../src/access";
import { ALLOWED_UPSTREAM_URLS } from "../src/kbtrading-relay";

type WranglerConfig = {
	name: string;
	vars: Record<string, string>;
	kv_namespaces: { binding: string; id: string }[];
};

/** Parses Wrangler's JSONC: drops comments outside strings, then trailing commas. */
function parseJsonc(text: string): WranglerConfig {
	let json = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			json += char;
			if (char === "\\") json += text[++i];
			else if (char === '"') inString = false;
		} else if (char === '"') {
			inString = true;
			json += char;
		} else if (char === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			json += "\n";
		} else if (char === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2) + 1;
		} else {
			json += char;
		}
	}
	return JSON.parse(json.replace(/,(\s*[}\]])/g, "$1"));
}

const kb = parseJsonc(kbWranglerText);
const amat = parseJsonc(amatWranglerText);

const SOURCES: Record<string, string> = {
	"access.ts": accessSource,
	"google-handler.ts": googleHandlerSource,
	"index.ts": indexSource,
	"kbtrading-relay.ts": relaySource,
	"mcp-policy.ts": mcpPolicySource,
	"pages.ts": pagesSource,
	"utils.ts": utilsSource,
};

describe("KB Trading Worker configuration", () => {
	it("names the KB Trading Worker, resource and upstream", () => {
		expect(kb.name).toBe("kbtrading-mcp-oauth");
		expect(kb.vars.MCP_RESOURCE).toBe("https://kbtrading-mcp-oauth.mbalde.workers.dev/mcp");
		expect(kb.vars.KBTRADING_MCP_URL).toBe("https://mcp-kbtrading.nasta-univers.com/mcp");
		expect(ALLOWED_UPSTREAM_URLS.has(kb.vars.KBTRADING_MCP_URL)).toBe(true);
	});

	it("keeps secrets out of the versioned configuration", () => {
		expect(Object.keys(kb.vars).sort()).toEqual(["KBTRADING_MCP_URL", "MCP_RESOURCE"]);
		for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "KBTRADING_ACCESS_TOKEN"]) {
			expect(kbWranglerText).not.toMatch(new RegExp(`"${name}"\\s*:`));
		}
	});

	it("binds its own KV namespace under the name the OAuth library requires", () => {
		expect(kb.kv_namespaces).toHaveLength(1);
		expect(kb.kv_namespaces[0].binding).toBe("OAUTH_KV");
	});
});

describe("isolation from the AMAT Worker", () => {
	it("uses another Worker name, resource and KV namespace", () => {
		expect(kb.name).not.toBe(amat.name);
		expect(kb.vars.MCP_RESOURCE).not.toBe(amat.vars.MCP_RESOURCE);
		const amatKvIds = amat.kv_namespaces.map((namespace) => namespace.id);
		for (const namespace of kb.kv_namespaces) expect(amatKvIds).not.toContain(namespace.id);
	});

	it("uses its own upstream variable, and the relay cannot reach the AMAT server", () => {
		expect(Object.keys(kb.vars).some((name) => name.startsWith("AMAT"))).toBe(false);
		expect(kb.vars.KBTRADING_MCP_URL).not.toBe(amat.vars.AMAT_MCP_URL);
		for (const url of ALLOWED_UPSTREAM_URLS) {
			expect(new URL(url).hostname).toBe("mcp-kbtrading.nasta-univers.com");
		}
	});

	it("has an allowlist of its own", () => {
		expect([...ALLOWED_EMAILS].sort()).toEqual([
			"aminatou@nasta-univers.com",
			"dg@nasta-univers.com",
			"mbalde@nasta-univers.com",
			"taliby@nasta-univers.com",
			"tdiakhaby@nasta-univers.com",
		]);
	});

	it.each(Object.entries(SOURCES))(
		"keeps %s inside this project, with no AMAT endpoint or variable",
		(_file, source) => {
			const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
			for (const specifier of imports) {
				// Only this project's own files (./x) or installed packages.
				expect(specifier.startsWith("../")).toBe(false);
				expect(specifier).not.toMatch(/remote-mcp-google-oauth|amat/i);
			}
			expect(source).not.toMatch(
				/mcp-amat\.nasta-univers\.com|AMAT_MCP_URL|AMAT_ACCESS_TOKEN/,
			);
		},
	);
});
