import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd with the bindings from wrangler.jsonc. The values below replace
// the production values and stand in for the secrets; none of them is a real credential.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					GOOGLE_CLIENT_ID: "test-google-client-id",
					GOOGLE_CLIENT_SECRET: "test-google-client-secret",
					KBTRADING_ACCESS_TOKEN: "test-kbtrading-shared-secret",
					KBTRADING_MCP_URL: "https://mcp-kbtrading.nasta-univers.com/mcp",
					MCP_RESOURCE: "http://localhost:8789/mcp",
				},
			},
		}),
	],
});
