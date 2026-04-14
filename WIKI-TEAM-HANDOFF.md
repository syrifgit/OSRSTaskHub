# OSRS Wiki Team - Task StructId Export

Thanks for helping us get real structIds out early. This branch adds one CLI command (`tasks export-real-ids`) that reads your pre-release cache, pulls task structIds, filters to tasks already visible on the public wiki, and writes a small JSON file you can review and send back.

Only runs read-only against the cache. No network calls except one HTTPS GET to the wiki allow-list page (skippable with `--all`). No telemetry.

## Requirements

- Node 22+
- npm

## One-time setup

```bash
git clone --branch wiki-team-scraper https://github.com/syrifgit/OSRSTaskHub.git
cd OSRSTaskHub
npm install
```

## Run

Point `OSRS_CACHE_DIR` at the pre-release cache folder, then pick the mode matching what Jagex has cleared you to share. The cache folder should contain either `main_file_cache.dat2` (raw Jagex format) or `0.flatcache` (abextm format) - the tool auto-detects.

### Four modes

Two orthogonal flags: `--full` (include description/area/tier/etc) and `--all` (skip wiki filter). Pick whichever combination matches your approval scope.

| Command | What it includes | What it reveals |
|---|---|---|
| `tasks export-real-ids LEAGUE_6` (default) | structId + name + varbitIndex for tasks **already on the public wiki** | No new names, just IDs you can already see |
| `tasks export-real-ids LEAGUE_6 --full` | Above plus description, area, tier, skill, category for **wiki tasks only** | No new names, adds structured metadata from cache |
| `tasks export-real-ids LEAGUE_6 --all` | structId + name + varbitIndex for **every task** in the league tier | Reveals names of unpublished tasks |
| `tasks export-real-ids LEAGUE_6 --full --all` | Full structured data for **every task** in the league tier | Full unpublished content |

All four modes run against the same cache. The flags only change what ends up in the output file.

```bash
OSRS_CACHE_DIR=/path/to/pre-release/cache \
  npm run cli -- tasks export-real-ids LEAGUE_6
```

Output path defaults to `./LEAGUE_6-real-ids.json` (or `-real-ids-full.json` when `--full`). Override with `--out <path>`.

### Other options

- `--tier-param <n>` - override the tier param ID. The tool auto-discovers it by scanning for a param not used by L1-L5 that appears on 500+ structs with values in [1,6]. Only pass this if auto-discovery fails or picks the wrong one.

## Output format

### Minimal (default)

Flat JSON array, one entry per matched task:

```json
[
  {
    "varbitIndex": 82,
    "name": "Achieve Your First Level 90",
    "realStructId": 2657
  }
]
```

### Full (`--full`)

Same shape with additional cache-resolved fields:

```json
[
  {
    "realStructId": 2657,
    "varbitIndex": 82,
    "name": "Achieve Your First Level 90",
    "description": "Achieve level 90 in any skill.",
    "area": "Global",
    "category": "Skill",
    "skill": null,
    "tier": 4,
    "tierName": "Elite"
  }
]
```

Field reference:
- `realStructId` - the cache struct ID
- `varbitIndex` - param 873 (real game varbit index)
- `name` - param 874
- `description` - param 875
- `area` - param 1017, resolved via cache enum
- `category` - param 1016, resolved
- `skill` - param 1018, resolved
- `tier` / `tierName` - league tier param, raw int + resolved name

## Before sending

Open the output file and sanity-check:
- Every `name` is something already visible on the public wiki's task list
- No placeholder / internal / testing names slipped through

If anything looks wrong, rerun with a narrower input or drop the entry manually.

## Deliver

DM Syrif on Discord, attach the JSON, or link a gist. Whatever's easiest.

## What we do with it

`tasks apply-wiki-export LEAGUE_6 --file <your-file>` on our side resolves each entry to our existing placeholder structId (by `varbitIndex` first, then by name) and populates the `league_6_real_structId` field in our public mapping table so every league tool pulling from OSRSTaskHub gets real IDs as soon as you send them.

## Questions

Ping `@syrif` on Discord.
