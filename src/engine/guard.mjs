// guard.mjs — the spend guard (ENGINE-PLAN.md §5.1). The ONE choke point every paid call passes:
//   reserve()  before the call: estimate the call's maximum cost and check it, plus what is already spent and what
//              other calls have reserved, against every cap (per run, per job, per agent per day, per line per day,
//              per station per day, images per day). Any cap that would be passed refuses the call (CapError).
//              The e-stop and an unreadable ledger refuse every call. An unknown price refuses the call.
//   settle()   after the call: write the real cost to the ledger (fsync) and drop the reservation.
//   release()  when a call never reached the provider: drop the reservation, nothing is charged.
// A reservation is also written to data/ledger/pending/ before the call. If the process dies mid-call, the next start
// charges that call at its reserved maximum (marked estimated), so a crash can never hide spend.
// Days are Europe/Dublin calendar days. Caps come from config/engine.json only (DECISIONS.md Q7).
// L3 (owner, 20/10/2026): two jobs may run at once (one per line). Every check counts every job's spend and every reservation in
// flight, whichever job made it; reserve() is synchronous (no await between the check and the reservation), so two jobs reserving at
// the same moment are checked one after the other: no double count, no overshoot. The OpenRouter key's own limit (outerLimits
// openrouterDailyUsd, USD 2 a day, set by the owner outside the engine) is mirrored for image calls: every job's OpenRouter rows of
// the day plus the reservations in flight; the day is both the UTC day and the Dublin day (the higher counts), so the engine never
// lets a call through that the key's day could refuse.
// B0 (owner, 21/10/2026): a business level. A call of a business (its job's, else its line's or agent's) also counts against that
// business's monthly budget (monthlyBudgetUsd, the Dublin month) and, when the business sets one, its day cap (dailyCapUsd, at most
// the station's); the station's caps stay the outer limit, so the lowest limit wins. The shared floor (OVERSEER) has the station's caps.
// R1 (owner, R1 prompt; RESTRUCTURE.md §1.3, §2.2): the business level becomes the product level. A call of a product (its job's, else its
// line's or agent's; HQ and station-wide calls: the station product) counts against that product's monthly budget (productMonth, the
// Dublin month) and its day cap when it sets one (productDay, at most the station's); a job's call also against its department's job cap
// for that product (config/products/<id>.json jobCapUsdByDepartment, at most the station's per-job cap), and every call of an agent with
// limits.runCapUsd against that run cap (at most perRunUsd). Budgets and caps are read from config only; the ones still proposed are
// listed as proposals in the product and agent files. An Anthropic price is used only when it cites Anthropic's official pricing page and
// says who verified it (OFFICIAL_PRICING): a model without one (Claude Opus 5.5 today) is refused before any call; nothing here adds one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dublinDay } from './time.mjs';

export class CapError extends Error {
  constructor({ cap, limit, spent, next, unit = 'usd' }) {
    const f = (n) => (unit === 'usd' ? Number(n).toFixed(2) : String(n));
    super('cap: ' + cap + ' ' + f(limit) + ' reached (spent ' + f(spent) + ', next call up to ' + f(next) + ')');
    Object.assign(this, { code: 'CAP', cap, limit, spent, next, unit });
  }
}
export class GuardRefusal extends Error { constructor(msg, code) { super(msg); this.code = code; } }

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const EPS = 1e-9;

// price entry for a provider/model; a provider may give a '*' entry (the mock). Missing = null (the caller refuses).
export function priceOf(pricing, provider, model) {
  const p = pricing && pricing[provider] && pricing[provider].models; if (!p) return null;
  return p[model] || p['*'] || null;
}
// R1 (owner, R0.3): Anthropic prices come only from the official pricing page, with who verified them and when; any other entry counts
// as no price (the call is refused)
export const OFFICIAL_PRICING = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const VERIFIED_PROVIDERS = ['anthropic', 'anthropic-web'];
export const unverifiedPrice = (provider, price) => (VERIFIED_PROVIDERS.includes(provider) && price && !(price.source === OFFICIAL_PRICING && String(price.verified || '').trim()) ? 'the price for this model does not cite ' + OFFICIAL_PRICING + ' with who verified it' : null);

