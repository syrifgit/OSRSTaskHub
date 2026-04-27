/**
 * L6 output writers.
 *
 * Three output shapes:
 *   min.json  - plugin only. {dbRowId, sortId} + wiki-only fields plugin can't derive from cache.
 *   full.json - web tools/planners. Clean display-ready fields, no internals.
 *   raw.json  - master record. Everything from both wiki + cache, nested by source.
 */

import { writeFileSync, readFileSync } from 'fs';
import * as path from 'path';
import { TaskSkill } from '../types';
import { L6WikiRow } from './scrapeWiki';
import { EnrichedRow, CellValue } from './enrichCache';
import { LeagueDecoders } from './config';

export interface L6Task {
  dbRowId: number | null;
  sortId: number;
  category?: number | null;
  categoryName?: string | null;
  name: string;
  description: string;
  area: string | null;
  tier: number | null;
  tierName: string | null;
  points?: number | null;
  pactTask?: boolean | null;
  skillRequirements?: TaskSkill[];
  completionPercent?: number;
  wikiNotes?: string;
  wikiNotesHtml?: string;
  location?: { x: number; y: number; plane: number };

  /** Internal: wiki row for raw.json generation. */
  _wikiRow?: L6WikiRow;
  /** Internal: cache columns for raw.json generation. */
  _cacheColumns?: Record<string, CellValue>;
}

export interface L6LocationEntry {
  classification: string;
  reason?: string;
  location?: { x: number; y: number; plane: number };
}

export interface CacheFirstInputs {
  /** Cache-enriched rows, one per active L6 task (col 34 = 1). Authoritative. */
  enriched: EnrichedRow[];
  /** dbRowId -> wiki row, for supplement merging. Missing entries are fine. */
  wikiByDbRowId: Map<number, L6WikiRow>;
  /** dbRowId -> sortId (from enum 5950 reverse lookup). */
  sortIdByDbRowId: Map<number, number>;
  /** Set of dbRowIds that award a Demonic Pact (enum 5952). */
  pactTaskIds: Set<number>;
  /** tier (1..5) -> default points at that tier (from enum 2671). */
  tierPoints: Map<number, number>;
}

/**
 * Cache-authoritative task assembly. Iterates enriched cache rows as the base
 * truth; wiki rows merge in as supplements for fields cache doesn't have
 * (skillRequirements, wikiNotes, completionPercent).
 *
 * This is the shipping path once a league is live and settled. Handles cases
 * where wiki lags cache (e.g. the Vorkath 15 / Dragon Crossbow swap Jagex
 * made post-launch without updating the wiki).
 */
export function combineCacheAndWiki(
  inputs: CacheFirstInputs,
  decoders: LeagueDecoders,
): L6Task[] {
  const { enriched, wikiByDbRowId, sortIdByDbRowId, pactTaskIds, tierPoints } = inputs;

  return enriched.map(e => {
    const dbRowId = e.dbRowId;
    const cols = e.columns;

    const name = cellAsString(cols.action_name) ?? '(unknown)';
    const description = cellAsString(cols.action_description) ?? '';
    const tier = cellAsInt(cols.league_tier);
    const area = cellAsInt(cols.league_area);
    const category = cellAsInt(cols.league_category);
    const sortId = sortIdByDbRowId.get(dbRowId) ?? -1;

    const task: L6Task = {
      dbRowId,
      sortId,
      name,
      description,
      area: area != null ? (decoders.areaName[area] ?? `area_${area}`) : null,
      tier,
      tierName: tier != null ? tierLabel(tier) : null,
      points: tier != null ? (tierPoints.get(tier) ?? null) : null,
      pactTask: pactTaskIds.has(dbRowId),
      category,
      categoryName: category != null ? (decoders.categoryName[category] ?? null) : null,
      _cacheColumns: cols,
    };

    // Wiki supplements (skills, notes, completion %). When wiki lags cache
    // (e.g. the Vorkath 15 swap), this entry is empty - logged upstream.
    const wiki = wikiByDbRowId.get(dbRowId);
    if (wiki) {
      if (wiki.skills.length > 0) task.skillRequirements = wiki.skills;
      if (wiki.completionPercent != null) task.completionPercent = wiki.completionPercent;
      if (wiki.requirements) task.wikiNotes = wiki.requirements;
      if (wiki.requirementsHtml) task.wikiNotesHtml = wiki.requirementsHtml;
      // Prefer wiki's per-task points value when present (cache tier enum is
      // only the tier default - usually identical but wiki may reflect per-task
      // overrides if Jagex ever ships any).
      if (wiki.points != null) task.points = wiki.points;
      task._wikiRow = wiki;
    }

    return task;
  }).sort((a, b) => a.sortId - b.sortId);
}

