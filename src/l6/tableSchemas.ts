/**
 * Declarative column schemas for DB tables the scraper reads.
 *
 * Table 118 ("action") previously held Gridmaster tasks with 30 columns. When
 * Leagues 6 launches (2026-04-15), Jagex is expected to extend this table with
 * league-specific columns (tier, region, etc). Update this file post-cache-drop
 * rather than touching scraper code.
 *
 * Reference for the initial 30 columns: perterter's cs2 schema dump from the
 * Gridmaster investigation. See .claude/Routes/Custom Tasks/dump-gridmaster-all.mjs
 * for the raw-column spelunking approach.
 */

export type ColumnType =
  | 'string'
  | 'int'
  | 'bool'
  | 'sprite'
  | 'obj'          // item
  | 'npc'
  | 'struct'
  | 'dbrow'
  | 'stat'
  | 'category'
  | 'pair';        // heterogeneous tuple; exact shape per-column below

export interface ColumnDef {
  /** Column index in the DB row (0-based). */
  idx: number;
  /** Primary type. For pair columns this reflects element 0. */
  type: ColumnType;
  /** For pair/tuple columns, full element-by-element type list. */
  tuple?: ColumnType[];
  /** Short human-readable note, used in diagnostics. Not shipped to plugin. */
  note?: string;
}

export interface TableSchema {
  tableId: number;
  /** Internal Jagex table name (from DBTableID.java when regenerated). */
  name: string;
  /** Column name (as used by plugin intParamMap/stringParamMap) -> definition. */
  columns: Record<string, ColumnDef>;
}

/**
 * Table 118 seed. Column names taken from perterter's cs2 dump
 * (action:action_name, action:boss_kill, etc). Leagues 6 additions get
 * appended here once we see the new cache.
 */
export const TABLE_118_ACTION: TableSchema = {
  tableId: 118,
  name: 'action',
  columns: {
    // Display fields
    action_name: { idx: 0, type: 'string', note: 'Human-readable task title' },
    // Post-L6 cache: col 1 now holds the description directly as a string
    // (Gridmaster era had sprite here at col 1, description in a col-3 pair).
    // Old sprite column remains at 1 for Gridmaster rows; new L6 rows put
    // description string here. Plugin reads element 0 either way.
    action_description: { idx: 1, type: 'string', note: 'L6: full description. Gridmaster legacy: sprite id.' },
    action_display_object: { idx: 2, type: 'obj' },
    action_display_desc: {
      idx: 3,
      type: 'pair',
      tuple: ['string', 'string'],
      note: 'Gridmaster legacy: [label, body] pair. Sparse on L6 rows.',
    },
    action_display_show_derived_desc: { idx: 4, type: 'bool' },

    // Meta flags
    custom_tracking: { idx: 7, type: 'bool' },

    // Completion trigger columns. Each task typically uses exactly one of these.
    boss_kill: { idx: 8, type: 'npc' },
    boss_kill_category: { idx: 9, type: 'category' },
    boss_kill_extras: {
      idx: 10,
      type: 'pair',
      tuple: ['bool', 'bool'],
    },
    npc_kill: { idx: 11, type: 'npc' },
    npc_kill_category: { idx: 12, type: 'category' },
    npc_kill_slayer_category: { idx: 13, type: 'int' },
    equip_item: { idx: 14, type: 'obj' },
    total_level: { idx: 15, type: 'int' },
    level: {
      idx: 16,
      type: 'pair',
      tuple: ['stat', 'int'],
      note: 'Pair: [skill, required level]',
    },
    collection_generic: { idx: 17, type: 'obj' },
    collection_specific: { idx: 18, type: 'struct' },
    loot_drop: { idx: 19, type: 'obj' },
    loot_drop_specific_npc: { idx: 20, type: 'npc' },
    quest: { idx: 21, type: 'dbrow' },
    mine_ore: { idx: 22, type: 'obj' },
    hunter: {
      idx: 23,
      type: 'pair',
      tuple: ['obj', 'bool'],
    },
    poh_build: { idx: 24, type: 'dbrow' },
    poh_set_portal: { idx: 25, type: 'int' },
    create_item: { idx: 26, type: 'obj' },
    chop_logs: { idx: 27, type: 'obj' },
    leagues_task: { idx: 28, type: 'struct' },
    child_action: { idx: 29, type: 'dbrow' },

    // Leagues 6 columns (confirmed 2026-04-15 from live post-reboot cache):
    league_tier: {
      idx: 32,
      type: 'int',
      note: '1=Easy, 2=Medium, 3=Hard, 4=Elite, 5=Master. Populates on ~2074 rows (L6 tasks + some Gridmaster).',
    },
    league_task_marker: {
      idx: 34,
      type: 'bool',
      note: 'Always 1 on L6 tasks. Populates on exactly 1592 rows = full L6 task set.',
    },
    league_bucket: {
      idx: 35,
      type: 'int',
      note: 'Values 1-6. Skill category or pact type, TBC. 2082 rows populated.',
    },
    league_area: {
      idx: 36,
      type: 'int',
      note: 'Area code: 0=Global, 2=Karamja, 3=Asgarnia, 4=Kandarin, 5=Morytania, 6=Desert, 7=Tirannwn, 8=Fremennik, 10=Kourend, 11=Wilderness, 21=Varlamore. (Mapping inferred from wiki task-count match.)',
    },
  },
};

/** Registry of known schemas by name. */
export const SCHEMAS: Record<string, TableSchema> = {
  action: TABLE_118_ACTION,
};

export function getSchema(name: string): TableSchema {
  const s = SCHEMAS[name];
  if (!s) throw new Error(`Unknown table schema "${name}". Known: ${Object.keys(SCHEMAS).join(', ')}`);
  return s;
}

/** Column names classified by their plugin-side target map. */
export function splitColumnsByPluginMap(schema: TableSchema): {
  stringCols: Array<[string, ColumnDef]>;
  intCols: Array<[string, ColumnDef]>;
} {
  const stringCols: Array<[string, ColumnDef]> = [];
  const intCols: Array<[string, ColumnDef]> = [];
  for (const [name, def] of Object.entries(schema.columns)) {
    const effective = def.type === 'pair' ? def.tuple?.[0] ?? 'int' : def.type;
    if (effective === 'string') stringCols.push([name, def]);
    else intCols.push([name, def]);
  }
  return { stringCols, intCols };
}
