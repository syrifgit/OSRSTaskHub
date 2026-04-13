/**
 * Standalone wiki-first scraper for preliminary (pre-cache) task data.
 *
 * Jagex often publishes league tasks on the wiki before the game cache is
 * updated. This module builds a full.json / min.json from the wiki alone,
 * using `unconfirmed-<hash>` string structIds so web tools have something
 * stable to key by until real numeric structIds arrive and the normal
 * pipeline takes over.
 *
 * Requires row attributes `data-league-area-for-filtering` and
 * `data-league-tier` on task <tr> elements (present on the Demonic Pacts
 * Leagues announcement page and likely subsequent leagues).
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { mkdirSync } from 'fs';
import { TaskFull, TaskSkill, WikiColumnConfig, DEFAULT_WIKI_COLUMNS } from '../types';
import { writeFullJson, writeRawJson, writeMinJson, writeCsv } from '../output/writers';
import { findLeagueByTaskType, resolveOutputDir, updateLeague, getWikiConfig } from '../leagues';

// Wiki uses short lowercase keys on data-league-area-for-filtering; map to the
// display names used in prior leagues' full.json for consistency downstream.
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
  easy: 1,
  medium: 2,
  hard: 3,
  elite: 4,
  master: 5,
};

const TIER_KEY_TO_DISPLAY: Record<string, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
  elite: 'Elite',
  master: 'Master',
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

  console.log(`Scraping ${wikiConfig.url}...`);
  const rows = await scrapeRows(wikiConfig.url, DEFAULT_WIKI_COLUMNS);
  console.log(`  Parsed ${rows.length} task rows from wiki`);

  const fullTasks: TaskFull[] = rows.map((row, idx) => {
    const area = AREA_KEY_TO_DISPLAY[row.areaKey] ?? toTitleCase(row.areaKey);
    const tier = TIER_KEY_TO_NUMERIC[row.tierKey] ?? null;
    const tierName = TIER_KEY_TO_DISPLAY[row.tierKey] ?? toTitleCase(row.tierKey);
    const structId = makeUnconfirmedId(area, row.tierKey, row.name);

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

  // Sanity: ensure structIds are unique. If two rows collide on
  // (area, tier, name), disambiguate by mixing sortId into the hash.
  const seen = new Map<string, number>();
  for (const t of fullTasks) {
    const key = String(t.structId);
    if (seen.has(key)) {
      t.structId = makeUnconfirmedId(key, String(t.sortId), '');
    }
    seen.set(String(t.structId), t.sortId);
  }

  const outputDir = resolveOutputDir(taskTypeName);
  mkdirSync(outputDir, { recursive: true });

  const fullPath = writeFullJson(fullTasks, outputDir, taskTypeName);
  console.log(`Wrote ${fullTasks.length} preliminary tasks to ${fullPath}`);

  // Raw dump for debugging - the unmapped wiki rows, so it's obvious what
  // the scraper saw vs what it mapped.
  const rawPath = writeRawJson(rows, outputDir, taskTypeName);
  console.log(`Wrote raw wiki rows to ${rawPath}`);

  const csvPath = writeCsv(fullTasks, outputDir, taskTypeName);
  console.log(`Wrote ${fullTasks.length} tasks to ${csvPath}`);

  const minPath = writeMinJson(fullTasks, outputDir, taskTypeName);
  console.log(`Wrote ${fullTasks.length} tasks to ${minPath}`);

  updateLeague(taskTypeName, {
    taskCount: fullTasks.length,
    taskFile: `${taskTypeName}.full.json`,
  } as any);
  console.log('Updated leagues/index.json');

  console.log(
    '\nNote: structIds are `unconfirmed-<hash>` placeholders. Once Jagex updates the game cache, ' +
    'run `npm run cli -- tasks generate-full ' + taskTypeName + ' --force` to overwrite with real structIds.',
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

// `unconfirmed-<6-7 char base36 hash>`. Self-documenting, deterministic
// across scrapes, and a string so it can't be mistaken for a real numeric
// structId when cache data eventually arrives.
function makeUnconfirmedId(a: string, b: string, c: string): string {
  const key = `${a}|${b}|${c}`;
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  }
  return `unconfirmed-${(hash >>> 0).toString(36)}`;
}

function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
