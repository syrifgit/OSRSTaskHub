/**
 * DBROW scraper pipeline orchestrator.
 *
 * Used by L6 (Demonic Pacts). Any future league whose tasks live in a DB
 * table (identity via task-index enum + cache columns) should reuse this
 * with its own LeagueDbrowConfig - see src/dbrow/config.ts.
 *
 * Tiered fallback:
 *   Tier A - wiki only. Always runs. Produces min/full/csv with dbRowId+sortId.
 *   Tier B - wiki + cache enrichment. Runs unless --no-cache. Adds cacheColumns
 *            to full.json for debugging; plugin doesn't need them at runtime
 *            since it reads columns live via client.getDBTableField.
 *   Tier C - classification via classify.py. Runs unless --no-classify.
 *            Adds location and classification fields to min/full.
 */

import { mkdirSync, existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { findLeagueByTaskType, resolveOutputDir, updateLeague, getWikiConfig } from '../leagues';
import { createCacheProvider } from '../cache/provider';
import { scrapeDbrowWiki, L6WikiRow } from './scrapeWiki';
import { enrichWithCache, EnrichedRow, loadTaskIndexMap } from './enrichCache';
import { getSchema } from './tableSchemas';
import { getLeagueConfig, LeagueDbrowConfig } from './config';
import {
  combineWikiAndCache,
  writeL6FullJson,
  writeL6MinJson,
  writeL6RawJson,
  writeL6Csv,
  writeClassifierInput,
  mergeL6Locations,
  L6Task,
} from './output';

export interface DbrowPipelineOptions {
  taskType: string;              // e.g. "LEAGUE_6"
  useCache: boolean;             // default true
  classify: boolean;             // default true
  schemaName?: string;           // override LeagueDbrowConfig.schemaName
  wikiUrlOverride?: string;      // override leagues/index.json wikiUrl
}

export async function runDbrowPipeline(opts: DbrowPipelineOptions): Promise<void> {
  const { taskType } = opts;
  const config = getLeagueConfig(taskType);
  const log = (msg: string) => console.log(`${config.logPrefix} ${msg}`);

  const league = findLeagueByTaskType(taskType);
  if (!league) {
    throw new Error(`No league entry for "${taskType}" in leagues/index.json`);
  }

  const wikiConfig = getWikiConfig(taskType);
  const wikiUrl = opts.wikiUrlOverride ?? wikiConfig?.url;
  if (!wikiUrl) {
    throw new Error(`No wikiUrl for "${taskType}" in leagues/index.json and no --wiki override`);
  }

  const outputDir = resolveOutputDir(taskType);
  mkdirSync(outputDir, { recursive: true });

  const schemaName = opts.schemaName ?? config.schemaName;

  // --- Tier A: wiki scrape
  log(`wiki scrape: ${wikiUrl}`);
  const wikiRows = await scrapeDbrowWiki({ wikiUrl, spec: config.wiki });
  log(`wiki: ${wikiRows.length} tasks`);
  validateWikiRows(wikiRows, config);

  // --- Tier B: cache enrichment (optional)
  let enriched: EnrichedRow[] | undefined;
  let resolved = 0;
  if (opts.useCache) {
    try {
      log(`cache: opening provider`);
      const cache = await createCacheProvider();

      // Resolve wikiTaskIndex -> real dbRowId via task-index enum.
      log(`cache: loading enum ${config.taskIndexEnumId} (task index -> dbRowId)`);
      const indexMap = await loadTaskIndexMap(cache, config.taskIndexEnumId);
      log(`cache: enum ${config.taskIndexEnumId} has ${indexMap.size} entries`);
      for (const row of wikiRows) {
        const realId = indexMap.get(row.wikiTaskIndex);
        if (realId != null) {
          row.dbRowId = realId;
          resolved++;
        }
      }
      log(`cache: resolved ${resolved}/${wikiRows.length} wiki indices to real dbRowIds`);
      const unresolved = wikiRows.filter(r => r.dbRowId == null).map(r => r.wikiTaskIndex);
      if (unresolved.length) {
        console.warn(
          `${config.logPrefix} cache: ${unresolved.length} wiki indices missing from enum ${config.taskIndexEnumId}: ` +
          `${unresolved.slice(0, 10).join(', ')}${unresolved.length > 10 ? '...' : ''}`,
        );
      }

      const schema = getSchema(schemaName);
      const dbRowIds = wikiRows
        .map(r => r.dbRowId)
        .filter((id): id is number => id != null);
      enriched = await enrichWithCache(cache, schema, { dbRowIds });
      log(`cache: enriched ${enriched.length} rows`);

      const missingFromCache = dbRowIds.filter(
        id => !enriched!.find(e => e.dbRowId === id),
      );
      if (missingFromCache.length) {
        console.warn(
          `${config.logPrefix} cache: ${missingFromCache.length} resolved dbRowIds absent from cache table ${schema.tableId}: ` +
          `${missingFromCache.slice(0, 10).join(', ')}${missingFromCache.length > 10 ? '...' : ''}`,
        );
      }
    } catch (err: any) {
      console.warn(`${config.logPrefix} cache step skipped: ${err.message}`);
      enriched = undefined;
    }
  } else {
    log(`cache: skipped (--no-cache)`);
    console.warn(`${config.logPrefix} WARNING: without cache, dbRowId is null in output.`);
  }

  // Build combined task records.
  const tasks = combineWikiAndCache(wikiRows, enriched, config.decoders);

  // Raw is the master record (wiki + cache nested by source). Written after
  // enrichment so it has resolved dbRowIds and cache column data.
  writeL6RawJson(tasks, outputDir, taskType);

  // --- Tier C: classification (optional)
  if (opts.classify) {
    const shimPath = path.join(outputDir, `${taskType}.classifier-input.json`);
    const locationsPath = path.join(outputDir, `${taskType}.locations.json`);
    writeClassifierInput(tasks, shimPath);
    try {
      runClassifier(shimPath, locationsPath);
      const fullPath = writeL6FullJson(tasks, outputDir, taskType);
      const { merged, withLocation } = mergeL6Locations(fullPath, locationsPath);
      log(`classify: merged ${merged} entries (${withLocation} with coordinates)`);
      // Reload merged tasks so min.json picks up location data.
      const reloadedTasks: L6Task[] = JSON.parse(readFileSync(fullPath, 'utf-8'));
      writeL6MinJson(reloadedTasks, outputDir, taskType);
      writeL6Csv(reloadedTasks, outputDir, taskType);
    } catch (err: any) {
      console.warn(`${config.logPrefix} classify skipped: ${err.message}`);
      // Fall through to unclassified outputs.
      writeL6FullJson(tasks, outputDir, taskType);
      writeL6MinJson(tasks, outputDir, taskType);
      writeL6Csv(tasks, outputDir, taskType);
    }
  } else {
    log(`classify: skipped (--no-classify)`);
    writeL6FullJson(tasks, outputDir, taskType);
    writeL6MinJson(tasks, outputDir, taskType);
    writeL6Csv(tasks, outputDir, taskType);
  }

  updateLeague(taskType, {
    taskCount: tasks.length,
    taskFile: `${taskType}.full.json`,
  } as any);

  log(`done. ${tasks.length} tasks written to ${outputDir}/`);
}

/**
 * Wiki-only refresh for DBROW leagues. Reads existing full.json, re-scrapes
 * the wiki, overwrites wiki-sourced fields on each task, and re-emits
 * full.json + min.json. Cache and classifier are NOT re-run - use
 * runDbrowPipeline() for a full rebuild.
 *
 * Keyed by sortId, which for DBROW tasks equals wikiTaskIndex. This avoids
 * needing cache access (no enum 5950 lookup required) since dbRowId is
 * already present on every existing full.json entry.
 */
export async function updateWikiDbrow(
  taskType: string,
  existingTasks: L6Task[],
  outputDir: string,
): Promise<void> {
  const config = getLeagueConfig(taskType);
  const log = (msg: string) => console.log(`${config.logPrefix} ${msg}`);

  const wikiConfig = getWikiConfig(taskType);
  if (!wikiConfig) {
    throw new Error(`No wikiUrl for "${taskType}" in leagues/index.json`);
  }

  log(`wiki refresh: ${wikiConfig.url}`);
  const wikiRows = await scrapeDbrowWiki({ wikiUrl: wikiConfig.url, spec: config.wiki });
  log(`wiki: ${wikiRows.length} rows scraped`);
  validateWikiRows(wikiRows, config);

  // Index wiki rows by wikiTaskIndex (which equals sortId for DBROW tasks)
  const wikiBySortId = new Map<number, L6WikiRow>();
  for (const r of wikiRows) wikiBySortId.set(r.wikiTaskIndex, r);

  let updated = 0;
  let missing = 0;
  for (const task of existingTasks) {
    const wiki = wikiBySortId.get(task.sortId);
    if (!wiki) {
      missing++;
      continue;
    }

    let changed = false;
    if (wiki.completionPercent != null && wiki.completionPercent !== task.completionPercent) {
      task.completionPercent = wiki.completionPercent;
      changed = true;
    }
    if (wiki.requirements !== task.wikiNotes) {
      task.wikiNotes = wiki.requirements ?? undefined;
      changed = true;
    }
    if (wiki.requirementsHtml !== task.wikiNotesHtml) {
      task.wikiNotesHtml = wiki.requirementsHtml ?? undefined;
      changed = true;
    }
    if (wiki.skills.length > 0) {
      const fresh = JSON.stringify(wiki.skills);
      const existing = JSON.stringify(task.skillRequirements ?? []);
      if (fresh !== existing) {
        task.skillRequirements = wiki.skills;
        changed = true;
      }
    }
    if (wiki.points != null && wiki.points !== task.points) {
      task.points = wiki.points;
      changed = true;
    }
    if (changed) updated++;
  }

  log(`merged: ${updated} tasks changed, ${missing} full.json entries had no wiki match`);

  writeL6FullJson(existingTasks, outputDir, taskType);
  writeL6MinJson(existingTasks, outputDir, taskType);
  log(`wrote full.json + min.json`);
}

function validateWikiRows(rows: L6WikiRow[], config: LeagueDbrowConfig): void {
  const seen = new Set<number>();
  for (const r of rows) {
    if (!Number.isFinite(r.wikiTaskIndex)) {
      throw new Error(`${config.logPrefix} task "${r.name}" has non-numeric wikiTaskIndex ${r.wikiTaskIndex}`);
    }
    if (seen.has(r.wikiTaskIndex)) {
      throw new Error(`${config.logPrefix} duplicate wikiTaskIndex ${r.wikiTaskIndex} ("${r.name}")`);
    }
    seen.add(r.wikiTaskIndex);
  }
  console.log(`${config.logPrefix} validated: ${rows.length} unique wikiTaskIndices`);
}

function runClassifier(inputPath: string, outputPath: string): void {
  const classifyScript = path.resolve('./classify/classify.py');
  if (!existsSync(classifyScript)) {
    throw new Error(`classifier script not found at ${classifyScript}`);
  }
  const args = [
    classifyScript,
    `--input=${inputPath}`,
    `--output=${outputPath}`,
    '--coords',
    path.dirname(outputPath),
  ];
  try {
    execFileSync('python3', args, { stdio: 'inherit' });
  } catch {
    execFileSync('python', args, { stdio: 'inherit' });
  }
}
