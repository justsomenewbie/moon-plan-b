/**
 * Location of the REAL sample precompute run used by the data tests (6 sites, 2026-01-01..2026-04-01
 * hourly, SPICE + PGDA; params_fingerprint 21c3f3f6dc56b1e1). A byte-exact copy of
 * output/sample_2026Q1_spice_pgda is committed under tests/fixtures/ (1.6 MB; tests/.gitattributes
 * keeps git from touching its line endings), so these tests never skip. LUNARNAV_SAMPLE_DIR overrides it.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_DIR = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(BACKEND_DIR, '..');
export const SAMPLE_DIR = path.resolve(process.env['LUNARNAV_SAMPLE_DIR'] ?? path.join(here, 'fixtures', 'sample_2026Q1_spice_pgda'));
export const SAMPLE_RUN_ID = 'pf_21c3f3f6dc56b1e1';
export const CATALOG_PATH = path.join(REPO_ROOT, 'lunarnav', 'catalog', 'sites.json');
export const PYTHON_BIN = path.join(REPO_ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const hasSample = (): boolean => existsSync(path.join(SAMPLE_DIR, 'manifest.json'));
export const hasPython = (): boolean => existsSync(PYTHON_BIN);
