// Live smoke check against the real Exa API, bypassing dsh entirely.
//
//   node test/live-check.mjs ["query"]
//
// It reads EXA_API_KEY / EXA_API_KEYS from ~/.dsh/.env (or the current
// environment), writes cooldowns to a throw-away ledger under /tmp so it never
// disturbs the app's real one, and prints which key served each search as a
// sha256 prefix - never the key itself. Each run spends a little Exa credit.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const envFile = process.env.DSH_ENV_FILE ?? process.env.HOME + "/.dsh/.env";
try {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (match !== null && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
} catch {
  /* no env file: fall back to the inherited environment */
}

// Always isolate the ledger: DSH_HOME is often already set by the harness,
// and this script must never park a real key in the app's ledger.
process.env.DSH_HOME = process.env.EXA_LIVE_CHECK_HOME ?? "/tmp/exa-live-check-home";
const fingerprint = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const plugin = await import(new URL("../index.js", import.meta.url).href);

const originalFetch = globalThis.fetch;
const served = [];
globalThis.fetch = async (url, init) => {
  served.push(fingerprint(String(init?.headers?.authorization ?? "").replace(/^Bearer /, "")));
  return originalFetch(url, init);
};

const provider = new plugin.ExaSearchProvider({
  environment: (name) => process.env[name],
  baseURL: plugin.EXA_DEFAULT_BASE_URL,
  searchType: plugin.EXA_DEFAULT_SEARCH_TYPE,
  highlightsPerResult: plugin.EXA_DEFAULT_HIGHLIGHTS_PER_RESULT
});
console.log("keys configured:", provider.options.keys.length, "| available:", provider.available());
console.log("ledger:", plugin.EXA_STATE_FILE);

const query = process.argv[2] ?? "exa api pricing";
try {
  const result = await provider.search({ query, maxResults: 2 });
  console.log("OK", JSON.stringify({ query, sources: result.sources.length, first: result.sources[0]?.url ?? null, servedBy: served.at(-1) }));
} catch (error) {
  console.log("FAILED", JSON.stringify({ query, name: error.name, tag: error.tag ?? null, message: String(error.message).slice(0, 200) }));
}
try {
  const ledger = JSON.parse(readFileSync(plugin.EXA_STATE_FILE, "utf8"));
  console.log("ledger after:", JSON.stringify(ledger));
} catch {
  console.log("ledger after: all keys healthy (empty)");
}
