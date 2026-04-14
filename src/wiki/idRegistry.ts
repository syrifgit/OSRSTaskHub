/**
 * Persistent ID registry for preliminary (pre-cache) task data.
 *
 * Web tools bind their state to whatever placeholder structIds we publish.
 * If a wiki rescrape shifted those IDs (because an editor renamed a task,
 * moved it between areas, etc.) that state would silently break. The
 * registry pins each placeholder structId to the task identity across
 * rescrapes, with best-effort re-matching when wiki fields change.
 *
 * Matching priority per wiki row:
 *   1. varbitIndex (data-taskid, if non-zero) - authoritative
 *   2. normalizedName (lowercase, alphanumeric-only)
 *   3. no match -> assign a fresh placeholder
 *
 * The registry also carries `realStructId` per entry, populated once Jagex
 * publishes real cache data. This is what the preliminary-to-real mapping
 * table exports.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import * as path from 'path';

export interface RegistryEntry {
  structId: number;
  name: string;
  normalizedName: string;
  area: string;
  tier: string;
  varbitIndex: number;   // 0 if wiki row has data-taskid=0 (unassigned)
  realStructId: number | null;  // filled once Jagex publishes cache data
  firstSeen: string;     // ISO date (YYYY-MM-DD)
  lastSeen: string;      // ISO date
}

export interface Registry {
  entries: Record<string, RegistryEntry>;  // structId (as string) -> entry
}

export interface RegistryIndex {
  reg: Registry;
  byVarbit: Map<number, RegistryEntry>;
  byName: Map<string, RegistryEntry>;
}

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function loadRegistry(filePath: string): Registry {
  if (!existsSync(filePath)) return { entries: {} };
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export function saveRegistry(filePath: string, reg: Registry): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(reg, null, 2));
}

export function indexRegistry(reg: Registry): RegistryIndex {
  const byVarbit = new Map<number, RegistryEntry>();
  const byName = new Map<string, RegistryEntry>();
  for (const entry of Object.values(reg.entries)) {
    if (entry.varbitIndex > 0) byVarbit.set(entry.varbitIndex, entry);
    byName.set(entry.normalizedName, entry);
  }
  return { reg, byVarbit, byName };
}

/**
 * Resolve a structId for a wiki row, reusing existing registry entries when
 * possible. Updates the registry in place with new/updated entry data.
 */
export function assignStructId(
  idx: RegistryIndex,
  row: { name: string; area: string; tier: string; tierKey: string; varbitIndex: number },
  today: string,
): number {
  const normalized = normalizeName(row.name);

  // Priority 1: varbitIndex match (most stable when available)
  let match: RegistryEntry | undefined;
  if (row.varbitIndex > 0) {
    match = idx.byVarbit.get(row.varbitIndex);
  }
  // Priority 2: exact normalized name match
  if (!match) {
    match = idx.byName.get(normalized);
  }

  if (match) {
    // Update the registry entry with latest wiki data (handle renames etc.)
    match.name = row.name;
    match.normalizedName = normalized;
    match.area = row.area;
    match.tier = row.tier;
    if (row.varbitIndex > 0) match.varbitIndex = row.varbitIndex;
    match.lastSeen = today;
    // Maintain secondary indices if anything changed
    idx.byName.set(normalized, match);
    if (row.varbitIndex > 0) idx.byVarbit.set(row.varbitIndex, match);
    return match.structId;
  }

  // No match - assign a new placeholder using the same hash seed as the
  // pre-registry implementation so first-run IDs match historical output.
  const newId = generateNewStructId(idx, { name: row.name, area: row.area, tierKey: row.tierKey });
  const entry: RegistryEntry = {
    structId: newId,
    name: row.name,
    normalizedName: normalized,
    area: row.area,
    tier: row.tier,
    varbitIndex: row.varbitIndex,
    realStructId: null,
    firstSeen: today,
    lastSeen: today,
  };
  idx.reg.entries[String(newId)] = entry;
  if (entry.varbitIndex > 0) idx.byVarbit.set(entry.varbitIndex, entry);
  idx.byName.set(normalized, entry);
  return newId;
}

/**
 * Generate a placeholder structId in [100000, 999999]. Uses a stable hash of
 * (area, tier, name) as the starting point, walks forward on collision with
 * an existing registry entry. Hash-based so fresh clones with an empty
 * registry produce the same IDs as the current set if content is unchanged.
 */
function generateNewStructId(idx: RegistryIndex, row: { name: string; area: string; tierKey: string }): number {
  const used = new Set<number>(Object.values(idx.reg.entries).map(e => e.structId));
  // Hash input matches the original `makePlaceholderStructId(area, tierKey, name)`
  // contract so the first run of the registry produces identical IDs to what
  // web tools already have from the pre-registry scrape.
  const base = hashToRange(`${row.area}|${row.tierKey}|${row.name}`);
  for (let i = 0; i < 900_000; i++) {
    const candidate = 100_000 + ((base - 100_000 + i) % 900_000);
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Exhausted placeholder ID space (900k entries - something is very wrong)');
}

function hashToRange(key: string): number {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 900_000) + 100_000;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
