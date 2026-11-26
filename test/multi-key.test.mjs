import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateHome = mkdtempSync(join(tmpdir(), "exa-state-"));
process.env.DSH_HOME = stateHome;

const { ExaSearchProvider, EXA_STATE_FILE } = await import("../index.js");
const fingerprint = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16);
const MIN = 60_000;

const okBody = { results: [{ url: "https://example.com", title: "t", highlights: ["h"], publishedDate: "2026-01-01" }] };
const makeResponse = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
});
const okResponse = () => makeResponse(200, okBody);
const quotaResponse = () => makeResponse(402, { error: "You have exceeded your credits limit. Please top up.", tag: "NO_MORE_CREDITS" });
const rateLimited = (retryAfter) => makeResponse(429, { error: "Too many requests", tag: "RATE_LIMIT" }, retryAfter === undefined ? {} : { "retry-after": String(retryAfter) });
const unauthorized = () => makeResponse(401, { error: "Invalid API key", tag: "INVALID_API_KEY" });
const serverError = () => makeResponse(500, { error: "boom" });

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const key = String(init.headers.authorization).replace("Bearer ", "");
    calls.push({ url, key, body: JSON.parse(init.body) });
    return handler(key, calls.length);
  };
  return calls;
}

const provider = (apiKeys, extra = {}) => new ExaSearchProvider({
  apiKeys,
  baseURL: "https://api.exa.ai",
  searchType: "auto",
  highlightsPerResult: 1,
  ...extra,
});
const request = (query) => ({ query });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("healthy keys rotate round-robin", async () => {
  const calls = stubFetch(() => okResponse());
  const p = provider(["rr-a", "rr-b", "rr-c"]);
  for (let i = 0; i < 4; i++) await p.search(request("q"));
  assert.deepEqual(calls.map((c) => c.key), ["rr-a", "rr-b", "rr-c", "rr-a"]);
  assert.equal(calls[0].url, "https://api.exa.ai/search");
  assert.equal(calls[0].body.contents.highlights.highlightsPerUrl, 1);
});

test("quota on one key parks it and the search still succeeds on the next", async () => {
  const calls = stubFetch((key) => (key === "park-a" ? quotaResponse() : okResponse()));
  const p = provider(["park-a", "park-b"]);
  const result = await p.search(request("q"));
  assert.equal(result.sources.length, 1);
  assert.deepEqual(calls.map((c) => c.key), ["park-a", "park-b"]);
  const state = p.keyStates[fingerprint("park-a")];
  const cooldown = state.coolingUntil - Date.now();
  assert.equal(state.strikes, 1);
  assert.ok(cooldown > 4 * MIN && cooldown <= 5 * MIN, "first cooldown should be 5 min, got " + cooldown);
  await p.search(request("q"));
  assert.deepEqual(calls.map((c) => c.key), ["park-a", "park-b", "park-b"], "parked key must not be retried");
});

test("cooldown ladder climbs 5min -> 30min -> 2h and caps at 24h", async () => {
  stubFetch(() => quotaResponse());
  const p = provider(["ladder"]);
  const observed = [];
  for (let i = 0; i < 5; i++) {
    p.lastProbeAt = 0;
    await p.search(request("q")).then(() => assert.fail("expected quota failure"), () => {});
    const state = p.keyStates[fingerprint("ladder")];
    observed.push(Math.round((state.coolingUntil - Date.now()) / MIN));
  }
  assert.deepEqual(observed, [5, 30, 120, 480, 1440]);
  assert.equal(p.keyStates[fingerprint("ladder")].strikes, 5);
});

test("probe is rate limited to once a minute when every key is cooling", async () => {
  const calls = stubFetch(() => quotaResponse());
  const p = provider(["all-a", "all-b"]);
  await p.search(request("q")).then(() => assert.fail("expected quota failure"), () => {});
  assert.equal(calls.length, 2, "first search must try both keys");
  await p.search(request("q")).then(
    () => assert.fail("expected cooling failure"),
    (error) => assert.match(error.message, /every Exa API key \(2 keys\) is cooling down; next probe in about \d+ min/),
  );
  assert.equal(calls.length, 2, "no probe inside the throttle window");
});

