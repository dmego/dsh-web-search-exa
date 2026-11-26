// Local adaptation for dsh 0.2.2-rc.5 (see ADAPTATION.md).
// A workspace `link:` bundle is imported from its real path, where the loader's
// bare @deepseek-ai/* specifier rewriting does not apply. These self-contained
// equivalents replace the DSH runtime imports so the module can load.
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
/** The Exa-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
var ExaSearchProvider = class {
	options;
	id = "exa";
	constructor(options) {
		this.options = options;
	}
	available() {
		return this.options.apiKey.length > 0 && isValidBaseUrl(this.options.baseURL) && isPositiveInteger(this.options.highlightsPerResult) && (this.options.numResults === void 0 || isPositiveInteger(this.options.numResults));
	}
	async search(request, signal) {
		const numResults = request.maxResults ?? this.options.numResults;
		let response;
		try {
			response = await fetch(`${this.options.baseURL}/search`, {
				method: "POST",
				redirect: "error",
				headers: {
					"authorization": `Bearer ${this.options.apiKey}`,
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
		if (!response.ok) {
			let message = `Exa API error (HTTP ${response.status})`;
			try {
				const parsed = await response.json();
				const detail = parsed.error ?? parsed.message;
				if (detail !== void 0 && detail.length > 0) message = detail;
			} catch (error) {
				if (isAbortError(error)) throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: error });
			}
			throw new WebError(message, "WEB_PROVIDER_ERROR");
		}
		try {
			return mapExaResponse(await response.json());
		} catch (error) {
			if (isAbortError(error)) throw new WebError("Exa search aborted", "WEB_ABORTED", { cause: error });
			throw new WebError(`Exa returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
	}
};
/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL) {
	return URL.canParse(baseURL);
}
/** True for a request limit that can be sent to Exa (a positive whole number). */
function isPositiveInteger(value) {
	return Number.isInteger(value) && value > 0;
}
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
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
		apiKey: settings.apiKey ?? environmentReaderOf(ctx)("EXA_API_KEY") ?? "",
		baseURL: settings.baseURL ?? "https://api.exa.ai",
		searchType: settings.searchType ?? "auto",
		highlightsPerResult: settings.highlightsPerResult ?? 1,
		...settings.numResults !== void 0 ? { numResults: settings.numResults } : {}
	}));
}
//#endregion
export { EXA_DEFAULT_BASE_URL, EXA_DEFAULT_HIGHLIGHTS_PER_RESULT, EXA_DEFAULT_SEARCH_TYPE, EXA_PROVIDER_ID, ExaSearchProvider, apply, inject, name };
