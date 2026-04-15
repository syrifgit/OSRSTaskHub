/**
 * L6 output writers. Mirror the shape of src/output/writers.ts but emit
 * `dbRowId` in place of `structId`. Separate file so we don't break existing
 * struct-path writers.
 */

import { writeFileSync, readFileSync } from 'fs';
import * as path from 'path';
import { TaskSkill } from '../types';
import { L6WikiRow } from './scrapeWiki';
import { EnrichedRow, CellValue } from './enrichCache';

export interface L6Task {
  /** Real dbRowId in cache table 118. null if enum 5950 resolution hasn't happened. */
  dbRowId: number | null;
  /** Wiki's data-taskid, which is the enum-5950 index (varbit index). */
  wikiTaskIndex: number;
  sortId: number;
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

  /** Optional cache-enrichment data. */
  cacheColumns?: Record<string, CellValue>;
  cacheMissingColumns?: string[];

  /** From classifier. */
  classification?: string;
  location?: { x: number; y: number; plane: number };
}

export interface L6LocationEntry {
  classification: string;
  reason?: string;
  location?: { x: number; y: number; plane: number };
}

/**
 * Combine wiki rows with optional cache enrichment into L6Task records
 * keyed by dbRowId.
 */
export function combineWikiAndCache(
  wikiRows: L6WikiRow[],
  enriched?: EnrichedRow[],
): L6Task[] {
  const cacheByDbRowId = new Map<number, EnrichedRow>();
  if (enriched) {
    for (const e of enriched) cacheByDbRowId.set(e.dbRowId, e);
  }

  return wikiRows.map(r => {
    const task: L6Task = {
      dbRowId: r.dbRowId,
      wikiTaskIndex: r.wikiTaskIndex,
      sortId: r.sortId,
      name: r.name,
      description: r.description,
      area: r.area,
      tier: r.tier,
      tierName: r.tierName,
      points: r.points,
      pactTask: r.pactTask,
    };
    if (r.skills.length > 0) task.skillRequirements = r.skills;
    if (r.completionPercent != null) task.completionPercent = r.completionPercent;
    if (r.requirements) task.wikiNotes = r.requirements;
    if (r.requirementsHtml) task.wikiNotesHtml = r.requirementsHtml;

    const enrichedRow = cacheByDbRowId.get(r.dbRowId);
    if (enrichedRow) {
      task.cacheColumns = enrichedRow.columns;
      if (enrichedRow.missingColumns.length > 0) {
        task.cacheMissingColumns = enrichedRow.missingColumns;
      }
    }
    return task;
  });
}

export function writeL6FullJson(tasks: L6Task[], outputDir: string, taskTypeName: string): string {
  const filePath = path.join(outputDir, `${taskTypeName}.full.json`);
  const ordered = tasks.map(t => {
    const o: Record<string, any> = {
      name: t.name,
      description: t.description,
      // Duplicate dbRowId as structId so existing web tools that key by
      // structId keep working without a rekey. The DBROW pipeline doesn't
      // produce real structIds; this is an alias for compatibility only.
      structId: t.dbRowId,
      dbRowId: t.dbRowId,
      wikiTaskIndex: t.wikiTaskIndex,
      sortId: t.sortId,
      area: t.area,
      tier: t.tier,
      tierName: t.tierName,
    };
    if (t.points != null) o.points = t.points;
    if (t.pactTask != null) o.pactTask = t.pactTask;
    if (t.completionPercent != null) o.completionPercent = t.completionPercent;
    if (t.skillRequirements?.length) o.skillRequirements = t.skillRequirements;
    if (t.wikiNotes) o.wikiNotes = t.wikiNotes;
    if (t.wikiNotesHtml) o.wikiNotesHtml = t.wikiNotesHtml;
    if (t.classification) o.classification = t.classification;
    if (t.location) o.location = t.location;
    if (t.cacheColumns && Object.keys(t.cacheColumns).length > 0) {
      o.cacheColumns = t.cacheColumns;
    }
    if (t.cacheMissingColumns?.length) o.cacheMissingColumns = t.cacheMissingColumns;
    return o;
  });
  writeFileSync(filePath, JSON.stringify(ordered, null, 2));
  return filePath;
}

