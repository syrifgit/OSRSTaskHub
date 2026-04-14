#!/usr/bin/env node

import { Command } from 'commander';
import { downloadCache, getLatestCommitHash, getLocalCommitHash } from './cache/downloader';
import { generateFull, classifyAndMerge, updateWiki } from './pipeline';
import { scrapePreliminary } from './wiki/preliminary';
import { loadRegistry, saveRegistry } from './wiki/idRegistry';
import { applyRealStructIds, writeMappings } from './output/mappings';
import { readFileSync } from 'fs';
import { mergeLocations } from './output/writers';
import { resolveOutputDir } from './leagues';
import { createCacheProvider } from './cache/provider';
import { runDiscovery, formatReport } from './discover';
import { exportRealIds } from './export/realIds';
import { applyWikiExport } from './export/applyWikiExport';
import * as path from 'path';

const program = new Command();

program
  .name('osrs-task-hub')
  .description('OSRS league task data pipeline')
  .version('1.0.0');

// ============================================================
// Cache commands
// ============================================================

const cache = program.command('cache').description('Game cache management');

cache
  .command('update')
  .description('Download or update the OSRS game cache')
  .option('-c, --commit <hash>', 'specific commit hash to download')
  .action(async (options) => {
    await downloadCache(options.commit);
    console.log('Cache updated');
  });

cache
  .command('status')
  .description('Show current cache version')
  .action(async () => {
    const local = getLocalCommitHash();
    if (local) {
      console.log(`Local cache: ${local}`);
    } else {
      console.log('No local cache found');
    }
    try {
      const latest = await getLatestCommitHash();
      console.log(`Latest upstream: ${latest}`);
      if (local === latest) {
        console.log('Up to date');
      } else {
        console.log('Update available');
      }
    } catch {
      console.log('Could not fetch upstream version');
    }
  });

// ============================================================
// Task commands
// ============================================================

const tasks = program.command('tasks').description('Task data operations');

tasks
  .command('generate-full')
  .description('Full pipeline: extract from cache, scrape wiki, resolve params, output all formats')
  .argument('[task-type]', 'Task type name (e.g., LEAGUE_5). Auto-detects active league if omitted.')
  .option('--force', 'Allow regenerating ended leagues (overwrites historical data)')
  .action(async (taskType: string | undefined, options: { force?: boolean }) => {
    await generateFull(taskType, options.force);
  });

tasks
  .command('classify')
  .description('Run classification pipeline on existing full.json and merge location data')
  .argument('<task-type>', 'Task type name (e.g., LEAGUE_5)')
  .action(async (taskType: string) => {
    await classifyAndMerge(taskType);
  });

tasks
  .command('merge-locations')
  .description('Merge a locations.json into existing full.json')
  .argument('<task-type>', 'Task type name (e.g., LEAGUE_5)')
  .requiredOption('--locations <path>', 'Path to locations.json from classify.py')
  .action(async (taskType: string, options: { locations: string }) => {
    const outputDir = resolveOutputDir(taskType);
    const fullJsonPath = path.join(outputDir, `${taskType}.full.json`);
    const { merged, withLocation } = mergeLocations(fullJsonPath, options.locations);
    console.log(`Merged ${merged} classifications (${withLocation} with coordinates) into ${fullJsonPath}`);
  });

tasks
  .command('update-wiki')
  .description('Re-scrape wiki data without re-extracting from cache')
  .argument('[task-type]', 'Task type name. Auto-detects active league if omitted.')
  .action(async (taskType?: string) => {
    await updateWiki(taskType);
  });

