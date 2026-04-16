/**
 * L6 (Demonic Pacts) DBROW scraper config.
 *
 * Constants here were confirmed during the 2026-04-15 launch:
 *   - Enum 5950: 1592-entry map of wikiTaskIndex -> dbRowId in table 118.
 *     coopermor changed the wiki's data-taskid to the enum-index form on
 *     launch morning so wikisync progress works.
 *   - Table 118 "action": holds L6 tasks alongside legacy Gridmaster rows.
 *     L6-specific cols: tier=32, league_task_marker=34, category=35, area=36.
 *   - Category / area decoders hand-validated post-launch by cross-tab.
 *     See .claude/Routes/Custom Tasks/analyze-table-118-deep.mjs for the
 *     evidence trail.
 */

import { LeagueDbrowConfig } from '../config';

export const LEAGUE_6_CONFIG: LeagueDbrowConfig = {
  taskType: 'LEAGUE_6',
  logPrefix: '[L6]',
  taskIndexEnumId: 5950,
  schemaName: 'action',

  wiki: {
    rowSelector: 'tr[data-taskid][data-league-tier]',
    taskIndexAttr: 'data-taskid',
    tierAttr: 'data-league-tier',
    areaAttr: 'data-league-area-for-filtering',
    pointsAttr: 'data-league-points',
    pactTaskAttr: 'data-pact-task',

    tierKeyToNumeric: {
      easy: 1,
      medium: 2,
      hard: 3,
      elite: 4,
      master: 5,
    },

    tierKeyToDisplay: {
      easy: 'Easy',
      medium: 'Medium',
      hard: 'Hard',
      elite: 'Elite',
      master: 'Master',
    },

    // 11 areas (no misthalin in L6). general = "Global" bucket.
    areaKeyToDisplay: {
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
    },
  },

  decoders: {
    // L5 had stringEnumMap.category: 3413 for this. L6 doesn't register an
    // equivalent enum (at least not at launch). If Jagex adds one later, swap
    // to a dynamic enum read.
    categoryName: {
      1: 'Skill',
      2: 'Combat',
      3: 'Quest',
      4: 'Achievement',
      5: 'Minigame',
      6: 'Other',
    },

    // L5 had stringEnumMap.area: 3412. Same story - hardcode until Jagex
    // exposes an enum. Mapping was inferred from wiki task-count cross-tab.
    areaName: {
      0: 'Global',
      2: 'Karamja',
      3: 'Asgarnia',
      4: 'Kandarin',
      5: 'Morytania',
      6: 'Desert',
      7: 'Tirannwn',
      8: 'Fremennik',
      10: 'Kourend',
      11: 'Wilderness',
      21: 'Varlamore',
    },
  },
};