export function writeL6MinJson(tasks: L6Task[], outputDir: string, taskTypeName: string): string {
  const filePath = path.join(outputDir, `${taskTypeName}.min.json`);
  const minTasks = tasks.map(t => {
    const min: Record<string, any> = {
      dbRowId: t.dbRowId,
      sortId: t.sortId,
    };
    if (t.dbRowId == null) min.wikiTaskIndex = t.wikiTaskIndex;
    // Filter / display data pre-baked from wiki so plugin doesn't need to
    // resolve cache enums for tier/area labels.
    if (t.tier != null) min.tier = t.tier;
    if (t.tierName) min.tierName = t.tierName;
    if (t.area) min.area = t.area;
    if (t.points != null) min.points = t.points;
    if (t.pactTask != null) min.pactTask = t.pactTask;
    if (t.skillRequirements?.length) min.skills = t.skillRequirements;
    if (t.wikiNotes) min.wikiNotes = t.wikiNotes;
    if (t.completionPercent != null) min.completionPercent = t.completionPercent;
    if (t.location) min.location = t.location;
    return min;
  });
  writeFileSync(filePath, JSON.stringify(minTasks, null, 2));
  return filePath;
}

export function writeL6RawJson(rawRows: any[], outputDir: string, taskTypeName: string): string {
  const filePath = path.join(outputDir, `${taskTypeName}.raw.json`);
  writeFileSync(filePath, JSON.stringify(rawRows, null, 2));
  return filePath;
}

export function writeL6Csv(tasks: L6Task[], outputDir: string, taskTypeName: string): string {
  const filePath = path.join(outputDir, `${taskTypeName}.csv`);
  const headers = [
    'dbRowId', 'sortId', 'name', 'description', 'area',
    'tier', 'tierName', 'points', 'pactTask',
    'completionPercent', 'skillRequirements', 'wikiNotes', 'classification',
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
      t.tier, t.tierName, t.points, t.pactTask,
      t.completionPercent, skillsStr, t.wikiNotes, t.classification,
    ].map(escape).join(',');
  });
  writeFileSync(filePath, [headers.join(','), ...rows].join('\n') + '\n');
  return filePath;
}

/**
 * Merge classifier output (keyed by whatever ID field was emitted) into an
 * existing L6 full.json. Expected keys: the dbRowId as a string.
 */
export function mergeL6Locations(
  fullJsonPath: string,
  locationsPath: string,
): { merged: number; withLocation: number } {
  const tasks: L6Task[] = JSON.parse(readFileSync(fullJsonPath, 'utf-8'));
  const locations: Record<string, L6LocationEntry> = JSON.parse(readFileSync(locationsPath, 'utf-8'));

  let merged = 0;
  let withLocation = 0;
  for (const t of tasks) {
    const key = String(t.dbRowId ?? t.wikiTaskIndex);
    const loc = locations[key];
    if (!loc) continue;
    t.classification = loc.classification;
    if (loc.location) {
      t.location = loc.location;
      withLocation++;
    }
    merged++;
  }
  writeFileSync(fullJsonPath, JSON.stringify(tasks, null, 2));
  return { merged, withLocation };
}

/**
 * Write a classifier-shim input file. classify.py currently expects `structId`
 * as the task key. We duplicate dbRowId into that field to reuse the classifier
 * without forking it. Output keys land as dbRowIds because that's what the
 * duplicated structId holds.
 */
export function writeClassifierInput(
  tasks: L6Task[],
  outputPath: string,
): string {
  const shim = tasks.map(t => ({
    structId: t.dbRowId ?? t.wikiTaskIndex,
    dbRowId: t.dbRowId,
    wikiTaskIndex: t.wikiTaskIndex,
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
