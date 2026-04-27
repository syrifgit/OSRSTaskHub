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
import { Enum } from '@abextm/cache2';
import { scrapeDbrowWiki, L6WikiRow } from './scrapeWiki';
import {
  enrichWithCache,
  EnrichedRow,
  loadTaskIndexMap,
  invertTaskIndexMap,
  findActiveDbRowIds,
  loadFlagEnum,
} from './enrichCache';
import { getSchema } from './tableSchemas';
import { getLeagueConfig, LeagueDbrowConfig } from './config';
import {
  combineWikiAndCache,
  combineCacheAndWiki,
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

  // Wiki scrape always runs - provides display supplements (skills, notes,
  // completionPercent) not present in cache.
  log(`wiki scrape: ${wikiUrl}`);
  const wikiRows = await scrapeDbrowWiki({ wikiUrl, spec: config.wiki });
  log(`wiki: ${wikiRows.length} tasks`);
  validateWikiRows(wikiRows, config);

  let tasks: L6Task[];

  if (opts.useCache) {
    // --- Cache-authoritative path. Cache determines task membership and
    //     baseline fields; wiki supplements skills/notes/completion%.
    log(`cache: opening provider`);
    const cache = await createCacheProvider();
    const schema = getSchema(schemaName);

    log(`cache: finding active tasks via marker column "${config.markerColumn}"`);
    const activeIds = await findActiveDbRowIds(cache, schema, config.markerColumn);
    log(`cache: ${activeIds.size} active tasks (col "${config.markerColumn}" = 1)`);

    log(`cache: loading enum ${config.taskIndexEnumId} for sortId lookup`);
    const forwardIndex = await loadTaskIndexMap(cache, config.taskIndexEnumId);
    const reverseIndex = invertTaskIndexMap(forwardIndex);
    log(`cache: enum ${config.taskIndexEnumId} has ${forwardIndex.size} entries (${forwardIndex.size - activeIds.size} reserved/deprecated)`);

    const pactTaskIds = config.pactTaskEnumId != null
      ? await loadFlagEnum(cache, config.pactTaskEnumId)
      : new Set<number>();
    if (config.pactTaskEnumId != null) {
      log(`cache: enum ${config.pactTaskEnumId} (pact tasks): ${pactTaskIds.size} entries`);
    }

    const tierPoints = await loadTierPoints(cache, 2671);
    log(`cache: tier-points enum 2671: ${tierPoints.size} tiers`);

    const enriched = await enrichWithCache(cache, schema, { dbRowIds: [...activeIds] });
    log(`cache: enriched ${enriched.length} rows`);

    // Build wiki-row map keyed by dbRowId (resolve via forward enum)
    const wikiByDbRowId = new Map<number, L6WikiRow>();
    for (const wr of wikiRows) {
      const dbId = forwardIndex.get(wr.wikiTaskIndex);
      if (dbId != null) {
        wr.dbRowId = dbId;
        wikiByDbRowId.set(dbId, wr);
      }
    }

    // Log cache-vs-wiki mismatches. These indicate Jagex made a change in-game
    // before the wiki was updated (or vice-versa). Cache wins - wiki fields
    // silently absent for cache-only tasks, wiki-only tasks silently dropped.
    const wikiIds = new Set([...wikiByDbRowId.keys()]);
    const cacheNotWiki = [...activeIds].filter(id => !wikiIds.has(id));
    const wikiNotCache = [...wikiIds].filter(id => !activeIds.has(id));
    if (cacheNotWiki.length) {
      console.warn(`${config.logPrefix} mismatch: ${cacheNotWiki.length} active cache tasks not yet on wiki:`);
      for (const id of cacheNotWiki.slice(0, 5)) {
        const r = enriched.find(e => e.dbRowId === id);
        const name = r ? (Array.isArray(r.columns.action_name) ? r.columns.action_name[0] : r.columns.action_name) : '?';
        console.warn(`  ${id}: "${name}"`);
      }
      if (cacheNotWiki.length > 5) console.warn(`  ...+${cacheNotWiki.length - 5} more`);
    }
    if (wikiNotCache.length) {
      console.warn(`${config.logPrefix} mismatch: ${wikiNotCache.length} wiki tasks not active in cache (stale wiki entries):`);
      for (const id of wikiNotCache.slice(0, 5)) {
        const w = wikiByDbRowId.get(id);
        console.warn(`  ${id}: "${w?.name}"`);
      }
      if (wikiNotCache.length > 5) console.warn(`  ...+${wikiNotCache.length - 5} more`);
    }

    tasks = combineCacheAndWiki(
      { enriched, wikiByDbRowId, sortIdByDbRowId: reverseIndex, pactTaskIds, tierPoints },
      config.decoders,
    );
  } else {
    // --- Tier A fallback: wiki-only. Degraded - may include stale wiki entries
    //     and misses cache-only tasks. Only useful pre-cache-drop.
    log(`cache: skipped (--no-cache) - wiki drives membership, may be stale`);
    console.warn(`${config.logPrefix} WARNING: --no-cache produces degraded output; wiki lags in-game state`);
    tasks = combineWikiAndCache(wikiRows, undefined, config.decoders);
  }

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

async function loadTierPoints(cache: any, enumId: number): Promise<Map<number, number>> {
  const e = await Enum.load(cache, enumId as any);
  const out = new Map<number, number>();
  if (!e) return out;
  for (const [k, v] of (e as any).map) {
    if (typeof k === 'number' && typeof v === 'number') out.set(k, v);
  }
  return out;
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
