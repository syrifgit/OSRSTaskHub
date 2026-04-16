/**
 * Per-league DBROW scraper config.
 *
 * L6 is the first DBROW-sourced league (Demonic Pacts, 2026-04-15). Future
 * leagues are likely to reuse the same pattern (wiki -> task-index enum ->
 * dbRow in a known table) but with different IDs. Keep the mechanical
 * knobs here so adding L7+ is a config entry, not a new module.
 */

import { LEAGUE_6_CONFIG } from './leagues/league-6';

/** Registry of known DBROW-sourced leagues by taskType. */
export const LEAGUE_CONFIGS: Record<string, LeagueDbrowConfig> = {
  LEAGUE_6: LEAGUE_6_CONFIG,
};

export function getLeagueConfig(taskType: string): LeagueDbrowConfig {
  const c = LEAGUE_CONFIGS[taskType.toUpperCase()];
  if (!c) {
    throw new Error(
      `No DBROW config for "${taskType}". Known: ${Object.keys(LEAGUE_CONFIGS).join(', ')}`,
    );
  }
  return c;
}

export interface LeagueDbrowConfig {
  /** Matches TaskTypeDefinition.taskJsonName (e.g. "LEAGUE_6"). */
  taskType: string;

  /** Log prefix for this league's scraper output. */
  logPrefix: string;

  /**
   * Enum that maps wikiTaskIndex (0..N-1) -> real dbRowId in the target
   * table. For L6 this is 5950. The wiki's data-taskid attribute holds
   * the index, the plugin needs the dbRowId, and this enum bridges them.
   */
  taskIndexEnumId: number;

  /** Name of the table schema (key into SCHEMAS registry). */
  schemaName: string;

  /** Wiki structure - per-league because attributes / row markup can vary. */
  wiki: LeagueWikiSpec;

  /** Decoders for int-coded columns. Used in display-ready output. */
  decoders: LeagueDecoders;
}

export interface LeagueWikiSpec {
  /** CSS selector for task rows (cheerio). */
  rowSelector: string;
  /** Attribute holding the wiki task index (data-taskid). */
  taskIndexAttr: string;
  /** Attribute holding the tier key (e.g. "easy"). */
  tierAttr: string;
  /** Attribute holding the area key (e.g. "karamja"). */
  areaAttr: string;
  /** Attribute holding the points value. */
  pointsAttr: string;
  /** Attribute indicating pact/special-task flag (present on L6). May be omitted for future leagues. */
  pactTaskAttr?: string;
  /** tierKey -> numeric tier (1..5). */
  tierKeyToNumeric: Record<string, number>;
  /** tierKey -> display label. */
  tierKeyToDisplay: Record<string, string>;
  /** areaKey -> display label. */
  areaKeyToDisplay: Record<string, string>;
}

export interface LeagueDecoders {
  /** Category int -> display name. L5 had enum 3413 for this; L6 hardcodes. */
  categoryName: Record<number, string>;
  /** Area int -> display name. L5 had enum 3412 for this; L6 hardcodes. */
  areaName: Record<number, string>;
}
