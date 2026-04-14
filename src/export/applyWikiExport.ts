/**
 * Receiving side of the wiki-team handoff.
 *
 * Reads the JSON array they send back ({ varbitIndex, name, realStructId }),
 * resolves each entry to a placeholder structId in our registry, and calls
 * the existing applyRealStructIds + writeMappings flow.
 *
 * Match priority:
 *   1. Normalized name match - authoritative. Wiki editors assign
 *      `data-taskid` manually (per coopermor), so varbitIndex is NOT a
 *      reliable identity across sources.
 *   2. varbitIndex fallback - only applied when a registry entry exists
 *      at that index AND its name normalizes identically. Any mismatch
 *      is rejected as a likely false positive rather than overwriting
 *      the wrong task with a real structId.
 *
 * Does NOT touch LEAGUE_N.full.json - placeholders there stay stable so
 * existing web-tool routes keep working. The mapping table is the bridge.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { resolveOutputDir } from '../leagues';
import { loadRegistry, saveRegistry, indexRegistry, normalizeName, RegistryEntry } from '../wiki/idRegistry';
import { applyRealStructIds, writeMappings } from '../output/mappings';

interface WikiExportEntry {
  varbitIndex: number;
  name: string;
  realStructId: number;
}

export async function applyWikiExport(taskType: string, filePath: string): Promise<void> {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  if (!Array.isArray(raw)) {
    throw new Error(`Expected a JSON array in ${filePath}, got ${typeof raw}`);
  }
  const entries = raw as WikiExportEntry[];
  console.log(`Loaded ${entries.length} entries from ${filePath}`);

  const outputDir = resolveOutputDir(taskType);
  const registryPath = path.join(outputDir, `${taskType}.id-registry.json`);
  const registry = loadRegistry(registryPath);
  const idx = indexRegistry(registry);

  const updates: Array<{ placeholder: number; real: number }> = [];
  const viaName: WikiExportEntry[] = [];
  const viaVarbit: WikiExportEntry[] = [];
  const unmatched: WikiExportEntry[] = [];
  const rejectedVarbitMismatch: Array<{ entry: WikiExportEntry; registryName: string }> = [];

  for (const entry of entries) {
    const normName = entry.name ? normalizeName(entry.name) : '';

    // 1. Name match - authoritative.
    let match: RegistryEntry | undefined = normName ? idx.byName.get(normName) : undefined;
    let how: 'name' | 'varbit' | null = match ? 'name' : null;

    // 2. varbitIndex fallback - only if the resolved entry's name also matches.
    if (!match && entry.varbitIndex && entry.varbitIndex > 0) {
      const candidate = idx.byVarbit.get(entry.varbitIndex);
      if (candidate) {
        if (normName && normalizeName(candidate.name) === normName) {
          match = candidate;
          how = 'varbit';
        } else {
          rejectedVarbitMismatch.push({ entry, registryName: candidate.name });
        }
      }
    }

    if (!match || !how) {
      unmatched.push(entry);
      continue;
    }

    updates.push({ placeholder: match.structId, real: entry.realStructId });
    (how === 'name' ? viaName : viaVarbit).push(entry);
  }

  const { applied, missing } = applyRealStructIds(registry, updates);
  saveRegistry(registryPath, registry);
  console.log(`Applied ${applied} realStructId updates to ${registryPath}`);
  if (missing.length > 0) {
    console.log(`  ${missing.length} placeholder IDs were resolved but not found in registry (shouldn't happen):`);
    for (const m of missing.slice(0, 10)) console.log(`    ${m}`);
  }

  writeMappings(outputDir, taskType, registry);

  console.log('');
  console.log('--- Summary ---');
  console.log(`  Input entries:          ${entries.length}`);
  console.log(`  Matched via name:       ${viaName.length}`);
  console.log(`  Matched via varbit:     ${viaVarbit.length}`);
  console.log(`  Unmatched:              ${unmatched.length}`);
  console.log(`  Rejected (varbit clash): ${rejectedVarbitMismatch.length}`);
  if (rejectedVarbitMismatch.length > 0) {
    console.log('    (varbitIndex hit an existing registry entry, but names differ - likely false positive, skipped)');
    for (const m of rejectedVarbitMismatch.slice(0, 10)) {
      console.log(`      varbit ${m.entry.varbitIndex}: "${m.entry.name}" vs registry "${m.registryName}"`);
    }
    if (rejectedVarbitMismatch.length > 10) console.log(`      ... and ${rejectedVarbitMismatch.length - 10} more`);
  }
  if (unmatched.length > 0) {
    console.log('');
    console.log('Unmatched entries (no registry entry by name, no safe varbit match):');
    for (const u of unmatched.slice(0, 20)) {
      console.log(`    varbit ${u.varbitIndex}, name "${u.name}", real ${u.realStructId}`);
    }
    if (unmatched.length > 20) console.log(`    ... and ${unmatched.length - 20} more`);
    console.log('');
    console.log(`These likely need a rescrape ('tasks scrape-preliminary ${taskType}') first if the wiki added new tasks, then re-run apply-wiki-export.`);
  }
}
