/**
 * One-off export tool for the OSRS Wiki team.
 *
 * They have a pre-release cache from Jagex. This tool reads that cache,
 * pulls structId + name + varbitIndex for a given league tier param, and
 * (by default) filters the output to tasks that are already visible on the
 * public wiki so nothing unpublished leaks.
 *
 * Output JSON is a flat array of { varbitIndex, name, realStructId } that
 * our side ingests with `tasks apply-wiki-export`.
 */

import { CacheProvider, ParamID, Struct } from '@abextm/cache2';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { writeFileSync } from 'fs';
import * as path from 'path';
import { createCacheProvider } from '../cache/provider';
import { findLeagueByTaskType, getWikiConfig } from '../leagues';
import { normalizeName } from '../wiki/idRegistry';
import { hydrateTasks } from '../cache/tasks';

const pid = (n: number) => n as any as ParamID;

const PARAM_VARBIT_INDEX = pid(873);
const PARAM_NAME = pid(874);

// Tier params used by L1-L5. Anything outside this range and showing up on
// 500+ structs is treated as a new-league tier param.
const KNOWN_TIER_PARAMS = new Set([1849, 1850, 1851, 1852, 2044]);

const TIER_PARAM_OVERRIDES: Record<string, number> = {
  LEAGUE_1: 1849,
  LEAGUE_2: 1850,
  LEAGUE_3: 1851,
  LEAGUE_4: 1852,
  LEAGUE_5: 2044,
};

interface MinimalEntry {
  varbitIndex: number;
  name: string;
  realStructId: number;
}

interface FullEntry extends MinimalEntry {
  description: string;
  area: string | null;
  category: string | null;
  skill: string | null;
  tier: number | null;
  tierName: string | null;
}

export interface ExportRealIdsOptions {
  taskType: string;
  outPath?: string;
  all?: boolean;
  full?: boolean;
  tierParam?: number;
}

export async function exportRealIds(opts: ExportRealIdsOptions): Promise<void> {
  const league = findLeagueByTaskType(opts.taskType);
  if (!league) throw new Error(`No league entry for "${opts.taskType}" in leagues/index.json`);

  const cache = await createCacheProvider();

  const tierParam = opts.tierParam
    ?? TIER_PARAM_OVERRIDES[opts.taskType.toUpperCase()]
    ?? await discoverTierParam(cache);
  console.log(`Tier param: ${tierParam}`);

  const cacheEntries = await extractStructs(cache, tierParam);
  console.log(`Cache: ${cacheEntries.length} structs with tier param ${tierParam}`);

  let filtered = cacheEntries;
  let wikiCount = 0;
  if (!opts.all) {
    const wikiConfig = getWikiConfig(opts.taskType);
    if (!wikiConfig) throw new Error(
      `No wikiUrl configured for "${opts.taskType}" in leagues/index.json. ` +
      `Either add it, or pass --all to skip the wiki filter.`,
    );
    console.log(`Fetching wiki allow-list from ${wikiConfig.url}...`);
    const wikiNames = await fetchWikiTaskNames(wikiConfig.url);
    wikiCount = wikiNames.size;
    console.log(`Wiki: ${wikiCount} public task rows`);

    filtered = cacheEntries.filter(e => wikiNames.has(normalizeName(e.name)));
  }

  let output: MinimalEntry[] | FullEntry[];
  if (opts.full) {
    console.log(`Hydrating ${filtered.length} tasks with full params (area, tier, skill, category)...`);
    output = await hydrateFullEntries(cache, filtered, tierParam);
  } else {
    output = filtered;
  }

  const outPath = opts.outPath ?? `./${opts.taskType}-real-ids${opts.full ? '-full' : ''}.json`;
  writeFileSync(path.resolve(outPath), JSON.stringify(output, null, 2));

  const skipped = cacheEntries.length - filtered.length;
  console.log('');
  console.log('--- Summary ---');
  console.log(`  Mode:            ${opts.full ? 'full detail' : 'minimal'} | ${opts.all ? 'all cache tasks' : 'wiki-filtered'}`);
  console.log(`  Cache tasks:     ${cacheEntries.length}`);
  if (!opts.all) console.log(`  Wiki allow-list: ${wikiCount}`);
  console.log(`  Matched:         ${filtered.length}`);
  console.log(`  Skipped:         ${skipped}${opts.all ? ' (--all, no filter)' : ' (not on public wiki)'}`);
  console.log(`  Wrote:           ${outPath}`);
  console.log('');
  console.log('Review the output file before sending to confirm no unpublished content is present.');
}