function cellAsString(v: CellValue | undefined): string | null {
  if (v == null) return null;
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' ? first : null;
}

function cellAsInt(v: CellValue | undefined): number | null {
  if (v == null) return null;
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'number' ? first : null;
}

function tierLabel(tier: number): string {
  switch (tier) {
    case 1: return 'Easy';
    case 2: return 'Medium';
    case 3: return 'Hard';
    case 4: return 'Elite';
    case 5: return 'Master';
    default: return `Tier ${tier}`;
  }
}

/**
 * Combine wiki rows with optional cache enrichment into L6Task records.
 */
export function combineWikiAndCache(
  wikiRows: L6WikiRow[],
  enriched: EnrichedRow[] | undefined,
  decoders: LeagueDecoders,
): L6Task[] {
  const cacheByDbRowId = new Map<number, EnrichedRow>();
  if (enriched) {
    for (const e of enriched) cacheByDbRowId.set(e.dbRowId, e);
  }

  return wikiRows.map(r => {
    const task: L6Task = {
      dbRowId: r.dbRowId,
      sortId: r.sortId,
      name: r.name,
      description: r.description,
      area: r.area,
      tier: r.tier,
      tierName: r.tierName,
      points: r.points,
      pactTask: r.pactTask,
      _wikiRow: r,
    };
    if (r.skills.length > 0) task.skillRequirements = r.skills;
    if (r.completionPercent != null) task.completionPercent = r.completionPercent;
    if (r.requirements) task.wikiNotes = r.requirements;
    if (r.requirementsHtml) task.wikiNotesHtml = r.requirementsHtml;

    const enrichedRow = cacheByDbRowId.get(r.dbRowId);
    if (enrichedRow) {
      const catCell = enrichedRow.columns.league_category;
      const catVal = Array.isArray(catCell) ? (catCell[0] as number) : (catCell as number | null);
      if (typeof catVal === 'number') {
        task.category = catVal;
        task.categoryName = decoders.categoryName[catVal] ?? null;
      }
      task._cacheColumns = enrichedRow.columns;
    }
    return task;
  });
}

// ============================================================
// full.json - clean, display-ready for web tools / planners
// ============================================================

export function writeL6FullJson(tasks: L6Task[], outputDir: string, taskTypeName: string): string {
  const filePath = path.join(outputDir, `${taskTypeName}.full.json`);
  const ordered = tasks.map(t => {
    const o: Record<string, any> = {
      name: t.name,
      description: t.description,
      structId: t.dbRowId,
      dbRowId: t.dbRowId,
      sortId: t.sortId,
      area: t.area,
      tier: t.tier,
      tierName: t.tierName,
    };
    if (t.points != null) o.points = t.points;
    if (t.pactTask != null) o.pactTask = t.pactTask;
    if (t.category != null) o.category = t.category;
    if (t.categoryName) o.categoryName = t.categoryName;
    if (t.completionPercent != null) o.completionPercent = t.completionPercent;
    if (t.skillRequirements?.length) o.skillRequirements = t.skillRequirements;
    if (t.wikiNotes) o.wikiNotes = t.wikiNotes;
    if (t.wikiNotesHtml) o.wikiNotesHtml = t.wikiNotesHtml;
    if (t.location) o.location = t.location;
    return o;
  });
  writeFileSync(filePath, JSON.stringify(ordered, null, 2));
  return filePath;
}

// ============================================================
// min.json - plugin only: identity + wiki-derived fields
// ============================================================

