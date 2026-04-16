/**
 * Generate task-types.json intParamMap/stringParamMap blocks directly from
 * a TableSchema.
 *
 * Pre-launch, perterter/syrif had to hand-author these maps after inspecting
 * the new cache table. This makes them a one-liner: the schema names and
 * indices are already canonical in tableSchemas.ts, so the task-types.json
 * entry should mirror them 1:1.
 */

import { TableSchema, splitColumnsByPluginMap, getSchema } from './tableSchemas';

export interface ParamMapOutput {
  intParamMap: Record<string, number>;
  stringParamMap: Record<string, number>;
}

/**
 * Build the plugin-facing param maps from a schema.
 *
 * @param schema The TableSchema to derive from.
 * @param include Optional allowlist of column names to surface. Defaults to
 *                everything in the schema. Useful for trimming to just the
 *                columns the plugin needs (e.g. excluding Gridmaster-era
 *                trigger columns that L6 rows don't populate).
 */
export function buildParamMaps(schema: TableSchema, include?: string[]): ParamMapOutput {
  const { stringCols, intCols } = splitColumnsByPluginMap(schema);
  const allow = include ? new Set(include) : null;

  const out: ParamMapOutput = { intParamMap: {}, stringParamMap: {} };
  for (const [name, def] of stringCols) {
    if (allow && !allow.has(name)) continue;
    out.stringParamMap[name] = def.idx;
  }
  for (const [name, def] of intCols) {
    if (allow && !allow.has(name)) continue;
    out.intParamMap[name] = def.idx;
  }
  return out;
}

/** Columns the plugin currently uses for L6. Keeps the output focused. */
export const L6_PLUGIN_COLUMNS = [
  'action_name',
  'action_description',
  'league_tier',
  'league_task_marker',
  'league_category',
  'league_area',
];

/**
 * Plugin uses friendlier aliases in task-types.json (e.g. "name" not
 * "action_name", "tier" not "league_tier"). Translate column names to those
 * aliases for the output block.
 */
export const L6_COLUMN_ALIASES: Record<string, string> = {
  action_name: 'name',
  action_description: 'description',
  league_tier: 'tier',
  league_task_marker: 'league_task_marker',
  league_category: 'category',
  league_area: 'area',
};

export function buildL6ParamMaps(): ParamMapOutput {
  const schema = getSchema('action');
  const raw = buildParamMaps(schema, L6_PLUGIN_COLUMNS);
  return applyAliases(raw, L6_COLUMN_ALIASES);
}

function applyAliases(
  maps: ParamMapOutput,
  aliases: Record<string, string>,
): ParamMapOutput {
  const out: ParamMapOutput = { intParamMap: {}, stringParamMap: {} };
  for (const [k, v] of Object.entries(maps.stringParamMap)) {
    out.stringParamMap[aliases[k] ?? k] = v;
  }
  for (const [k, v] of Object.entries(maps.intParamMap)) {
    out.intParamMap[aliases[k] ?? k] = v;
  }
  return out;
}
