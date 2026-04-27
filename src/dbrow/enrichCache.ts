/**
 * Cache-side enrichment for L6 tasks.
 *
 * Given a list of dbRowIds and a table schema, read each dbRow from the cache
 * and extract the column values defined by the schema. Per-column try/catch so
 * a sparse column (one not populated on a given row) doesn't kill the whole
 * row read - same lesson learned on the plugin side with TaskFromDbRow.loadData.
 *
 * cache2's DBRow is decoded up-front: each row object holds `.values[col]`
 * which is either undefined (column not set on this row) or an array of
 * primitives (always an array even for scalar-typed columns, because the
 * underlying format supports per-stride repeats).
 */

import { CacheProvider, DBRow, Enum } from '@abextm/cache2';
import { ColumnDef, TableSchema, ColumnType } from './tableSchemas';

/**
 * Enum 5950 maps wiki task index -> real dbRowId in table 118.
 *
 * Background: coopermor changed the wiki's data-taskid attributes on
 * 2026-04-15 morning to use the enum-index form (0..N-1) so wikisync
 * per-task progress works. The plugin's getDBTableField still expects the
 * real dbRowId in table 118, so we need this resolution step.
 */
export const L6_TASK_INDEX_ENUM = 5950;

export async function loadTaskIndexMap(
  cache: CacheProvider,
  enumId: number = L6_TASK_INDEX_ENUM,
): Promise<Map<number, number>> {
  const e = await Enum.load(cache, enumId);
  if (!e) throw new Error(`enum ${enumId} not found in cache`);
  const out = new Map<number, number>();
  for (const [k, v] of e.map) {
    if (typeof k === 'number' && typeof v === 'number') {
      out.set(k, v);
    }
  }
  return out;
}

/** Inverse of loadTaskIndexMap: dbRowId -> wikiTaskIndex (sortId). */
export function invertTaskIndexMap(forward: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [k, v] of forward) out.set(v, k);
  return out;
}

/**
 * Load a "dbRowId in set" lookup from a boolean-flag enum.
 *
 * Several L6 meta enums follow the pattern `{ dbRowId: 1 }` to mark a subset
 * of tasks with a boolean property. Enum 5952 = pact tasks. Enum 5953 =
 * pact-reset-granting tasks. Returns the dbRowId keyset.
 */
export async function loadFlagEnum(
  cache: CacheProvider,
  enumId: number,
): Promise<Set<number>> {
  const e = await Enum.load(cache, enumId);
  if (!e) return new Set();
  const out = new Set<number>();
  for (const k of e.map.keys()) {
    if (typeof k === 'number') out.add(k);
  }
  return out;
}

export type CellValue = number | string | null | Array<number | string | null>;

export interface EnrichedRow {
  dbRowId: number;
  /** Map from column name (as per schema) to the extracted value. */
  columns: Record<string, CellValue>;
  /** Columns that were explicitly empty (null in cache). Useful for diagnostics. */
  missingColumns: string[];
}

export interface EnrichOptions {
  /** If true, only load the specified dbRowIds. Otherwise loads all rows in the table. */
  dbRowIds?: number[];
  /** Logging callback for progress/warnings. Defaults to console. */
  logger?: (msg: string) => void;
}

/**
 * Authoritative L6 task membership: dbRowIds where a boolean marker column
 * is set to 1. For L6 that's `league_task_marker` (col 34). Filters out
 * legacy Gridmaster rows that share table 118 but aren't L6 tasks.
 *
 * This is the source of truth for "which dbRowIds are L6 tasks RIGHT NOW."
 * Wiki and enum 5950 both lag this - enum 5950 retains reserved slots for
 * deprecated tasks (e.g. 13956 Dragon Crossbow after the Vorkath 15 swap).
 */
export async function findActiveDbRowIds(
  cache: CacheProvider,
  schema: TableSchema,
  markerColumnName: string,
): Promise<Set<number>> {
  const markerCol = schema.columns[markerColumnName];
  if (!markerCol) {
    throw new Error(`Schema "${schema.name}" has no column "${markerColumnName}"`);
  }
  const allRows = [...(await DBRow.all(cache))];
  const out = new Set<number>();
  for (const r of allRows) {
    if (r.table !== schema.tableId) continue;
    const v = r.values[markerCol.idx];
    if (!v) continue;
    const first = Array.isArray(v) ? v[0] : v;
    if (first === 1) out.add(r.id);
  }
  return out;
}

export async function enrichWithCache(
  cache: CacheProvider,
  schema: TableSchema,
  opts: EnrichOptions = {},
): Promise<EnrichedRow[]> {
  const log = opts.logger ?? ((m: string) => console.log(m));

  // Pull rows. cache2's DBRow.all() is a flat iterator across all tables;
  // filter by the schema's tableId to scope. If a dbRowIds filter is given,
  // narrow further so we only surface rows we actually care about.
  const wantIds = opts.dbRowIds ? new Set(opts.dbRowIds) : null;
  const allRows = [...(await DBRow.all(cache))];
  const tableRows = allRows.filter(r => r.table === schema.tableId);
  const rows = wantIds ? tableRows.filter(r => wantIds.has(r.id)) : tableRows;

  log(`  cache: table ${schema.tableId} has ${tableRows.length} rows, ${rows.length} match filter`);

  if (wantIds) {
    const missing = [...wantIds].filter(id => !rows.find(r => r.id === id));
    if (missing.length) {
      log(`  cache: ${missing.length} requested dbRowIds not found in table ${schema.tableId}: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}`);
    }
  }

  const enriched: EnrichedRow[] = [];
  for (const row of rows) {
    const columns: Record<string, CellValue> = {};
    const missingColumns: string[] = [];

    for (const [colName, def] of Object.entries(schema.columns)) {
      try {
        const raw = row.values[def.idx];
        if (raw == null) {
          missingColumns.push(colName);
          continue;
        }
        columns[colName] = projectCell(raw, def);
      } catch (err) {
        // Guard against any cache2 surprise (unknown types, malformed blobs);
        // the row still ships with whatever columns we did read.
        missingColumns.push(colName);
      }
    }

    enriched.push({
      dbRowId: row.id,
      columns,
      missingColumns,
    });
  }

  return enriched;
}

/**
 * Convert a raw cache cell (array of primitives) into the shape we store.
 * Simple columns -> the scalar value. Pair columns -> the full tuple.
 */
function projectCell(raw: unknown, def: ColumnDef): CellValue {
  if (!Array.isArray(raw)) {
    // Unexpected shape; preserve verbatim.
    return raw as CellValue;
  }
  const arr = raw as Array<number | string | null>;
  if (def.type === 'pair') {
    return arr;
  }
  // Scalar column - return element 0, matching what the plugin reads via
  // client.getDBTableField(dbRowId, col, 0).
  return arr.length > 0 ? arr[0] : null;
}

/** Promote a cell value to a scalar (first element if array). */
export function firstElement(v: CellValue): number | string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length > 0 ? v[0] : null;
  return v;
}

/** Type-aware getters for downstream code. */
export function cellAsString(v: CellValue): string | null {
  const e = firstElement(v);
  return typeof e === 'string' ? e : null;
}

export function cellAsInt(v: CellValue): number | null {
  const e = firstElement(v);
  return typeof e === 'number' ? e : null;
}

/** For pair columns, read a specific tuple index. */
export function cellAt(v: CellValue, idx: number): number | string | null {
  if (!Array.isArray(v)) return idx === 0 ? (v as any) : null;
  return idx < v.length ? v[idx] : null;
}

// Re-export ColumnType so callers don't have to reach into tableSchemas.
export type { ColumnType };
