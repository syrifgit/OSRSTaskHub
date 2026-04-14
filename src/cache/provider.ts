import { CacheProvider, DiskCacheProvider, FlatCacheProvider, FileProvider } from '@abextm/cache2';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Build a cache provider for the pipeline.
 *
 * Reads `OSRS_CACHE_DIR` env var if set, otherwise falls back to ./osrs-cache
 * (populated by `cache update` from abextm/osrs-cache).
 *
 * Auto-detects the cache format:
 *   - `main_file_cache.dat2` present -> raw Jagex cache (DiskCacheProvider).
 *     Use this to point at a jagexcache/oldschool/LIVE directory from a
 *     local OSRS or RuneLite install, skipping the abextm mirror entirely.
 *   - `0.flatcache` present -> denormalized flatcache (FlatCacheProvider).
 *     This is what `cache update` downloads.
 */
export async function createCacheProvider(): Promise<CacheProvider> {
  const cacheDir = process.env.OSRS_CACHE_DIR || './osrs-cache';

  if (await fileExists(path.join(cacheDir, 'main_file_cache.dat2'))) {
    console.log(`Using DiskCache (raw Jagex format) at ${cacheDir}`);
    return new DiskCacheProvider(createFsFileProvider(cacheDir));
  }
  if (await fileExists(path.join(cacheDir, '0.flatcache'))) {
    return new FlatCacheProvider(createFsFileProvider(cacheDir));
  }
  throw new Error(
    `No OSRS cache found at "${cacheDir}". Expected either main_file_cache.dat2 ` +
    `(raw Jagex format) or 0.flatcache (abextm format). ` +
    `Set OSRS_CACHE_DIR or run \`cache update\`.`,
  );
}

function createFsFileProvider(dir: string): FileProvider {
  return {
    async getFile(name: string): Promise<Uint8Array | undefined> {
      try {
        const buf = await fs.readFile(path.join(dir, name));
        // Node's Buffer is a Uint8Array subclass; wrap as a view (no copy) so
        // very large files (main_file_cache.dat2 is ~280MB) don't blow memory
        // and so DataView reads stay aligned.
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } catch {
        return undefined;
      }
    },
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