// The prompt-size tier (config/engine.json `longPrompt`, owner-verified 17/10/2026): a request whose prompt (input +
// cache writes + cache reads) is over `overTokens` pays the long-prompt prices for the WHOLE request, output included.
export const promptTokens = (usage = {}) => (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
export function priceTier(price, tokens) {
  const lp = price.longPrompt;
  return lp && tokens > lp.overTokens ? { ...price, ...lp, tier: 'long-prompt' } : { ...price, tier: 'standard' };
}
// USD for a text response's usage (Anthropic usage shape), from a price entry in USD per million tokens.
// Cache writes and reads use the entry's own prices; an entry without them falls back to 1.25x and 0.1x the input price.
export function textCost(price, usage = {}) {
  const p = priceTier(price, promptTokens(usage));
  const inP = p.inPerM, outP = p.outPerM, cw = p.cacheWritePerM ?? inP * 1.25, cr = p.cacheReadPerM ?? inP * 0.1;
  return r6(((usage.input_tokens || 0) * inP + (usage.output_tokens || 0) * outP + (usage.cache_creation_input_tokens || 0) * cw + (usage.cache_read_input_tokens || 0) * cr) / 1e6);
}
// the most a text call can cost: every input token at the dearest input rate of the tier its estimated prompt falls
// in, plus the full output allowance. The runtime's estimate (~3 characters a token) is above the real count for
// text, so an estimate at or under the threshold means the real prompt is too; settle() logs any call that cost more.
export function textMax(price, inputTokens, maxOutputTokens) {
  const p = priceTier(price, inputTokens);
  const inMax = Math.max(p.inPerM, p.cacheWritePerM ?? p.inPerM * 1.25);
  return r6((inputTokens * inMax + maxOutputTokens * p.outPerM) / 1e6);
}

export function createGuard({ J, ledger, halt, caps, pricing, log, bus, clock = Date.now, outerLimits = {}, products = null }) {
  const reserved = new Map();
  const pendingDir = path.join(J.dataRoot, 'ledger', 'pending');
  const warned = new Set();

  // ---- crash recovery: charge calls that were in flight when the process died, at their reserved maximum
  function recoverPending() {
    const d = J.dataJail(pendingDir); if (!fs.existsSync(d)) return [];
    const out = [];
    for (const n of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
      const f = path.join(d, n);
      let res = null; try { res = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { log && log.error('pending reservation unreadable; left for a person to check', { file: f }); continue; }
      const row = ledger.append({ entryId: 'recovered-' + res.id, ts: clock(), jobId: res.jobId ?? null, runId: res.runId || null, agentKey: res.agentKey || null, line: res.line || null, ...(res.businessId ? { businessId: res.businessId } : {}), ...(res.productId ? { productId: res.productId, departmentId: res.departmentId } : {}), provider: res.provider, model: res.model, kind: res.kind, count: res.count || 1, usd: res.maxUsd, estimated: true, priceSource: 'reserved-maximum', note: 'call in flight when the engine stopped; charged at its reserved maximum' });
      J.remove(f); out.push(row);
      log && log.warn('in-flight call charged at its reserved maximum after a restart', { reservation: res.id, usd: res.maxUsd, jobId: res.jobId });
    }
    return out;
  }

  const agentCap = (k) => { const a = caps.perAgentDayUsd || {}; return a[k] ?? a.default ?? 0; };
  const lineCap = (l) => { const a = caps.perLineDayUsd || {}; return a[l] ?? a.default ?? 0; };
  // a line may set a lower per-job cap (owner 17/10/2026: a genre-scout run, one research job, USD 0.50)
  const jobCap = (l) => { const c = l && caps.perJobUsdByLine ? caps.perJobUsdByLine[l] : null; return c > 0 && c < caps.perJobUsd ? { cap: 'perJob[' + l + ']', limit: c } : { cap: 'perJob', limit: caps.perJobUsd }; };
  const reservedWhere = (pred, field = 'maxUsd') => [...reserved.values()].filter(pred).reduce((s, r) => s + (r[field] || 0), 0);

  // L3: the OpenRouter key's day, every job together: its rows on the UTC day and on the Dublin day of now (the higher of the two)
  const orLimit = () => (outerLimits && outerLimits.openrouterDailyUsd > 0 ? outerLimits.openrouterDailyUsd : 0);
  function openrouterDay() {
    const now = clock(), utc = new Date(now).toISOString().slice(0, 10), dub = dublinDay(now); let u = 0, d = 0;
    for (const r of ledger.rows()) {
      if (r.provider !== 'openrouter') continue;
      const ts = r.correctionOf ? (r.correctsTs || r.ts) : r.ts, v = Number(r.usd) || 0;
      if (new Date(ts).toISOString().slice(0, 10) === utc) u += v;
      if (dublinDay(ts) === dub) d += v;
    }
    return { usedUsd: r6(Math.max(u, d)), reservedUsd: r6(reservedWhere((r) => r.provider === 'openrouter')), limitUsd: orLimit() || null, utcDay: utc, dublinDay: dub };
  }

  // the caps a call is checked against, with what is spent and reserved against each
  function checks(call, day) {
    const S = ledger.spent, out = [];
    const runCap = call.runCapUsd != null ? Math.min(caps.perRunUsd, call.runCapUsd) : caps.perRunUsd;
    out.push({ cap: 'perRun', limit: runCap, used: S.run(call.runId) + reservedWhere((r) => r.runId === call.runId), required: true });
    if (call.jobId) out.push({ ...jobCap(call.line), used: S.job(call.jobId) + reservedWhere((r) => r.jobId === call.jobId), required: true });
    if (call.agentKey && agentCap(call.agentKey) > 0) out.push({ cap: 'perAgentDay[' + call.agentKey + ']', limit: agentCap(call.agentKey), used: S.agentDay(call.agentKey, day) + reservedWhere((r) => r.agentKey === call.agentKey) });
    if (call.line && lineCap(call.line) > 0) out.push({ cap: 'perLineDay[' + call.line + ']', limit: lineCap(call.line), used: S.lineDay(call.line, day) + reservedWhere((r) => r.line === call.line) });
    out.push({ cap: 'perDay', limit: caps.perDayUsd, used: S.day(day) + reservedWhere(() => true), required: true });
    if (call.provider === 'openrouter' && orLimit() > 0) { const o = openrouterDay(); out.push({ cap: 'openrouterDay', limit: orLimit(), used: o.usedUsd + o.reservedUsd }); }
    // R1: the product's month and (when it sets one) its day; the job's department cap for that product; the agent's own run cap
    const pid = call.productId, p = pid && products ? products.get(pid) : null;
    if (p) {
      const mine = (r) => r.productId === pid;
      out.push({ cap: 'productMonth[' + pid + ']', limit: p.monthlyBudgetUsd, used: S.productMonth(pid, day.slice(0, 7)) + reservedWhere(mine), required: true });
      if (p.dailyCapUsd > 0 && p.dailyCapUsd < caps.perDayUsd) out.push({ cap: 'productDay[' + pid + ']', limit: p.dailyCapUsd, used: S.productDay(pid, day) + reservedWhere(mine), required: true });
      const dc = call.jobId && call.departmentId && products.jobCap ? products.jobCap(pid, call.departmentId) : null;
      if (dc > 0 && dc < jobCap(call.line).limit) out.push({ cap: 'perJob[' + call.departmentId + '@' + pid + ']', limit: dc, used: S.job(call.jobId) + reservedWhere((r) => r.jobId === call.jobId), required: true });
    }
    const ac = call.agentKey && products && products.agentRunCap ? products.agentRunCap(call.agentKey) : null;
    if (ac > 0 && ac < runCap) out.push({ cap: 'perRun[' + call.agentKey + ']', limit: ac, used: S.run(call.runId) + reservedWhere((r) => r.runId === call.runId), required: true });
    return out;
  }

  function reserve(call) {
    const now = clock(), day = dublinDay(now);
    if (halt && halt.isHalted()) throw new GuardRefusal('e-stop is on: no paid call can start', 'HALT');
    if (!ledger.state.ok) throw new GuardRefusal('the ledger is unreadable, so spend cannot be checked: ' + ledger.state.error, 'LEDGER');
    if (!call.provider || !call.model || !call.kind) throw new GuardRefusal('a call must name its provider, model and kind', 'BAD_CALL');
    const price = priceOf(pricing, call.provider, call.model);
    if (!price) throw new GuardRefusal('no price in config/engine.json for ' + call.provider + ' ' + call.model + ': call refused', 'PRICE');
    const uv = unverifiedPrice(call.provider, price); if (uv) throw new GuardRefusal('no verified price for ' + call.provider + ' ' + call.model + ' (' + uv + '): call refused', 'PRICE');
    let maxUsd;
    if (call.kind === 'text') { if (price.inPerM == null || price.outPerM == null) throw new GuardRefusal('no token price for ' + call.model, 'PRICE'); maxUsd = textMax(price, call.inputTokens || 0, call.maxOutputTokens || 0); }
    else if (call.kind === 'image') { if (price.perImage == null) throw new GuardRefusal('no per-image price for ' + call.model, 'PRICE'); maxUsd = r6(price.perImage * (call.count || 1)); }
    else if (call.kind === 'web') { if (price.perCall == null) throw new GuardRefusal('no per-call price for ' + call.model + ' (web price to be confirmed)', 'PRICE'); maxUsd = r6(price.perCall * (call.count || 1)); }
    else throw new GuardRefusal('unknown call kind ' + call.kind, 'BAD_CALL');
    if (call.extraUsd) maxUsd = r6(maxUsd + call.extraUsd);
    if (products && !(call.productId && call.departmentId)) { const pd = products.resolve(call); call = { ...call, productId: call.productId || pd.productId, departmentId: call.departmentId || pd.departmentId }; }
    if (products && products.businessOf && !call.businessId) call = { ...call, businessId: products.businessOf(call) };
    for (const c of ['perRunUsd', 'perJobUsd', 'perDayUsd']) if (!(caps[c] > 0)) throw new GuardRefusal('cap ' + c + ' is not set in config/engine.json: every call is refused', 'CAPS');
    for (const c of checks(call, day)) {
      if (c.used + maxUsd > c.limit + EPS) {
        const err = new CapError({ cap: c.cap, limit: c.limit, spent: r6(c.used), next: maxUsd });
        log && log.warn('cap refused a call', { cap: c.cap, limit: c.limit, used: r6(c.used), next: maxUsd, jobId: call.jobId, runId: call.runId, agent: call.agentKey, model: call.model });
        bus && bus.emit('cap.hit', { jobId: call.jobId || null, agentKey: call.agentKey || null, data: { cap: c.cap, limit: c.limit, spent: r6(c.used), next: maxUsd, message: err.message } });
        throw err;
      }
    }
    if (call.kind === 'image' && caps.imagesPerDay > 0) {
      const used = ledger.spent.imagesDay(day) + reservedWhere((r) => r.kind === 'image', 'count');
      if (used + (call.count || 1) > caps.imagesPerDay) { const err = new CapError({ cap: 'imagesPerDay', limit: caps.imagesPerDay, spent: used, next: call.count || 1, unit: 'images' }); bus && bus.emit('cap.hit', { jobId: call.jobId || null, agentKey: call.agentKey || null, data: { cap: 'imagesPerDay', message: err.message } }); throw err; }
    }
    const res = { id: crypto.randomUUID(), at: now, runId: call.runId || null, jobId: call.jobId ?? null, agentKey: call.agentKey || null, line: call.line || null, ...(call.businessId ? { businessId: call.businessId } : {}), ...(call.productId ? { productId: call.productId, departmentId: call.departmentId } : {}), provider: call.provider, model: call.model, kind: call.kind, count: call.count || 1, maxUsd, price };
    J.put(path.join(pendingDir, res.id + '.json'), JSON.stringify(res), { fsync: true });
    reserved.set(res.id, res);
    return res;
  }

  function drop(res) { reserved.delete(res.id); try { J.remove(path.join(pendingDir, res.id + '.json')); } catch (e) { log && log.error('pending reservation not removed', { id: res.id, error: e.message }); } }

  // settle a reservation with the real cost: `usd` given (provider-reported / image price) or computed from `usage`
  // requestId / messageId (live calls): the provider's request id and message id, kept on the row to match the Console
  // web (live web backend, E6 b0): { searches, fetches, via } as the response reported them; `count` is then the real
  // number of server tool uses (the reservation's count was max_uses), and `tokens` the relay request's usage
  // generationId / size (live images, E6 c0): OpenRouter's generation id and the image's measured pixel size
  // reason (W2): why an estimated row is estimated; "no response (connection failed)" for a call that ended with no HTTP response
  // (charged at its reserved maximum until the owner settles it: npm run settle:failed)
  function settle(res, { usd, usage, priceSource, estimated = false, note, reason, requestId, messageId, web, generationId, size } = {}) {
    if (!reserved.has(res.id)) throw new Error('unknown or already settled reservation ' + res.id);
    const cost = usd != null ? r6(usd) : textCost(res.price, usage || {});
    const tier = usd == null && res.price.longPrompt ? priceTier(res.price, promptTokens(usage || {})).tier : null;
    const count = web ? (web.searches || 0) + (web.fetches || 0) : res.count;
    const row = ledger.append({ ts: clock(), jobId: res.jobId, runId: res.runId, agentKey: res.agentKey, line: res.line, ...(res.businessId ? { businessId: res.businessId } : {}), ...(res.productId ? { productId: res.productId, departmentId: res.departmentId } : {}), provider: res.provider, model: res.model, kind: res.kind, count, ...(web ? { searches: web.searches || 0, fetches: web.fetches || 0, via: web.via || null } : {}),
      tokens: usage ? { in: usage.input_tokens || 0, out: usage.output_tokens || 0, cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0 } : null,
      usd: cost, priceSource: priceSource || (res.provider === 'mock' ? 'mock' : 'config/engine.json'), ...(tier ? { priceTier: tier } : {}), estimated: !!estimated, reservedUsd: res.maxUsd, ...(requestId ? { requestId } : {}), ...(messageId ? { messageId } : {}), ...(generationId ? { generationId } : {}), ...(size ? { size } : {}), ...(reason ? { reason } : {}), ...(note ? { note } : {}) });
    if (cost > res.maxUsd + EPS) log && log.warn('a call cost more than its reservation', { id: res.id, model: res.model, kind: res.kind, usd: cost, reservedUsd: res.maxUsd, jobId: res.jobId });
    drop(res);
    bus && bus.emit('spend.row', { jobId: res.jobId, agentKey: res.agentKey, data: { entryId: row.entryId, usd: row.usd, kind: row.kind, model: row.model, provider: row.provider } });
    warnNear(res);
    return row;
  }
  function release(res, reason) { if (!reserved.has(res.id)) return; drop(res); log && log.info('reservation released (call not made)', { id: res.id, reason }); }

  // one warning per cap per day at 80% (the office turns the spend figure amber)
  function warnNear(res) {
    const day = dublinDay(clock());
    for (const c of checks({ ...res, runCapUsd: null }, day)) {
      if (!(c.limit > 0) || c.used < 0.8 * c.limit) continue;
      const k = c.cap + '|' + (c.cap.startsWith('perJob') ? res.jobId : c.cap.startsWith('perRun') ? res.runId : c.cap.startsWith('productMonth') ? day.slice(0, 7) : day);
      if (warned.has(k)) continue; warned.add(k);
      bus && bus.emit('cap.warn', { jobId: res.jobId, agentKey: res.agentKey, data: { cap: c.cap, limit: c.limit, spent: r6(c.used) } });
    }
  }

  function status() {
    const day = dublinDay(clock()), S = ledger.spent;
    return { day, caps, spentToday: r6(S.day(day)), reservedNow: r6(reservedWhere(() => true)), inFlight: reserved.size, imagesToday: S.imagesDay(day), ledgerOk: ledger.state.ok, ledgerError: ledger.state.error, halted: halt ? halt.isHalted() : false };
  }

  return { reserve, settle, release, recoverPending, status, openrouterDay, reservations: () => [...reserved.values()] };
}
