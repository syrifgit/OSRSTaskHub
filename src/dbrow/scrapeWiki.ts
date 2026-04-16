/**
 * L6 wiki scraper. The Demonic Pacts League tasks page carries dbRowIds in
 * the `data-taskid` attribute of each task <tr>, so the wiki is our authoritative
 * source for {dbRowId, sortId} pairs plus all the tier/area/skills metadata
 * needed for the first-cut output.
 *
 * Row pattern (from wiki source):
 *   <tr id="13530" data-taskid="13530"
 *       data-league-area-for-filtering="general" data-league-tier="easy"
 *       data-league-points="10" data-pact-task="no">
 *
 * 11 areas (asgarnia, desert, fremennik, general, kandarin, karamja, kourend,
 * morytania, tirannwn, varlamore, wilderness) - no misthalin in L6.
 * 5 tiers (easy, medium, hard, elite, master).
 * Points buckets: 10, 30, 80, 200, 400.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { TaskSkill, WikiColumnConfig, DEFAULT_WIKI_COLUMNS } from '../types';
import { LeagueWikiSpec } from './config';

// Plugin's Skill enum only accepts these OSRS skills. Wiki occasionally tags
// "combat level" or similar as a data-skill attribute; the plugin rejects
// anything not in this set, so filter here to avoid downstream "invalid skill
// name X" errors.
const VALID_SKILLS: Set<string> = new Set([
  'ATTACK', 'STRENGTH', 'DEFENCE', 'HITPOINTS', 'MAGIC', 'RANGED', 'PRAYER',
  'AGILITY', 'HERBLORE', 'THIEVING', 'CRAFTING', 'RUNECRAFT', 'SLAYER',
  'FARMING', 'MINING', 'SMITHING', 'FISHING', 'COOKING', 'FIREMAKING',
  'WOODCUTTING', 'FLETCHING', 'HUNTER', 'CONSTRUCTION',
]);

export interface L6WikiRow {
  /**
   * Wiki's data-taskid attribute. As of 2026-04-15 this is the enum 5950 index
   * (0..N-1), NOT the cache dbRowId. Resolve via loadTaskIndexMap() before
   * using this value as a dbRowId against table 118.
   */
  wikiTaskIndex: number;
  /** Real dbRowId in table 118. Populated post-enum-resolution; null until then. */
  dbRowId: number | null;
  sortId: number;
  name: string;
  description: string;
  area: string;
  areaKey: string;
  tier: number | null;
  tierName: string;
  tierKey: string;
  points: number | null;
  pactTask: boolean | null;
  requirements?: string;
  requirementsHtml?: string;
  completionPercent?: number;
  skills: TaskSkill[];
}

export interface ScrapeDbrowWikiOptions {
  /** Wiki URL to scrape. */
  wikiUrl: string;
  /** Per-league wiki layout (selectors, attribute names, key maps). */
  spec: LeagueWikiSpec;
  /** Wiki table column layout. Defaults to DEFAULT_WIKI_COLUMNS. */
  columns?: WikiColumnConfig;
}

export async function scrapeDbrowWiki(options: ScrapeDbrowWikiOptions): Promise<L6WikiRow[]> {
  const { spec } = options;
  const columns = options.columns ?? DEFAULT_WIKI_COLUMNS;
  const response = await axios.get(options.wikiUrl);
  const $ = cheerio.load(response.data);

  const rows: L6WikiRow[] = [];
  const seenIds = new Set<number>();

  $(spec.rowSelector).each((_, el) => {
    const $row = $(el);
    const wikiTaskIndex = parseInt($row.attr(spec.taskIndexAttr) || '', 10);
    if (!Number.isFinite(wikiTaskIndex)) return;
    if (seenIds.has(wikiTaskIndex)) {
      console.warn(`  duplicate ${spec.taskIndexAttr}=${wikiTaskIndex}, keeping first`);
      return;
    }

    const areaKey = ($row.attr(spec.areaAttr) || '').toLowerCase();
    const tierKey = ($row.attr(spec.tierAttr) || '').toLowerCase();
    if (!areaKey || !tierKey) return;

    const pointsAttr = $row.attr(spec.pointsAttr);
    const points = pointsAttr ? parseInt(pointsAttr, 10) : null;

    const pactAttr = spec.pactTaskAttr ? $row.attr(spec.pactTaskAttr) : undefined;
    const pactTask = pactAttr == null ? null : pactAttr === 'yes';

    const cells = $row.find('td');
    const getCell = (idx: number): string => {
      if (idx < 0 || idx >= cells.length) return '';
      return $(cells[idx]).text().replace(/\s+/g, ' ').trim();
    };

    const skills: TaskSkill[] = [];
    if (
      columns.requirementsColumnId >= 0 &&
      columns.requirementsColumnId < cells.length
    ) {
      $(cells[columns.requirementsColumnId])
        .find('span.scp')
        .each((_, span) => {
          const $span = $(span);
          const skill = $span.attr('data-skill');
          const level = parseInt($span.attr('data-level') || '', 10);
          if (skill && !isNaN(level)) {
            const upper = skill.toUpperCase();
            // Plugin rejects non-OSRS skills (eg "COMBAT LEVEL"); drop them here.
            if (VALID_SKILLS.has(upper)) {
              skills.push({ skill: upper, level });
            }
          }
        });
    }

    let completionPercent: number | undefined;
    if (
      columns.completionColumnId != null &&
      columns.completionColumnId < cells.length
    ) {
      const text = getCell(columns.completionColumnId);
      const m = text.match(/([\d.]+)%?/);
      if (m) completionPercent = parseFloat(m[1]);
    }

    let requirements: string | undefined;
    let requirementsHtml: string | undefined;
    if (
      columns.requirementsColumnId >= 0 &&
      columns.requirementsColumnId < cells.length
    ) {
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

    rows.push({
      wikiTaskIndex,
      dbRowId: null,
      // sortId = wikiTaskIndex: the plugin uses sortId as the varbit index
      // into the packed taskVarps array. L6 packs 1592 completion bits across
      // ~50 varps of 32 bits each; sortId must match the enum-index position
      // or completion tracking reads the wrong bit.
      sortId: wikiTaskIndex,
      name,
      description: getCell(columns.descriptionColumnId),
      area: spec.areaKeyToDisplay[areaKey] ?? toTitleCase(areaKey),
      areaKey,
      tier: spec.tierKeyToNumeric[tierKey] ?? null,
      tierName: spec.tierKeyToDisplay[tierKey] ?? toTitleCase(tierKey),
      tierKey,
      points,
      pactTask,
      requirements,
      requirementsHtml,
      completionPercent,
      skills,
    });
    seenIds.add(wikiTaskIndex);
  });

  // No sortId reassignment: sortId = wikiTaskIndex by design so the plugin's
  // bit-packed completion-varp math stays correct.
  // Wiki presents tasks in enum-index order, which maps directly to how
  // completion bits are laid out in the 51 32-bit taskVarps.
  rows.sort((a, b) => a.wikiTaskIndex - b.wikiTaskIndex);

  return rows;
}

function toTitleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
