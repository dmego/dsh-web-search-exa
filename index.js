// Local adaptation for dsh 0.2.2-rc.5 (see ADAPTATION.md).
// A workspace `link:` bundle is imported from its real path, where the loader's
// bare @deepseek-ai/* specifier rewriting does not apply. These self-contained
// equivalents replace the DSH runtime imports so the module can load.
//
// Multi-key support (local addition, not present in @deepseek-ai/dsh-web-search-exa@0.2.2-rc.1):
// several API keys may be configured - meaningful only across different Exa teams,
// because credits and QPS are billed per team. Healthy keys rotate round-robin; a key
// that answers 402 / tag NO_MORE_CREDITS is parked with an increasing cooldown
// (5min -> 30min -> 2h -> 8h -> 24h) instead of being retried on every search.
// Exa publishes no credit-reset timestamp, so the ladder is a bounded guess: the 24h
// cap matches the monthly Starter reset granularity while keeping probe traffic near zero.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

class WebError extends Error {
	constructor(message, code, options) {
		super(message, options);
		this.name = "WebError";
		this.code = code;
	}
}
function launchEnvironmentOf() {
	return { get: (key) => process.env[key] !== undefined ? { value: process.env[key] } : void 0 };
}
/**
* Resolve environment values the way the rest of DSH does: the launcher's snapshot
* first (so `~/.dsh/.env` and the workspace `.env` count), then `process.env`.
* The snapshot is a context slot, not a global, which is why the ctx is threaded through.
*/
function environmentReaderOf(ctx) {
	let snapshot;
	try {
		snapshot = typeof ctx?.get === "function" ? ctx.get("launchEnvironment") : void 0;
	} catch {
		snapshot = void 0;
	}
	return (name) => {
		if (typeof snapshot?.get === "function") {
			try {
				const entry = snapshot.get(name);
				if (entry !== void 0 && typeof entry.value === "string") return entry.value;
			} catch {
				/* fall through to process.env */
			}
		}
		return launchEnvironmentOf().get(name)?.value;
	};
}
//#region lib/types/provider.js
/**
* `ExaSearchProvider`: a `WebSearchProvider` backed by the Exa search API (`POST /search` with
* highlight contents). It maps the first non-blank highlight to `snippet`, maps
* `publishedDate` to `publishedAt`, drops entries without a snippet, and omits `content`
* because Exa returns no generated answer.
* @module @local/dsh-web-search-exa/provider
*/
/** Stable id this provider registers under. */
const EXA_PROVIDER_ID = "exa";
/** Default Exa search endpoint; `/search` is the operation. */
const EXA_DEFAULT_BASE_URL = "https://api.exa.ai";
/** Default retrieval mode: let Exa pick between keyword and neural search. */
const EXA_DEFAULT_SEARCH_TYPE = "auto";
/** Default number of highlight sentences requested per result. */
const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT = 1;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = "deepseek-harness/0.0.1";
/** Tag Exa puts on a credit-exhaustion error body. */
const EXA_QUOTA_TAG = "NO_MORE_CREDITS";
/** Cooldown applied to a key after each consecutive credit-exhaustion answer. */
const EXA_COOLDOWN_LADDER_MS = [5 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000, 24 * 3_600_000];
/** Cooldown for a key Exa rejects outright (401/403); retried once a day at most. */
const EXA_INVALID_KEY_COOLDOWN_MS = 24 * 3_600_000;
/** Same-key retries after a 429, honouring `Retry-After`. */
const EXA_RATE_LIMIT_RETRIES = 2;
/** Upper bound on one `Retry-After` sleep, so a search never stalls for minutes. */
const EXA_RATE_LIMIT_SLEEP_CAP_MS = 5_000;
/** Minimum spacing between probe attempts once every key is cooling. */
const EXA_PROBE_INTERVAL_MS = 60_000;
/** Persisted cooldown ledger; keyed by a hash so no API key is written to disk. */
const EXA_STATE_FILE = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "cache", "exa-key-state.json");
/** How long a stale ledger entry is kept before it is pruned on load. */
const EXA_STATE_RETENTION_MS = 7 * 24 * 3_600_000;
/**
* Map one Exa result to a normalized source, or `undefined` when it carries no
* portable snippet (an entry with no highlight is dropped — the seam has no
* other field to derive a snippet from, and inventing one would lie).
*
* @param result - one entry of Exa's `results[]`.
* @returns the normalized source, or `undefined` when the entry has no
*   non-blank highlight.
*/
function mapExaResult(result) {
	const snippet = result.highlights?.find((highlight) => highlight.trim().length > 0);
	if (snippet === void 0) return void 0;
	return {
		url: result.url,
		...result.title != null && result.title.length > 0 ? { title: result.title } : {},
		snippet,
		...result.publishedDate != null && result.publishedDate.length > 0 ? { publishedAt: result.publishedDate } : {}
	};
}
/**
* Map an Exa response envelope to a normalized search result.
*
* @param response - the parsed `POST /search` response body.
* @returns the normalized result; snippet-less entries are dropped
*   ({@link mapExaResult}).
*/
function mapExaResponse(response) {
	return {
		sources: (response.results ?? []).map(mapExaResult).filter((source) => source !== void 0),
		truncated: false
	};
}
/** A 402 / NO_MORE_CREDITS answer: park this key instead of surfacing it. */
class ExaQuotaError extends WebError {
	constructor(message, tag) {
		super(message, "WEB_PROVIDER_ERROR");
		this.name = "ExaQuotaError";
		this.tag = tag;
	}
}
/** A 401 / 403 answer: this key is not usable at all for now. */
class ExaInvalidKeyError extends WebError {
	constructor(message, tag) {
		super(message, "WEB_PROVIDER_ERROR");
		this.name = "ExaInvalidKeyError";
		this.tag = tag;
	}
}
/** A 429 that outlived its same-key retries; the next key may belong to another team. */
class ExaRateLimitError extends WebError {
	constructor(message, tag) {
		super(message, "WEB_PROVIDER_ERROR");
		this.name = "ExaRateLimitError";
		this.tag = tag;
	}
}
/** True for a request limit that can be sent to Exa (a positive whole number). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}
/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL) {
	return typeof baseURL === "string" && URL.canParse(baseURL);
}
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
/** Stable non-reversible id for one key, used as the ledger field name. */
function keyFingerprint(key) {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
/** Split a comma/space/semicolon separated key list, dropping blanks. */
function parseKeyList(raw) {
	return typeof raw === "string" ? raw.split(/[\s,;]+/).map((part) => part.trim()).filter((part) => part.length > 0) : [];
}
/**
* Resolve the configured keys, first entry wins per source. Precedence:
* config `apiKeys` -> env `EXA_API_KEYS` -> config `apiKey` -> env `EXA_API_KEY`.
* Duplicates are collapsed so one key never occupies two slots.
*/
function normalizeKeys(options, envValue) {
	const candidates = [];
	if (Array.isArray(options.apiKeys)) candidates.push(...options.apiKeys);
	else candidates.push(...parseKeyList(options.apiKeys));
	candidates.push(...parseKeyList(envValue("EXA_API_KEYS")));
	if (typeof options.apiKey === "string" && options.apiKey.length > 0) candidates.push(options.apiKey);
	candidates.push(...parseKeyList(envValue("EXA_API_KEY")));
	const seen = new Set();
	const keys = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const key = candidate.trim();
		if (key.length === 0 || seen.has(key)) continue;
		seen.add(key);
		keys.push(key);
	}
	return keys;
}
/** Read the cooldown ledger; a missing or damaged file simply means "no history". */
function loadKeyStates() {
	try {
		const parsed = JSON.parse(readFileSync(EXA_STATE_FILE, "utf8"));
		const cutoff = Date.now() - EXA_STATE_RETENTION_MS;
		const states = {};
		for (const [id, value] of Object.entries(parsed)) {
			if (value === null || typeof value !== "object") continue;
			const strikes = Number.isInteger(value.strikes) && value.strikes > 0 ? value.strikes : 0;
			const coolingUntil = Number.isFinite(value.coolingUntil) ? value.coolingUntil : 0;
			if (strikes === 0 && coolingUntil < cutoff) continue;
			states[id] = { strikes, coolingUntil };
		}
		return states;
	} catch {
		return {};
	}
}
/** Persist the cooldown ledger atomically; failures are never fatal to a search. */
function saveKeyStates(states) {
	try {
		mkdirSync(dirname(EXA_STATE_FILE), { recursive: true });
		const temporary = `${EXA_STATE_FILE}.tmp`;
		writeFileSync(temporary, JSON.stringify(states), { mode: 0o600 });
		renameSync(temporary, EXA_STATE_FILE);
	} catch {
		/* best-effort: an unwritable cache only costs one probe per restart */
	}
}
/** `Retry-After` in milliseconds, as seconds or an HTTP date; undefined when absent. */
function parseRetryAfterMs(headers) {
	const raw = typeof headers?.get === "function" ? headers.get("retry-after") : null;
	if (raw === null || raw === void 0 || raw === "") return void 0;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	const timestamp = Date.parse(raw);
	if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
	return void 0;
}
/** Sleep, rejecting as `WEB_ABORTED` when the request is cancelled meanwhile. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const abort = () => {
			cleanup();
			reject(new WebError("Exa search aborted", "WEB_ABORTED"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		};
		if (signal?.aborted) {
			abort();
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort);
	});
}
/** Read the human message and machine tag out of a non-OK Exa response. */
async function readExaError(response) {
	let message = `Exa API error (HTTP ${response.status})`;
	let tag;
	try {
		const parsed = await response.json();
		const detail = parsed.error ?? parsed.message;
		if (typeof detail === "string" && detail.length > 0) message = detail;
		if (typeof parsed.tag === "string" && parsed.tag.length > 0) tag = parsed.tag;
	} catch (error) {
		if (isAbortError(error)) throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: error });
	}
	return { message, tag };
}
/**
* The Exa-backed search provider. With several keys it rotates round-robin across the
* healthy ones, keeps credit-exhausted keys in an increasing cooldown, and only probes
* a cooling key (at most once a minute) when no healthy key is left.
*/
var ExaSearchProvider = class {
	id = "exa";
	constructor(options) {
		const readEnvironment = typeof options.environment === "function" ? options.environment : (name) => launchEnvironmentOf().get(name)?.value;
		this.options = {
			keys: normalizeKeys(options, readEnvironment),
			baseURL: options.baseURL,
			searchType: options.searchType,
			highlightsPerResult: options.highlightsPerResult,
			...options.numResults !== void 0 ? { numResults: options.numResults } : {}
		};
		this.keyStates = loadKeyStates();
		this.lastUsedId = void 0;
		this.lastProbeAt = 0;
	}
	available() {
		return this.options.keys.length > 0 && isValidBaseUrl(this.options.baseURL) && isPositiveInteger(this.options.highlightsPerResult) && (this.options.numResults === void 0 || isPositiveInteger(this.options.numResults));
	}
	/** Cooldown record for one key, created lazily so healthy keys stay untouched. */
	stateOf(key) {
		const id = keyFingerprint(key);
		let state = this.keyStates[id];
		if (state === void 0) {
			state = { strikes: 0, coolingUntil: 0 };
			this.keyStates[id] = state;
		}
		return state;
	}
	/** Split configured keys into ready ones (rotated after the last success) and cooling ones. */
	partitionKeys() {
		const now = Date.now();
		const healthy = [];
		const cooling = [];
		for (const key of this.options.keys) {
			const state = this.keyStates[keyFingerprint(key)];
			if (state !== void 0 && state.coolingUntil > now) cooling.push({ key, coolingUntil: state.coolingUntil });
			else healthy.push(key);
		}
		if (this.lastUsedId !== void 0) {
			const index = healthy.findIndex((key) => keyFingerprint(key) === this.lastUsedId);
			if (index >= 0) {
				const rotated = healthy.slice(index + 1).concat(healthy.slice(0, index + 1));
				return { healthy: rotated, cooling: cooling.sort((a, b) => a.coolingUntil - b.coolingUntil) };
			}
		}
		return { healthy, cooling: cooling.sort((a, b) => a.coolingUntil - b.coolingUntil) };
	}
	/** Record a successful call: clear the cooldown and rotate past this key. */
	markSuccess(key) {
		const id = keyFingerprint(key);
		const previous = this.keyStates[id];
		if (previous !== void 0 && (previous.strikes !== 0 || previous.coolingUntil !== 0)) {
			this.keyStates[id] = { strikes: 0, coolingUntil: 0 };
			saveKeyStates(this.keyStates);
		}
		this.lastUsedId = id;
	}
	/** Park a key: credit exhaustion climbs the ladder, a rejected key waits a day. */
	markCooldown(key, kind) {
		const state = this.stateOf(key);
		if (kind === "invalid") state.coolingUntil = Date.now() + EXA_INVALID_KEY_COOLDOWN_MS;
		else {
			state.strikes = Math.min(state.strikes + 1, EXA_COOLDOWN_LADDER_MS.length);
			state.coolingUntil = Date.now() + EXA_COOLDOWN_LADDER_MS[Math.min(state.strikes - 1, EXA_COOLDOWN_LADDER_MS.length - 1)];
		}
		saveKeyStates(this.keyStates);
		if (this.lastUsedId === keyFingerprint(key)) this.lastUsedId = void 0;
	}
	/** Describe how long until the earliest parked key may be retried. */
	coolingMessage(cooling) {
		const keys = `${this.options.keys.length} key${this.options.keys.length === 1 ? "" : "s"}`;
		if (cooling.length === 0) return `every Exa API key (${keys}) is cooling down`;
		const minutes = Math.max(1, Math.ceil((cooling[0].coolingUntil - Date.now()) / 60_000));
		return `every Exa API key (${keys}) is cooling down; next probe in about ${minutes} min`;
	}
	async search(request, signal) {
		if (this.options.keys.length === 0) throw new WebError("Exa search needs an API key (apiKeys, apiKey, EXA_API_KEYS or EXA_API_KEY)", "WEB_PROVIDER_ERROR");
		const { healthy, cooling } = this.partitionKeys();
		let candidates = healthy;
		if (candidates.length === 0) {
			const now = Date.now();
			if (cooling.length > 0 && now - this.lastProbeAt >= EXA_PROBE_INTERVAL_MS) {
				this.lastProbeAt = now;
				candidates = [cooling[0].key];
			} else if (cooling.length === 0) {
				throw new WebError("Exa search has no usable API key", "WEB_PROVIDER_ERROR");
			} else {
				throw new WebError(this.coolingMessage(cooling), "WEB_PROVIDER_ERROR");
			}
		}
		let failure;
		for (const key of candidates) {
			try {
				const result = await this.searchWithKey(key, request, signal);
				this.markSuccess(key);
				return result;
			} catch (error) {
				if (error instanceof ExaQuotaError) {
					this.markCooldown(key, "quota");
					failure = error;
					continue;
				}
				if (error instanceof ExaInvalidKeyError) {
					this.markCooldown(key, "invalid");
					failure = error;
					continue;
				}
				if (error instanceof ExaRateLimitError) {
					failure = error;
					continue;
				}
				throw error;
			}
		}
		// Every candidate just answered "out of credits"/"key rejected": start the probe
		// throttle now, so the next search fails fast instead of re-asking the same keys.
		if (failure instanceof ExaQuotaError || failure instanceof ExaInvalidKeyError) this.lastProbeAt = Date.now();
		throw failure ?? new WebError("Exa search failed", "WEB_PROVIDER_ERROR");
	}
	/** One key's attempt, retrying a 429 on the same key while `Retry-After` allows. */
	async searchWithKey(key, request, signal) {
		const numResults = request.maxResults ?? this.options.numResults;
		for (let attempt = 0;; attempt += 1) {
			let response;
			try {
				response = await fetch(`${this.options.baseURL}/search`, {
					method: "POST",
					redirect: "error",
					headers: {
						"authorization": `Bearer ${key}`,
						"content-type": "application/json",
						"accept": "application/json",
						"user-agent": USER_AGENT
					},
					body: JSON.stringify({
						query: request.query,
						type: this.options.searchType,
						contents: { highlights: { highlightsPerUrl: this.options.highlightsPerResult } },
						...numResults !== void 0 ? { numResults } : {}
					}),
					...signal !== void 0 ? { signal } : {}
				});
			} catch (error) {
				if (isAbortError(error)) throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: error });
				throw new WebError(`Exa search request failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
			}
			if (response.ok) {
				try {
					return mapExaResponse(await response.json());
				} catch (error) {
					if (isAbortError(error)) throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: error });
					throw new WebError(`Exa returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
				}
			}
			const { message, tag } = await readExaError(response);
			if (response.status === 429) {
				if (attempt < EXA_RATE_LIMIT_RETRIES) {
					const waitMs = Math.min(parseRetryAfterMs(response.headers) ?? 1_000 * 2 ** attempt, EXA_RATE_LIMIT_SLEEP_CAP_MS);
					await sleep(waitMs, signal);
					continue;
				}
				throw new ExaRateLimitError(message, tag);
			}
			if (response.status === 401 || response.status === 403) throw new ExaInvalidKeyError(message, tag);
			if (response.status === 402 || tag === EXA_QUOTA_TAG) throw new ExaQuotaError(message, tag);
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
	}
};
//#endregion
//#region lib/types/index.js
/**
* Exa-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
* registry without owning the service.
*
* @module @local/dsh-web-search-exa
*/
/** Cordis plugin name used by loader diagnostics. */
const name = "web-search-exa";
/** The web seam this provider registers into. */
const inject = ["web"];
/** Register the Exa search provider with `ctx.web`. */
// Config schema intentionally omitted: it declared no defaults (apply() supplies
// every fallback), and its z/schemastery import would break this self-contained
// build.
function apply(ctx, config) {
	const settings = config ?? {};
	ctx.web.registerSearchProvider(new ExaSearchProvider({
		apiKeys: settings.apiKeys ?? settings.apiKey,
		environment: environmentReaderOf(ctx),
		baseURL: settings.baseURL ?? EXA_DEFAULT_BASE_URL,
		searchType: settings.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
		highlightsPerResult: settings.highlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
		...settings.numResults !== void 0 ? { numResults: settings.numResults } : {}
	}));
}
//#endregion
export { EXA_COOLDOWN_LADDER_MS, EXA_DEFAULT_BASE_URL, EXA_DEFAULT_HIGHLIGHTS_PER_RESULT, EXA_DEFAULT_SEARCH_TYPE, EXA_PROVIDER_ID, EXA_QUOTA_TAG, EXA_STATE_FILE, ExaInvalidKeyError, ExaQuotaError, ExaRateLimitError, ExaSearchProvider, apply, inject, name };
