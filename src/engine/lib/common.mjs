// common.mjs — the engine's shared helpers for the modules ported from the owner's station code.
// Ported in part from Virtual-workers/station/scripts/lib/common.mjs (owner's own code; see PORTED.md for the sha256).
// Kept: readJson, sha256, sha256File, today, LISTING_ID_RE, isListingId, productsFile, BLOCKLIST_FILE, the `config` default.
// Changed: `config` is the engine's business config (office-agents/config/station.config.json, digital only: the POD
// merge and STATION_PRODUCT_TYPE are gone); products and the blocklist come from office-agents/config/.
// Dropped: loadEnv (the server loads .env), makeLogger (the engine logger), api() (no HTTP to the legacy system, ever),
// writeIfChanged (writes go through the data jail), requirePod, podConfig, POD_ARCHIVE.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ROOT } from '../store/jail.mjs';

export const CONFIG_DIR = path.join(APP_ROOT, 'config');
export const STATION = CONFIG_DIR;
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
const BASE = fs.existsSync(path.join(CONFIG_DIR, 'station.config.json')) ? readJson(path.join(CONFIG_DIR, 'station.config.json')) : {};
export const config = { ...BASE, productType: 'digital' };
export const isPod = () => false;
export const productsFile = () => path.join(CONFIG_DIR, 'archive', 'etsy', 'products.json');   // R1: the Etsy product specs, archived
export const loadProductList = () => readJson(productsFile()).products;
export const BLOCKLIST_FILE = path.join(CONFIG_DIR, 'blocklist.txt');

export function today(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}
export function sha256(bufOrString) { return crypto.createHash('sha256').update(bufOrString).digest('hex'); }
export function sha256File(file) { return sha256(fs.readFileSync(file)); }
export const LISTING_ID_RE = /^\d{4}-\d{2}-\d{2}--[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function isListingId(id) { return typeof id === 'string' && id.length <= 60 && LISTING_ID_RE.test(id); }
