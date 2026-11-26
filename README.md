---
description: "Local fork of the Exa-backed search provider for ctx.web: no DSH version constraint, so it keeps loading across dsh releases (verified on 0.2.2-rc.5), with multi-key rotation and cooldown across Exa teams."
kind: "package-reference"
---

# dsh-web-search-exa (local fork)

English | [中文](README.zh.md)

A standalone rebuild of [`@deepseek-ai/dsh-web-search-exa@0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.1/packages/web/web-search-exa)
with its pinned DSH version range removed, so it keeps loading as dsh moves forward (currently verified
on **dsh 0.2.2-rc.5**). It also adds **multi-key rotation across several Exa teams**, which upstream does
not have. The package name is `@local/dsh-web-search-exa`, so it never shadows the official package.

The `vendor:` commit is the upstream baseline verbatim; `adapt:` and `feat:` are the only local changes,
so `git diff` reads as a review. [ADAPTATION.md](ADAPTATION.md) (Chinese) has the long form: why the
rebuild was needed, the exact key-selection semantics, and how it was verified.

## Why this fork exists

Upstream pinned its DSH `peerDependencies` to `0.2.2-rc.1`, so the startup version gate refused to
activate it once dsh moved to rc.2:

```
dsh: warning: Plugin @deepseek-ai/dsh-web-search-exa@0.2.2-rc.1 is incompatible
with dsh 0.2.2-rc.2: requirements
{"@deepseek-ai/dsh-launch-environment":"0.2.2-rc.1","@deepseek-ai/dsh-web":"0.2.2-rc.1"}
... Exact-version exemption: not active.
```

npm never published anything past rc.1, and the official repository deleted `packages/web/web-search-exa`
after rc.2 — there is no newer version to install and no directory left to send a patch to. This rebuild
starts from the installed npm package's `lib/index.js` (the complete compiled output), so the search logic
is byte-for-byte upstream rc.1 and every change sits around it.

## Version policy

This package declares no DSH version requirement at all: no `engines.dsh`, and no `@deepseek-ai/dsh*`
`peerDependencies`. The startup gate (`dsh-app-boot`'s `plugin-compatibility.ts`) only compares versions
when one of those fields exists; with neither it has nothing to reject, so any dsh runtime loads the bundle
instead of blocking it the way upstream rc.1 got blocked.

`package.json`'s `version` is therefore a record of the dsh release the bundle was last checked against —
currently `0.2.2-rc.5` — not a compatibility floor or ceiling.

On each dsh upgrade: run `node test/multi-key.test.mjs` (pure stubs, no network), then one real
`node test/live-check.mjs "exa pricing"`. If dsh changed the `ctx.web` provider surface, update
[index.js](index.js) and move `version` to the new runtime version.

## What changed against upstream

| # | Improvement | Upstream | This fork |
|---|---|---|---|
| 1 | **Version gate cleared** | `peerDependencies` pinned to DSH `0.2.2-rc.1`, so every later dsh refuses to load it | `peerDependencies` and `engines.dsh` removed — no DSH range left to reject; `version` merely records the runtime it was last checked on |
| 2 | **Installable as a `link:` bundle** | loaded from its real path, the bare `@deepseek-ai/*` imports fail with `ERR_MODULE_NOT_FOUND`, so `link:` never mounts | self-contained: local `WebError`, `launchEnvironmentOf()`, `environmentReaderOf(ctx)`, schemastery `Config` dropped, zero runtime dependencies |
| 3 | **Multi-key rotation** ⭐ | one `apiKey` only | several keys across Exa teams take turns (still one provider — see below) |
| 4 | **Credit-exhaustion cooldown** ⭐ | once a key is out of credits, every search hits the same 402 | the key is parked immediately and its cooldown steps 5min → 30min → 2h → 8h → 24h; the same search continues on the next key |
| 5 | **429 backoff** | fails outright | retries the same key per `Retry-After` (2 tries, 5s sleep cap), then falls over to the next team **without parking** it |
| 6 | **Cooldowns survive restarts** ⭐ | none | `$DSH_HOME/cache/exa-key-state.json`, indexed by the first 16 hex digits of each key's sha256 so no plaintext reaches disk; entries older than 7 days are dropped |
| 7 | **Keys live in the environment** | docs suggest writing `apiKey` into the patch — i.e. into version control | `EXA_API_KEYS` / `EXA_API_KEY` (an explicit `config:` also works); this repository's `cordis.patch.yml` carries no key |
| 8 | **`config` is optional** | a patch with no `config:` hands `apply()` an `undefined` and it throws | `apply(ctx, config)` does `config ?? {}`, so an empty config still registers |
| 9 | **Verifiable** | tests need the monorepo's workspace dependencies, so they cannot run standalone | `test/` holds 10 stubbed cases (global `fetch` stubbed, temporary `DSH_HOME`) plus a `live-check.mjs` that calls the real API |
| 10 | **Docs** | — | [ADAPTATION.md](ADAPTATION.md): rationale, key-selection semantics, verification |

## Install

```sh
# 1. make the profile depend on this checkout (profile dir is usually ~/.dsh/profiles/<name>)
pnpm add "link:/path/to/dsh-web-search-exa"

# 2. register the bundle: dsh plugin manager's install_bundle,
#    or add @local/dsh-web-search-exa to dsh.profile.bundles in the profile package.json
```

The bundle ships its own [cordis.patch.yml](cordis.patch.yml), inserting the enable row under the
distinct id `web-search-exa-local`. An older `web-search-exa` row, if the profile still has one, stays
blocked by the version gate and never mounts — otherwise the `exa` provider id would be registered twice
and throw `WEB_DUPLICATE_PROVIDER`. The profile's `web` row keeps `searchProvider: exa` +
`fetchProvider: http`.

## Configuring several keys

```sh
# put it in ~/.dsh/.env (or the invoking directory's .env) and restart dsh
EXA_API_KEYS=team-a-key,team-b-key,team-c-key
```

Sources are **merged and de-duplicated** in this order (earlier keys start the rotation queue):
config `apiKeys` → `EXA_API_KEYS` → config `apiKey` → `EXA_API_KEY`.
Commas, semicolons and whitespace all separate. A single key via `EXA_API_KEY` behaves exactly like
upstream. Environment variables go through dsh's launch snapshot, so `~/.dsh/.env` and the invoking
directory's `.env` both count.

> **This only pays off across different Exa teams.** Credits and QPS are billed per team; several keys
> from one team share a single allowance, so rotating them buys nothing.

### How one search picks a key

| Situation | Behaviour |
|---|---|
| healthy keys exist | round-robin, starting after the key that last succeeded, so one key is not drained first |
| `402` / tag `NO_MORE_CREDITS` | park the key, raise its cooldown step, continue on the next key |
| `429` | retry the same key per `Retry-After` (≤2 tries, ≤5s each), then fall over to another team without parking |
| `401` / `403` | the key itself is unusable: parked for 24h |
| network error / `5xx` | surfaced immediately, no other key is spent |
| every key cooling | at most one probe a minute against the key that frees up soonest; other calls fail fast with the remaining wait |

### When does credit come back

Exa's 402 carries no `Retry-After` and no reset timestamp: the Starter plan returns to $10 on the 1st of
each month (no carry-over), and Developer is prepaid (immediate on top-up). The cooldown ladder is
therefore a **bounded guess** — the 24h cap matches the monthly reset granularity while keeping probe
traffic near zero. Top up and want unfreeze now: stop dsh → delete
`$DSH_HOME/cache/exa-key-state.json` → start it again (the ledger is read once at construction).

## Verify

```sh
node test/multi-key.test.mjs             # 10 stubbed cases, no network, no credits
node test/live-check.mjs "exa pricing"    # hits the real API, prints sha256 prefixes only
```

The stubbed cases cover rotation, failover after one key is exhausted, the ladder and its 24h cap, the
probe throttle when everything is cooling, 429 retry and team failover, 401 parking, 5xx passthrough,
`EXA_API_KEYS` parsing and de-duplication, and ledger recovery across a restart. `live-check.mjs` keeps
its ledger in a temporary directory, so it never disturbs the real one.

## Commit history (the three core commits)

```
9ffc9a6 feat: rotate several Exa API keys with a cooldown ledger
1a72c1e adapt: make the bundle self-contained for dsh 0.2.2-rc.5
ba9bb0b vendor: import @deepseek-ai/dsh-web-search-exa@0.2.2-rc.1 verbatim
```

## Upstream documentation

The sections below are upstream's `0.2.2-rc.1` documentation, describing the upstream package itself
(including its official package name and monorepo-relative links). Where they disagree with the
sections above, this fork wins. `src/` holds upstream's TypeScript for comparison only and is not built —
the runtime entry is this repository's [index.js](index.js).

-----
### Summary

With `dsh-web-search-exa`, the harness searches the web through Exa and gets vendor-native results with portable snippets and publication dates. Choose it when a deployment has an Exa API key and wants Exa's keyword or neural search. Exa returns no generated answer, so results carry no `content` — only citeable sources. A result with no non-blank highlight is dropped, so a call can return fewer sources than requested. The model-facing `web_search` tool lives in `dsh-tool-web`.

### Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
### Use this package

Mount the provider in a composition that already loads the web service; it registers as the `exa` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: exa`.

#### When to choose it

Choose this backend when a deployment holds an Exa API key and wants Exa's keyword or neural search with per-result highlight snippets and publication dates. The provider is unavailable — and every search call fails with a structured error — when the key is empty or the endpoint base does not parse.

#### Minimal configuration

Load the web service and the provider; the API key falls back to `$EXA_API_KEY` from the launch environment, and all other settings have safe defaults.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKey: !!js process.env.EXA_API_KEY
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | `$EXA_API_KEY` | Exa API key; empty or absent makes the provider unavailable |
| `baseURL` | `https://api.exa.ai` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable |
| `searchType` | `auto` | Retrieval mode sent as Exa's `type`: `auto`, `keyword`, or `neural` |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`; must be a positive integer |
| `highlightsPerResult` | `1` | Highlight sentences requested per result (Exa's `highlightsPerUrl`); must be a positive integer |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-exa) is the exhaustive source for every accepted field and its JSDoc.

#### What a search returns

Each Exa result maps to a `WebSearchSource`: `url`, `title`, the first non-blank highlight as `snippet`, and `publishedDate` as `publishedAt`; a result with no highlight has no portable snippet and is dropped. A request's `maxResults` wins over the configured `numResults` default and is sent to Exa as a cost and latency optimization — the final bound is enforced by the service, which truncates and flags. Exa returns no generated answer, so the result carries no `content`.

#### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
### Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

#### Design philosophy

The provider is a thin adapter over Exa's API with two deliberate rules:

- **Portable snippets only.** A source gains a `snippet` only from a real highlight; inventing one from other fields would make the seam lie, so snippet-less results are dropped entirely.
- **No invented answers.** Exa returns no generated answer, so `content` is omitted rather than fabricating provider prose the model might trust.

#### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `ExaSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | Exa wire types: `ExaSearchResponse`, `ExaResult`, `ExaError` |

#### Request and mapping flow

`search()` posts the query, retrieval mode, highlight request, and optional result count to `{baseURL}/search` with `redirect: 'error'`, so a redirect fails the request without contacting the target. The parsed `results[]` are mapped one by one, snippet-less entries dropped, and the service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
### Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the six-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-exa) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
### Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, first highlights, and publication dates or its exact `Exa search aborted`, `Exa search request failed: <error>`, and `Exa returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

##### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

### Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **A result with no non-blank highlight is dropped entirely** — there is no portable snippet to map, so fewer sources than requested can return.
- **Only `searchType`/`numResults`/`highlightsPerResult` are exposed** — Exa's other controls (livecrawl, category, domain/date filters, full-text contents) wait on provider-neutral service fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
#### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

##### Future: wider Exa control surface

Exa's livecrawl, category, domain and date filters, and full-text contents stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

</details>
