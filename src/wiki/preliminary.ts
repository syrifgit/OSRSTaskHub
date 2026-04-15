/**
 * Standalone wiki-first scraper for preliminary (pre-cache) task data.
 *
 * Jagex often publishes league tasks on the wiki before the game cache is
 * updated. This module builds a full.json / min.json from the wiki alone,
 * using 6-digit placeholder structIds (range [100000, 999999], safely above
 * any real league structId seen so far) so web tools have something stable
 * to key by until real cache data arrives and the normal pipeline takes over.
 *
 * Placeholder stability: the ID registry (LEAGUE_N.id-registry.json) pins
 * each placeholder structId to a task identity across rescrapes, so web
 * tools binding state against a placeholder don't get broken if a wiki
 * editor renames or area-moves the task.
 *
 * Requires row attributes `data-league-area-for-filtering` and
 * `data-league-tier` on task <tr> elements (present on the Demonic Pacts
 * Leagues announcement page and likely subsequent leagues).
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { mkdirSync } from 'fs';
import * as path from 'path';
import { TaskFull, TaskSkill, WikiColumnConfig, DEFAULT_WIKI_COLUMNS } from '../types';
import { writeFullJson, writeRawJson, writeMinJson, writeCsv } from '../output/writers';
import { writeMappings } from '../output/mappings';
import { findLeagueByTaskType, resolveOutputDir, updateLeague, getWikiConfig } from '../leagues';
import { loadRegistry, saveRegistry, indexRegistry, assignStructId, todayIso } from './idRegistry';

const AREA_KEY_TO_DISPLAY: Record<string, string> = {
  general: 'Global',
  asgarnia: 'Asgarnia',
  desert: 'Kharidian Desert',
  fremennik: 'Fremennik Province',
  kandarin: 'Kandarin',
  karamja: 'Karamja',
  kourend: 'Kourend & Kebos',
  misthalin: 'Misthalin',
  morytania: 'Morytania',
  tirannwn: 'Tirannwn',
  varlamore: 'Varlamore',
  wilderness: 'Wilderness',
};

const TIER_KEY_TO_NUMERIC: Record<string, number> = {
  easy: 1, medium: 2, hard: 3, elite: 4, master: 5,
};

const TIER_KEY_TO_DISPLAY: Record<string, string> = {
  easy: 'Easy', medium: 'Medium', hard: 'Hard', elite: 'Elite', master: 'Master',
};

interface PreliminaryRow {
  areaKey: string;
  tierKey: string;
  name: string;
  description: string;
  requirements?: string;
  requirementsHtml?: string;
  completionPercent?: number;
  skills: TaskSkill[];
}

export async function scrapePreliminary(taskTypeName: string): Promise<void> {
  const league = findLeagueByTaskType(taskTypeName);
  if (!league) throw new Error(`No league entry for "${taskTypeName}" in leagues/index.json`);

  const wikiConfig = getWikiConfig(taskTypeName);
  if (!wikiConfig) throw new Error(`No wikiUrl configured for "${taskTypeName}" in leagues/index.json`);

  const outputDir = resolveOutputDir(taskTypeName);
  mkdirSync(outputDir, { recursive: true });
  const registryPath = path.join(outputDir, `${taskTypeName}.id-registry.json`);

  console.log(`Scraping ${wikiConfig.url}...`);
  const rows = await scrapeRows(wikiConfig.url, DEFAULT_WIKI_COLUMNS);
  console.log(`  Parsed ${rows.length} task rows from wiki`);

  // Load (or init) the registry and resolve stable IDs for each row.
  const registry = loadRegistry(registryPath);
  const regIdx = indexRegistry(registry);
  const today = todayIso();
  const preexistingIds = Object.keys(registry.entries).length;

  const fullTasks: TaskFull[] = rows.map((row, idx) => {
    const area = AREA_KEY_TO_DISPLAY[row.areaKey] ?? toTitleCase(row.areaKey);
    const tier = TIER_KEY_TO_NUMERIC[row.tierKey] ?? null;
    const tierName = TIER_KEY_TO_DISPLAY[row.tierKey] ?? toTitleCase(row.tierKey);

    const structId = assignStructId(
      regIdx,
      { name: row.name, area, tier: tierName, tierKey: row.tierKey },
      today,
    );

    const task: TaskFull = {
      structId,
      sortId: idx,
      name: row.name,
      description: row.description,
      area,
      category: null,
      skill: null,
      tier,
      tierName,
    };
    if (row.completionPercent != null) task.completionPercent = row.completionPercent;
    if (row.skills.length > 0) task.skillRequirements = row.skills;
    if (row.requirements) task.wikiNotes = row.requirements;
    if (row.requirementsHtml) task.wikiNotesHtml = row.requirementsHtml;
    return task;
  });

  saveRegistry(registryPath, registry);
  const newIds = Object.keys(registry.entries).length - preexistingIds;
  console.log(`Registry: ${Object.keys(registry.entries).length} total entries (${newIds} added this run)`);

  const fullPath = writeFullJson(fullTasks, outputDir, taskTypeName);
  console.log(`Wrote ${fullTasks.length} preliminary tasks to ${fullPath}`);

  const rawPath = writeRawJson(rows, outputDir, taskTypeName);
  console.log(`Wrote raw wiki rows to ${rawPath}`);

  writeCsv(fullTasks, outputDir, taskTypeName);
  writeMinJson(fullTasks, outputDir, taskTypeName);

  // Cross-league and placeholder->real mapping tables for web tools.
  // Pass only the structIds seen in this scrape so mappings drop tasks that
  // Jagex removed from the wiki. The registry itself retains the history.
  const activeIds = new Set(fullTasks.map(t => t.structId));
  writeMappings(outputDir, taskTypeName, registry, activeIds);

  updateLeague(taskTypeName, {
    taskCount: fullTasks.length,
    taskFile: `${taskTypeName}.full.json`,
  } as any);
  console.log('Updated leagues/index.json');

  console.log(
    '\nNote: structIds are 6-digit placeholders in range [100000, 999999]. Once Jagex updates ' +
    'the game cache, run `npm run cli -- tasks generate-full ' + taskTypeName + ' --force` to ' +
    'overwrite with real structIds, or use `tasks set-real-id` to populate them incrementally.',
  );
}

async function scrapeRows(url: string, columns: WikiColumnConfig): Promise<PreliminaryRow[]> {
  const response = await axios.get(url);
  const $ = cheerio.load(response.data);
  const results: PreliminaryRow[] = [];

  $('tr[data-league-area-for-filtering][data-league-tier]').each((_, row) => {
    const $row = $(row);
    const areaKey = ($row.attr('data-league-area-for-filtering') || '').toLowerCase();
    const tierKey = ($row.attr('data-league-tier') || '').toLowerCase();
    if (!areaKey || !tierKey) return;

    const cells = $row.find('td');
    const getCell = (idx: number): string => {
      if (idx < 0 || idx >= cells.length) return '';
      return $(cells[idx]).text().replace(/\s+/g, ' ').trim();
    };

    const skills: TaskSkill[] = [];
    if (columns.requirementsColumnId >= 0 && columns.requirementsColumnId < cells.length) {
      $(cells[columns.requirementsColumnId])
        .find('span.scp')
        .each((_, span) => {
          const $span = $(span);
          const skill = $span.attr('data-skill');
          const level = parseInt($span.attr('data-level') || '', 10);
          if (skill && !isNaN(level)) {
            skills.push({ skill: skill.toUpperCase(), level });
          }
        });
    }

    let completionPercent: number | undefined;
    if (columns.completionColumnId != null && columns.completionColumnId < cells.length) {
      const text = getCell(columns.completionColumnId);
      const match = text.match(/([\d.]+)%?/);
      if (match) completionPercent = parseFloat(match[1]);
    }

    let requirements: string | undefined;
    let requirementsHtml: string | undefined;
    if (columns.requirementsColumnId >= 0 && columns.requirementsColumnId < cells.length) {
      const $reqCell = $(cells[columns.requirementsColumnId]);
      requirementsHtml = $reqCell.html()?.trim() || undefined;
      const clone = $reqCell.clone();
      clone.find('span.scp').remove();
      requirements = clone.text().replace(/\s+/g, ' ').trim() || undefined;
    }
    if (requirements === 'N/A') requirements = undefined;
    if (requirementsHtml) {
      const stripped = requirementsHtml.replace(/<[^>]*>/g, '').trim();
      if (stripped === 'N/A' || stripped === '') requirementsHtml = undefined;
    }

    const name = getCell(columns.nameColumnId);
    if (!name) return;

    results.push({
      areaKey,
      tierKey,
      name,
      description: getCell(columns.descriptionColumnId),
      requirements,
      requirementsHtml,
      completionPercent,
      skills,
    });
  });

  return results;
}

function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