tasks
  .command('set-real-id')
  .description('Populate realStructId in the preliminary ID registry (one entry or bulk). Regenerates mapping files.')
  .argument('<task-type>', 'Task type name (e.g., LEAGUE_6)')
  .option('--placeholder <id>', 'Placeholder structId to update', parseInt)
  .option('--real <id>', 'Real structId to assign', parseInt)
  .option('--from-file <path>', 'JSON file with { "<placeholder>": <realId>, ... } for bulk updates')
  .action(async (taskType: string, options: { placeholder?: number; real?: number; fromFile?: string }) => {
    const outputDir = resolveOutputDir(taskType);
    const registryPath = path.join(outputDir, `${taskType}.id-registry.json`);
    const registry = loadRegistry(registryPath);

    const updates: Array<{ placeholder: number; real: number }> = [];
    if (options.fromFile) {
      const data = JSON.parse(readFileSync(options.fromFile, 'utf-8'));
      for (const [ph, real] of Object.entries(data)) {
        updates.push({ placeholder: Number(ph), real: Number(real) });
      }
    } else if (options.placeholder != null && options.real != null) {
      updates.push({ placeholder: options.placeholder, real: options.real });
    } else {
      throw new Error('Provide either --placeholder <id> --real <id> or --from-file <path>');
    }

    const { applied, missing } = applyRealStructIds(registry, updates);
    saveRegistry(registryPath, registry);
    console.log(`Applied ${applied} mappings to ${registryPath}`);
    if (missing.length) {
      console.log(`Warning: ${missing.length} placeholder IDs not found in registry:`, missing.slice(0, 10));
    }

    writeMappings(outputDir, taskType, registry);
  });

tasks
  .command('scrape-preliminary')
  .description('Wiki-first preliminary scrape (no game cache needed). Writes full/min/csv with 6-digit placeholder structIds (100000-999999) until cache lands.')
  .argument('<task-type>', 'Task type name (e.g., LEAGUE_6)')
  .action(async (taskType: string) => {
    await scrapePreliminary(taskType);
  });

// ============================================================
// Wiki-team handoff commands (branch-only, one-off for L6 launch)
// ============================================================

tasks
  .command('export-real-ids')
  .description('Extract real structIds from a pre-release cache. Four modes via --full and --all flags (see WIKI-TEAM-HANDOFF.md). Default: minimal + wiki-filtered.')
  .argument('<task-type>', 'Task type name (e.g., LEAGUE_6)')
  .option('--out <path>', 'Output JSON path (default: ./<task-type>-real-ids[-full].json)')
  .option('--all', 'Skip the wiki filter and dump every task matching the tier param')
  .option('--full', 'Include resolved params (description, area, tier, skill, category) in addition to structId/name/varbitIndex')
  .option('--tier-param <n>', 'Override tier param (auto-discovered otherwise)', parseInt)
  .action(async (taskType: string, options: { out?: string; all?: boolean; full?: boolean; tierParam?: number }) => {
    await exportRealIds({
      taskType,
      outPath: options.out,
      all: options.all,
      full: options.full,
      tierParam: options.tierParam,
    });
  });

tasks
  .command('apply-wiki-export')
  .description('Ingest a wiki-team real-ids JSON and populate realStructId in the registry + mappings.')
  .argument('<task-type>', 'Task type name (e.g., LEAGUE_6)')
  .requiredOption('--file <path>', 'JSON array of { varbitIndex, name, realStructId } from the wiki team')
  .action(async (taskType: string, options: { file: string }) => {
    await applyWikiExport(taskType, options.file);
  });

tasks
  .command('discover')
  .description('Scan cache for league data, detect new leagues, and report irregularities')
  .option('--wiki <url>', 'Wiki tasks page URL to cross-reference against cache')
  .option('--prev-tier <param>', 'Previous league tier param ID for comparison (default: latest known)', parseInt)
  .action(async (options: { wiki?: string; prevTier?: number }) => {
    const cache = await createCacheProvider();
    const report = await runDiscovery(cache, {
      wikiUrl: options.wiki,
      previousLeagueTier: options.prevTier,
    });
    console.log(formatReport(report));
  });

// ============================================================
// Run
// ============================================================

program.parseAsync(process.argv).catch(err => {
  console.error(err.message);
  process.exit(1);
});
