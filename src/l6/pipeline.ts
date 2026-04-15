/**
 * L6 scraper pipeline orchestrator.
 *
 * Tiered fallback plan (from plan file `elegant-mapping-fog.md`):
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
import { scrapeL6Wiki, L6WikiRow } from './scrapeWiki';
import { enrichWithCache, EnrichedRow, loadTaskIndexMap, L6_TASK_INDEX_ENUM } from './enrichCache';
import { getSchema } from './tableSchemas';
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

export interface L6PipelineOptions {
  taskType: string;              // e.g. "LEAGUE_6"
  useCache: boolean;             // default true
  classify: boolean;             // default true
  schemaName: string;            // default "action"
  wikiUrlOverride?: string;      // default pulls from leagues/index.json
}

export async function runL6Pipeline(opts: L6PipelineOptions): Promise<void> {
  const { taskType } = opts;
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

  // --- Tier A: wiki scrape
  console.log(`[L6] wiki scrape: ${wikiUrl}`);
  const wikiRows = await scrapeL6Wiki({ wikiUrl });
  console.log(`[L6] wiki: ${wikiRows.length} tasks`);
  validateWikiRows(wikiRows);

  // Raw wiki dump always written first for diagnostics.
  writeL6RawJson(wikiRows, outputDir, taskType);

  // --- Tier B: cache enrichment (optional)
  // Wiki's data-taskid is an index into enum 5950. The real dbRowId in table
  // 118 is enum5950[index]. We resolve that here before reading columns.
  let enriched: EnrichedRow[] | undefined;
  let resolved = 0;
  if (opts.useCache) {
    try {
      console.log(`[L6] cache: opening provider`);
      const cache = await createCacheProvider();

      // Resolve wikiTaskIndex -> real dbRowId via enum 5950.
      console.log(`[L6] cache: loading enum ${L6_TASK_INDEX_ENUM} (task index -> dbRowId)`);
      const indexMap = await loadTaskIndexMap(cache);
      console.log(`[L6] cache: enum ${L6_TASK_INDEX_ENUM} has ${indexMap.size} entries`);
      for (const row of wikiRows) {
        const realId = indexMap.get(row.wikiTaskIndex);
        if (realId != null) {
          row.dbRowId = realId;
          resolved++;
        }
      }
      console.log(`[L6] cache: resolved ${resolved}/${wikiRows.length} wiki indices to real dbRowIds`);
      const unresolved = wikiRows.filter(r => r.dbRowId == null).map(r => r.wikiTaskIndex);
      if (unresolved.length) {
        console.warn(
          `[L6] cache: ${unresolved.length} wiki indices missing from enum ${L6_TASK_INDEX_ENUM}: ` +
          `${unresolved.slice(0, 10).join(', ')}${unresolved.length > 10 ? '...' : ''}`,
        );
      }

      const schema = getSchema(opts.schemaName);
      const dbRowIds = wikiRows
        .map(r => r.dbRowId)
        .filter((id): id is number => id != null);
      enriched = await enrichWithCache(cache, schema, { dbRowIds });
      console.log(`[L6] cache: enriched ${enriched.length} rows`);

      const missingFromCache = dbRowIds.filter(
        id => !enriched!.find(e => e.dbRowId === id),
      );
      if (missingFromCache.length) {
        console.warn(
          `[L6] cache: ${missingFromCache.length} resolved dbRowIds absent from cache table ${schema.tableId}: ` +
          `${missingFromCache.slice(0, 10).join(', ')}${missingFromCache.length > 10 ? '...' : ''}`,
        );
      }
    } catch (err: any) {
      console.warn(`[L6] cache step skipped: ${err.message}`);
      enriched = undefined;
    }
  } else {
    console.log(`[L6] cache: skipped (--no-cache)`);
    console.warn(`[L6] WARNING: without cache, dbRowId is null in output. min.json carries wikiTaskIndex as fallback.`);
  }

  // Build combined task records.
  const tasks = combineWikiAndCache(wikiRows, enriched);

  // --- Tier C: classification (optional)
  if (opts.classify) {
    const shimPath = path.join(outputDir, `${taskType}.classifier-input.json`);
    const locationsPath = path.join(outputDir, `${taskType}.locations.json`);
    writeClassifierInput(tasks, shimPath);
    try {
      runClassifier(shimPath, locationsPath);
      const fullPath = writeL6FullJson(tasks, outputDir, taskType);
      const { merged, withLocation } = mergeL6Locations(fullPath, locationsPath);
      console.log(`[L6] classify: merged ${merged} entries (${withLocation} with coordinates)`);
      // Reload merged tasks so min.json picks up location data.
      const reloadedTasks: L6Task[] = JSON.parse(readFileSync(fullPath, 'utf-8'));
      writeL6MinJson(reloadedTasks, outputDir, taskType);
      writeL6Csv(reloadedTasks, outputDir, taskType);
    } catch (err: any) {
      console.warn(`[L6] classify skipped: ${err.message}`);
      // Fall through to unclassified outputs.
      writeL6FullJson(tasks, outputDir, taskType);
      writeL6MinJson(tasks, outputDir, taskType);
      writeL6Csv(tasks, outputDir, taskType);
    }
  } else {
    console.log(`[L6] classify: skipped (--no-classify)`);
    writeL6FullJson(tasks, outputDir, taskType);
    writeL6MinJson(tasks, outputDir, taskType);
    writeL6Csv(tasks, outputDir, taskType);
  }

  updateLeague(taskType, {
    taskCount: tasks.length,
    taskFile: `${taskType}.full.json`,
  } as any);

  console.log(`[L6] done. ${tasks.length} tasks written to ${outputDir}/`);
}

function validateWikiRows(rows: L6WikiRow[]): void {
  const seen = new Set<number>();
  for (const r of rows) {
    if (!Number.isFinite(r.wikiTaskIndex)) {
      throw new Error(`[L6] task "${r.name}" has non-numeric wikiTaskIndex ${r.wikiTaskIndex}`);
    }
    if (seen.has(r.wikiTaskIndex)) {
      throw new Error(`[L6] duplicate wikiTaskIndex ${r.wikiTaskIndex} ("${r.name}")`);
    }
    seen.add(r.wikiTaskIndex);
  }
  console.log(`[L6] validated: ${rows.length} unique wikiTaskIndices`);
}

function runClassifier(inputPath: string, outputPath: string): void {
  const classifyScript = path.resolve('./classify/classify.py');
  if (!existsSync(classifyScript)) {
    throw new Error(`classifier script not found at ${classifyScript}`);
  }
  // Use the same args the existing struct-path pipeline uses. The --coords
  // flag enables coord enrichment when classification = SINGLE.
  const args = [
    classifyScript,
    `--input=${inputPath}`,
    `--output=${outputPath}`,
    '--coords',
    // Positional OUT_DIR is required by classify.py; we point it at a scratch
    // dir since the interesting output is the --output file.
    path.dirname(outputPath),
  ];
  try {
    execFileSync('python3', args, { stdio: 'inherit' });
  } catch {
    // Windows convention: python3 may not be on PATH, but `python` is.
    execFileSync('python', args, { stdio: 'inherit' });
  }
}
