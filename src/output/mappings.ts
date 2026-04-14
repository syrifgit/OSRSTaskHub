/**
 * Unified task ID mapping table for web tools.
 *
 * One JSON array per league, one entry per currently-active task. Each entry
 * carries every ID the task is known under so web tools can translate routes
 * in either direction (L5 -> L6, preliminary -> real) without joining files.
 *
 * Written to leagues/<dir>/mappings/<TYPE>-mappings.json. Regenerated on
 * every `tasks scrape-preliminary` run (and on `tasks set-real-id`).
 *
 * Task removed from wiki -> entry drops from the mappings file. Registry
 * itself retains the history.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import * as path from 'path';
import { Registry, RegistryEntry, normalizeName } from '../wiki/idRegistry';

interface MappingEntry {
  name: string;
  area: string;
  tier: string;
  varbitIndex: number | null;          // null if wiki hasn't assigned one yet
  league_5_structId: number | null;    // null if no L5 task with this name
  league_6_preliminary_id: number;     // always populated
  league_6_real_structId: number | null; // null until Jagex publishes real cache
}

export function writeMappings(
  outputDir: string,
  taskTypeName: string,
  reg: Registry,
  activeStructIds?: Set<number>,
): void {
  const mappingsDir = path.join(outputDir, 'mappings');
  mkdirSync(mappingsDir, { recursive: true });

  // Filter to active entries when caller provides a set (preliminary scrape),
  // otherwise use all (set-real-id run, which doesn't rescrape).
  const entries = activeStructIds
    ? Object.values(reg.entries).filter(e => activeStructIds.has(e.structId))
    : Object.values(reg.entries);

  const l5Index = loadL5Index();

  const mappings: MappingEntry[] = entries.map(e => ({
    name: e.name,
    area: e.area,
    tier: e.tier,
    varbitIndex: e.varbitIndex > 0 ? e.varbitIndex : null,
    league_5_structId: l5Index.get(e.normalizedName) ?? null,
    league_6_preliminary_id: e.structId,
    league_6_real_structId: e.realStructId,
  }));

  // Sort by preliminary ID for stable diffs across rescrapes
  mappings.sort((a, b) => a.league_6_preliminary_id - b.league_6_preliminary_id);

  const filePath = path.join(mappingsDir, `${taskTypeName}-mappings.json`);
  writeFileSync(filePath, JSON.stringify(mappings, null, 2));

  const l5Count = mappings.filter(m => m.league_5_structId != null).length;
  const realCount = mappings.filter(m => m.league_6_real_structId != null).length;
  console.log(`  Wrote ${mappings.length} task mappings to ${filePath}`);
  console.log(`    with L5 structId: ${l5Count}`);
  console.log(`    with real L6 structId: ${realCount}`);
}

function loadL5Index(): Map<string, number> {
  const index = new Map<string, number>();
  const l5Path = 'leagues/league-5-raging-echoes/LEAGUE_5.full.json';
  if (!existsSync(l5Path)) return index;
  const tasks: Array<{ structId: number; name: string }> = JSON.parse(readFileSync(l5Path, 'utf-8'));
  for (const t of tasks) {
    index.set(normalizeName(t.name), t.structId);
  }
  return index;
}

/**
 * Set the realStructId for one or more registry entries. Called by the
 * `tasks set-real-id` CLI command as Jagex publishes cache data.
 */
export function applyRealStructIds(
  reg: Registry,
  updates: Array<{ placeholder: number; real: number }>,
): { applied: number; missing: Array<number> } {
  let applied = 0;
  const missing: number[] = [];
  for (const u of updates) {
    const entry = reg.entries[String(u.placeholder)];
    if (!entry) {
      missing.push(u.placeholder);
      continue;
    }
    entry.realStructId = u.real;
    applied++;
  }
  return { applied, missing };
}