async function hydrateFullEntries(
  cache: CacheProvider,
  entries: MinimalEntry[],
  tierParam: number,
): Promise<FullEntry[]> {
  const tasksForHydrate = entries.map((e, i) => ({ structId: e.realStructId as any, sortId: i }));
  const { fullTasks } = await hydrateTasks(cache, tasksForHydrate, tierParam);

  return fullTasks.map((t, i) => ({
    realStructId: entries[i].realStructId,
    varbitIndex: entries[i].varbitIndex,
    name: t.name,
    description: t.description,
    area: t.area,
    category: t.category,
    skill: t.skill,
    tier: t.tier,
    tierName: t.tierName,
  }));
}

async function extractStructs(cache: CacheProvider, tierParam: number): Promise<MinimalEntry[]> {
  const tierParamId = pid(tierParam);
  const allStructs = await Struct.all(cache);
  const entries: MinimalEntry[] = [];

  for (const s of allStructs) {
    if (s.params.get(tierParamId) === undefined) continue;

    const nameRaw = s.params.get(PARAM_NAME);
    if (nameRaw == null) continue;
    const name = String(nameRaw);

    const varbitRaw = s.params.get(PARAM_VARBIT_INDEX);
    const varbitIndex = varbitRaw == null
      ? 0
      : typeof varbitRaw === 'bigint' ? Number(varbitRaw) : Number(varbitRaw);

    entries.push({
      varbitIndex,
      name,
      realStructId: s.id as unknown as number,
    });
  }

  entries.sort((a, b) => a.realStructId - b.realStructId);
  return entries;
}

/**
 * Best-effort tier param discovery for unknown leagues.
 *
 * Scans all task structs for an integer param that:
 *   - isn't one of the L1-L5 known tier params
 *   - appears on 500+ structs
 *   - has values entirely in [1, 6]
 *   - has at least 3 distinct values
 *
 * Picks the highest-count candidate. Same heuristic as discover.ts.
 */
async function discoverTierParam(cache: CacheProvider): Promise<number> {
  const allStructs = await Struct.all(cache);
  const paramCounts = new Map<number, Map<number, number>>();

  for (const s of allStructs) {
    if (s.params.get(PARAM_NAME) === undefined) continue;
    for (const [paramId, value] of s.params.entries()) {
      const pNum = paramId as unknown as number;
      if (KNOWN_TIER_PARAMS.has(pNum)) continue;
      const v = typeof value === 'bigint' ? Number(value) : value;
      if (typeof v !== 'number' || v < 1 || v > 10) continue;

      let valMap = paramCounts.get(pNum);
      if (!valMap) { valMap = new Map(); paramCounts.set(pNum, valMap); }
      valMap.set(v, (valMap.get(v) || 0) + 1);
    }
  }

  const candidates: { param: number; count: number; values: number[] }[] = [];
  for (const [param, valMap] of paramCounts.entries()) {
    const total = [...valMap.values()].reduce((a, b) => a + b, 0);
    const values = [...valMap.keys()].sort((a, b) => a - b);
    if (total >= 500 && values.length >= 3 && values.every(v => v >= 1 && v <= 6)) {
      candidates.push({ param, count: total, values });
    }
  }

  candidates.sort((a, b) => b.count - a.count);

  if (candidates.length === 0) {
    throw new Error(
      'Could not auto-discover a tier param for this league. ' +
      'Pass --tier-param <n> explicitly (run `tasks discover` first to find it).',
    );
  }
  if (candidates.length > 1) {
    console.log(`Multiple tier-param candidates found: ${candidates.map(c => `${c.param} (${c.count})`).join(', ')}`);
    console.log(`  Picking highest-count: ${candidates[0].param}`);
  }
  return candidates[0].param;
}

async function fetchWikiTaskNames(url: string): Promise<Set<string>> {
  const response = await axios.get(url);
  const $ = cheerio.load(response.data);
  const names = new Set<string>();

  $('tr[data-league-area-for-filtering][data-league-tier]').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const name = $(cells[1]).text().replace(/\s+/g, ' ').trim();
    if (name) names.add(normalizeName(name));
  });

  return names;
}