export function writeL6MinJson(tasks: L6Task[], outputDir: string, taskTypeName: string): string {
  const filePath = path.join(outputDir, `${taskTypeName}.min.json`);
  const minTasks = tasks.map(t => {
    const min: Record<string, any> = {
      dbRowId: t.dbRowId,
      sortId: t.sortId,
    };
    if (t.skillRequirements?.length) min.skills = t.skillRequirements;
    if (t.wikiNotes) min.wikiNotes = t.wikiNotes;
    if (t.completionPercent != null) min.completionPercent = t.completionPercent;
    if (t.location) min.location = t.location;
    return min;
  });
  writeFileSync(filePath, JSON.stringify(minTasks, null, 2));
  return filePath;
}

// ============================================================
// raw.json - master record: wiki + cache sources nested separately
// ============================================================

export function writeL6RawJson(tasks: L6Task[], outputDir: string, taskTypeName: string): string {
  const filePath = path.join(outputDir, `${taskTypeName}.raw.json`);
  const rawTasks = tasks.map(t => {
    const r: Record<string, any> = {
      dbRowId: t.dbRowId,
      sortId: t.sortId,
    };
    if (t._wikiRow) {
      r.wiki = {
        name: t._wikiRow.name,
        description: t._wikiRow.description,
        areaKey: t._wikiRow.areaKey,
        tierKey: t._wikiRow.tierKey,
        tier: t._wikiRow.tier,
        points: t._wikiRow.points,
        pactTask: t._wikiRow.pactTask,
        completionPercent: t._wikiRow.completionPercent ?? null,
        skills: t._wikiRow.skills,
        requirements: t._wikiRow.requirements ?? null,
        requirementsHtml: t._wikiRow.requirementsHtml ?? null,
      };
    }
    if (t._cacheColumns && Object.keys(t._cacheColumns).length > 0) {
      r.cache = t._cacheColumns;
    }
    return r;
  });
  writeFileSync(filePath, JSON.stringify(rawTasks, null, 2));
  return filePath;
}

// ============================================================
// csv - flat export
// ============================================================

export function writeL6Csv(tasks: L6Task[], outputDir: string, taskTypeName: string): string {
  const filePath = path.join(outputDir, `${taskTypeName}.csv`);
  const headers = [
    'dbRowId', 'sortId', 'name', 'description', 'area',
    'tier', 'tierName', 'points', 'pactTask', 'category', 'categoryName',
    'completionPercent', 'skillRequirements', 'wikiNotes',
  ];
  const escape = (v: any): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = tasks.map(t => {
    const skillsStr = t.skillRequirements?.map(s => `${s.skill} ${s.level}`).join('; ') ?? '';
    return [
      t.dbRowId, t.sortId, t.name, t.description, t.area,
      t.tier, t.tierName, t.points, t.pactTask, t.category, t.categoryName,
      t.completionPercent, skillsStr, t.wikiNotes,
    ].map(escape).join(',');
  });
  writeFileSync(filePath, [headers.join(','), ...rows].join('\n') + '\n');
  return filePath;
}

// ============================================================
// Classifier integration
// ============================================================

export function mergeL6Locations(
  fullJsonPath: string,
  locationsPath: string,
): { merged: number; withLocation: number } {
  const tasks: L6Task[] = JSON.parse(readFileSync(fullJsonPath, 'utf-8'));
  const locations: Record<string, L6LocationEntry> = JSON.parse(readFileSync(locationsPath, 'utf-8'));

  let merged = 0;
  let withLocation = 0;
  for (const t of tasks) {
    const loc = locations[String(t.dbRowId)];
    if (!loc) continue;
    if (loc.location) {
      t.location = loc.location;
      withLocation++;
    }
    merged++;
  }
  writeFileSync(fullJsonPath, JSON.stringify(tasks, null, 2));
  return { merged, withLocation };
}

export function writeClassifierInput(
  tasks: L6Task[],
  outputPath: string,
): string {
  const shim = tasks.map(t => ({
    structId: t.dbRowId,
    dbRowId: t.dbRowId,
    sortId: t.sortId,
    name: t.name,
    description: t.description,
    area: t.area,
    tierName: t.tierName,
    tier: t.tier,
    category: null,
    skillRequirements: t.skillRequirements,
  }));
  writeFileSync(outputPath, JSON.stringify(shim, null, 2));
  return outputPath;
}