test("429 honours Retry-After and retries the same key", async () => {
  const calls = stubFetch((key, n) => (n < 3 ? rateLimited(0) : okResponse()));
  const p = provider(["rate-a"]);
  const result = await p.search(request("q"));
  assert.equal(result.sources.length, 1);
  assert.deepEqual(calls.map((c) => c.key), ["rate-a", "rate-a", "rate-a"]);
  assert.equal(p.keyStates[fingerprint("rate-a")], undefined, "429 must not park the key");
});

test("exhausted 429 falls over to another team's key without parking", async () => {
  const calls = stubFetch((key) => (key === "busy-a" ? rateLimited(0) : okResponse()));
  const p = provider(["busy-a", "busy-b"]);
  const result = await p.search(request("q"));
  assert.equal(result.sources.length, 1);
  assert.deepEqual(calls.map((c) => c.key), ["busy-a", "busy-a", "busy-a", "busy-b"]);
  assert.equal(p.keyStates[fingerprint("busy-a")], undefined);
});

test("invalid key is parked for a day and the next key serves", async () => {
  const calls = stubFetch((key) => (key === "bad" ? unauthorized() : okResponse()));
  const p = provider(["bad", "good"]);
  await p.search(request("q"));
  assert.deepEqual(calls.map((c) => c.key), ["bad", "good"]);
  const state = p.keyStates[fingerprint("bad")];
  const cooldown = state.coolingUntil - Date.now();
  assert.ok(cooldown > 23 * 60 * MIN, "401 should park for ~24h, got " + cooldown);
});

test("a 500 aborts immediately instead of burning the other keys", async () => {
  const calls = stubFetch(() => serverError());
  const p = provider(["e-a", "e-b"]);
  await p.search(request("q")).then(
    () => assert.fail("expected failure"),
    (error) => assert.match(error.message, /boom/),
  );
  assert.equal(calls.length, 1);
  assert.equal(p.keyStates[fingerprint("e-a")], undefined, "a server error must not park the key");
  assert.equal(p.keyStates[fingerprint("e-b")], undefined);
});

test("keys resolve from EXA_API_KEYS and duplicates collapse", async () => {
  const p = provider(undefined);
  process.env.EXA_API_KEYS = "env-a, env-b env-c;env-a";
  const fromEnv = provider(undefined);
  delete process.env.EXA_API_KEYS;
  assert.deepEqual(fromEnv.options.keys, ["env-a", "env-b", "env-c"]);
  assert.deepEqual(provider(["dup", "dup"]).options.keys, ["dup"]);
  assert.deepEqual(provider("str-a,str-b").options.keys, ["str-a", "str-b"]);
  assert.equal(p.available(), false, "no key means unavailable");
});

test("cooldowns survive a provider restart", async () => {
  const calls = stubFetch(() => quotaResponse());
  const first = provider(["persist-a"]);
  await first.search(request("q")).then(() => assert.fail("expected quota failure"), () => {});
  assert.ok(existsSync(EXA_STATE_FILE), "ledger file should exist at " + EXA_STATE_FILE);
  const ledger = JSON.parse(readFileSync(EXA_STATE_FILE, "utf8"));
  assert.ok(ledger[fingerprint("persist-a")].strikes >= 1, "ledger must record the strike");
  assert.ok(!JSON.stringify(ledger).includes("persist-a"), "ledger must not contain the raw key");
  const before = calls.length;
  const second = provider(["persist-a"]);
  await second.search(request("q")).then(() => assert.fail("expected quota failure"), () => {});
  assert.equal(calls.length, before + 1, "a restarted provider may probe a parked key exactly once");
  const reloaded = second.keyStates[fingerprint("persist-a")];
  const cooldown = reloaded.coolingUntil - Date.now();
  assert.equal(reloaded.strikes, 2, "persisted strike must carry over");
  assert.ok(cooldown > 25 * MIN, "ladder must continue from the persisted strike, got " + cooldown);
  await second.search(request("q")).then(
    () => assert.fail("expected cooling failure"),
    (error) => assert.match(error.message, /cooling down/),
  );
  assert.equal(calls.length, before + 1, "the probe throttle applies after restart too");
});

let failures = 0;
for (const entry of tests) {
  try {
    await entry.fn();
    console.log("PASS  " + entry.name);
  } catch (error) {
    failures += 1;
    console.log("FAIL  " + entry.name + " :: " + error.message);
  }
}
console.log(failures === 0 ? "\nALL TESTS PASSED (" + tests.length + ")" : "\n" + failures + " FAILED");
process.exitCode = failures === 0 ? 0 : 1;
