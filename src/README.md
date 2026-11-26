# Reference only — not the source of `index.js`

These files are the upstream `@deepseek-ai/dsh-web-search-exa@0.2.2-rc.1` TypeScript
sources, kept verbatim from tag `dsh-v0.2.2-rc.1` so the original implementation can be
compared against the build.

They are **not compiled here**: this repository ships a prebuilt, self-contained
`index.js` and declares no dependencies or build script. `index.js` started as the
upstream `lib/index.js` output and has since diverged — local `WebError` / environment
readers instead of DSH runtime imports, and multi-key rotation with a cooldown ledger.
Read [ADAPTATION.md](../ADAPTATION.md) for the current behaviour.

The upstream `tests/*.spec.ts` are kept for the same reference reason; they expect the
monorepo's workspace dependencies, so they are not runnable in this repository. The
runnable tests live in `../test/`.
