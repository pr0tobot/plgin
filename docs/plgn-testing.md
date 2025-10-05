# PLGN CLI Smoke Test

## Environment
- Project under test: [`@pr0tobot/plgn`](https://github.com/pr0tobot/plgn)
- Test target project: `netflix-spark`
- OpenRouter model: `z-ai/glm-4.6`

## Test Workflow
1. Installed the CLI globally via `npm install -g @pr0tobot/plgn` and then rebuilt from the local checkout to test code fixes.
2. Exported the provided `OPENROUTER_API_KEY` prior to each CLI invocation.
3. Created a feature pack from `src/components/Hero.tsx` using:
   ```bash
   plgn create src/components/Hero.tsx --name hero-banner --verbose
   ```
4. Applied the generated pack to a fresh React scaffold (stored outside this repo) with:
   ```bash
   plgn apply ../netflix-spark/packs/hero-banner --dry-run --verbose
   ```

## Key Observations
- Initial runs crashed when the source argument pointed to a single file. `listFilesRecursive` attempted to `readdir` the file path and threw `ENOTDIR`.
- API calls failed in a proxied environment because the OpenAI client ignored `HTTPS_PROXY`. Configuring an Undici `ProxyAgent` resolved the issue.
- Generated manifests contained absolute file paths in `source_credits.original` and `examples.entries`, which is undesirable for redistribution.
- Dry-run integration produced sensible previews but referenced local-only utilities (custom `Button` component). Pack authors should include all dependencies in the extraction scope for best results.

## Fixes Applied Upstream
The following patches were applied to the PLGN CLI (see summary in the final report):
- Allow `listFilesRecursive` to accept file paths.
- Honor `HTTP(S)_PROXY` settings when instantiating the OpenAI client.
- Normalize manifest paths to the packaged `source/` tree.
- Added `undici` runtime dependency for proxy support.
- Trace relative imports automatically so supporting primitives and assets are bundled into new packs.
- Renamed `plgn add` to `plgn apply` and introduced a `--fast` mode for create/apply that leans on Nia semantic hints and tighter agent loops.

## Current Output Snapshot
- Pack artifacts are available in `packs/hero-banner/`.
- Dry-run integration previews live under `.plgn/previews/` (ignored via `.gitignore`).
- Fast-apply previews can be generated via `plgn apply <pack> --fast --dry-run` to sanity-check semantic-guided integrations.

## Follow-up Recommendations
- Encourage pack creators to run `plgn create` with `--fast` to quickly validate extraction, then rerun without it for exhaustive coverage if needed.
- Expand automated tests for CLI scenarios that use proxies and single-file extraction to prevent regressions.
