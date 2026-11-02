// runtime.mjs — one agent run = the model–tool loop for one agent on one job step (ENGINE-PLAN.md §2.3). The engine's
// own loop, so the spend guard and the e-stop sit in front of EVERY model call:
//   reserve (worst case, every cap) -> call with the e-stop's AbortSignal -> settle the real cost to the ledger (fsync)
//   -> run the tool calls -> repeat
// A run ends when the agent stops calling tools, hits maxTurns, a cap refuses the next call, or the e-stop fires. Each
// run records the sha256 of its exact prompt. The page never sees prompts or provider responses.
// E6 b1: every model call of a job is appended to data/jobs/<id>/transcript.jsonl (key-redacted; internal, never logs/
// or git). An output contract (the line step's `outputs`, built by the orchestrator) is checked when the agent ends its
// turn: missing outputs get a follow-up message naming the tool, with tool_choice requiring a call, at most
// MAX_NUDGES times; still missing -> status `incomplete` (or `done` with a shortfall when the contract allows partial).
// E6 b2 (owner D2): report_blocked(reason) is the "cannot produce" outcome: it satisfies the contract and ends the run at
// once (no nudge): `incomplete` with that reason when nothing was written, a recorded shortfall when a partial set exists
// and the contract allows partials (owner decision 3); a nudge offers exactly fs_write or report_blocked.
// E6 c0: the agent's thinking setting (config/agents/<key>.json thinking, owner D2) rides on every call's ctx; image_analyze is
// reserved as vision tokens (the image's own size, lib/vision.mjs), not as the length of its base64 text; the orchestrator's image
// policy (style-reference run modes, ctx.image), the QA verdict kind (the file-1 check) and the per-file image attempt count (job
// data imageAttempts, against the QA loop limit) reach the toolbox. A provider refusal raised before the network is never billed.
// R1 (RESTRUCTURE.md §2.2, §3): before anything is recorded or reserved, a not-hired agent is refused (it costs nothing until its phase),
// an archived one too (outside the mock-only archive sandbox), and the CEO runs only in its memos folder (locked rule ceo-recommends-only).
// The policy is checked before the guard reserves any spend: a run whose tools include a forbidden action for its product is refused at
// USD 0, and every tool call is checked again when it is made (the locked rules, then the level: forbidden ends the run refused, owner
// files a request in the Owner's office and ends the run, auto runs the tool).
import crypto from 'node:crypto';
import path from 'node:path';
import { buildAgentPrompt, engineWrapper, engineeringWrapper, execWrapper } from './prompts.mjs';
import { createToolbox, ToolError, PRE_NETWORK } from './tools/index.mjs';
import { CapError, GuardRefusal } from './guard.mjs';
import { makeRedactor } from './providers/anthropic.mjs';
import { urlsIn, pricesIn } from './lib/web-sources.mjs';
import { isConnectionError, failedCallReason } from './providers/connection.mjs';
import { businessDataArea } from './business.mjs';
import { productDataArea } from './building.mjs';
import { PolicyRefusal } from './policy.mjs';
import { assertActor, LockedRefusal, CEO, CEO_FOLDER } from './locked.mjs';

export const MAX_NUDGES = 2;
export const TRANSCRIPT_RESULT_CHARS = 2000;

export class RunStopped extends Error { constructor(reason, cause) { super(reason); this.code = 'STOPPED'; this.cause = cause; } }

// the effective agent: config file + the page's overlay (on/off, tier, effort) from SQLite
export function effectiveAgent(engine, key) {
  const base = engine.cfg.agents[key]; if (!base) throw new Error('no agent config for ' + key);
  const o = engine.store.agentState(key) || {};
  return { ...base, enabled: o.enabled == null ? base.enabled !== false : !!o.enabled, tier: o.tier || base.tier, effort: o.effort || base.effort };
}

export const estimateTokens = (obj) => Math.ceil(JSON.stringify(obj).length / 3);   // conservative (~3 chars per token)
// the messages with every image's base64 data left out (an image is counted as vision tokens instead: lib/vision.mjs)
export const withoutImageData = (messages) => messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.map((b) => (b && b.type === 'image' && b.source && b.source.data ? { ...b, source: { ...b.source, data: '' } } : b)) } : m));

const abortableSleep = (ms, signal) => new Promise((res, rej) => { if (signal && signal.aborted) return rej(signal.reason || new Error('aborted')); const t = setTimeout(res, ms); if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason || new Error('aborted')); }, { once: true }); });
// wait before attempt n+1: a server retry-after when given, else backoffMs x 2^n; capped at backoffMaxMs
export function backoffDelay(retry = {}, attempt = 0, retryAfterMs = null) {
  const base = retry.backoffMs ?? 2000, max = retry.backoffMaxMs ?? 30000;
  return Math.min(max, retryAfterMs != null ? retryAfterMs : base * 2 ** attempt);
}

// One priced model call through the spend guard (E6 a0; the runtime's loop, image_analyze and scripts/smoke-live.mjs):
//   reserve (every cap; the e-stop refuses) -> call with the e-stop's signal -> settle the real cost from the usage.
// A refused reservation throws before any call. On a retryable provider error (429, 5xx, network: `retryable`), it
// waits and tries again up to retry.retries times; EVERY attempt reserves again. A provider error with a status is
// released (not billed); one without a usage report is charged at the reserved maximum, marked estimated, with the reason
// "no response (connection failed)" for a connection-level failure (W2; the owner settles it: npm run settle:failed).
export async function guardedTextCall({ guard, halt, providers, call, params, ctx = {}, stopSignal = null, retry = {}, log = null, note = null, sleep = abortableSleep }) {
  const retries = Math.max(0, Math.floor(retry.retries || 0));
  for (let attempt = 0; ; attempt++) {
    const res = guard.reserve(call);
    const signal = stopSignal ? AbortSignal.any([halt.signal, stopSignal]) : halt.signal;
    let resp;
    try { resp = await providers.text.create(params, { signal, ctx: attempt ? { ...ctx, attempt } : ctx }); }
    catch (e) {
      if (halt.signal.aborted) { guard.settle(res, { usd: res.maxUsd, estimated: true, note: 'aborted by the e-stop mid-call; charged at the reserved maximum' }); throw new RunStopped('e-stop', e); }
      if (stopSignal && stopSignal.aborted) { guard.settle(res, { usd: res.maxUsd, estimated: true, note: 'stopped by the owner mid-call; charged at the reserved maximum' }); throw new RunStopped('stopped by the owner', e); }
      if (e && e.status) guard.release(res, 'provider error ' + e.status);
      else if (e && PRE_NETWORK.includes(e.code)) guard.release(res, 'refused before the network: ' + e.code);
      else guard.settle(res, { usd: res.maxUsd, estimated: true, reason: failedCallReason(e), note: 'call failed without a usage report; charged at the reserved maximum' });
      if (!(e && e.retryable) || attempt >= retries) {
        if (e && e.retryable) log && log.warn('provider call failed after the last retry', { model: call.model, status: e.status ?? null, code: e.code || null, attempts: attempt + 1, retries, runId: call.runId || null, jobId: call.jobId ?? null });
        throw e;
      }
      const waitMs = backoffDelay(retry, attempt, e.retryAfterMs);
      log && log.warn('provider call failed; retrying with a new reservation', { model: call.model, status: e.status ?? null, code: e.code || null, attempt: attempt + 1, retries, waitMs, runId: call.runId || null, jobId: call.jobId ?? null });
      try { await sleep(waitMs, signal); } catch (_) { throw new RunStopped(halt.signal.aborted ? 'e-stop' : 'stopped by the owner'); }
      continue;
    }
    const row = guard.settle(res, { usage: resp.usage, ...(resp.request_id ? { requestId: resp.request_id, messageId: resp.id } : {}), ...(note ? { note } : {}) });
    return { resp, row, attempts: attempt + 1 };
  }
}

// stopSignal (E5): the owner's Stop on this job; it aborts the call in flight like the e-stop, for this job only
// image / verdictKind / file1 / imageAttemptLimit (E6 c0, the style-reference set): the orchestrator's run mode for image_generate,
// the QA verdict kind when it is not the agent's own (the file-1 check), the file that check is about, and the per-file attempt limit
// verdictFiles (L3): a style-reference set review's file ids, which a revise's "redraw" list is checked against (tools submit_verdict)
// eng / writes (R2): the engineering line's context for the tools (the worktree, run_check, the record checks, the verdict context) and the
// step's write patterns, which replace the agent's own
// exec / validators (R3): an executive's run (execs.mjs): the COO's line_pause and the record's write action, and the records checked on write
export async function runAgent(engine, { agentKey, job = null, step = null, pass = 1, folder, folderLabel, input, loopNote = null, line = null, runCapUsd = null, hooks = {}, stopSignal = null, contract = null, image = null, verdictKind = null, file1 = null, imageAttemptLimit = null, verdictFiles = null, eng = null, writes = null, wrapperNotes = null, exec = null, validators = null }) {
  const { store, guard, providers, halt, bus, log, cfg } = engine;
  const agent = effectiveAgent(engine, agentKey);
  // R1: the agent's status (config/agents status; building.mjs): not hired yet, or archived
  if (agent.status === 'not-hired') throw Object.assign(new Error(agent.name + ' is not hired yet (' + (agent.phase || 'a later phase') + '): the engine does not run it'), { code: 'NOT_HIRED' });
  if (agent.status === 'archived' && !engine.archiveSandbox) throw Object.assign(new Error(agent.name + ' is archived' + (agent.retired ? ' (retired into ' + agent.retiredInto + ')' : ' (the Etsy archive)') + ': the engine does not run it'), { code: 'ARCHIVED' });
  if (agentKey === CEO && path.relative(engine.J.dataRoot, folder).split(path.sep).join('/') !== CEO_FOLDER) throw new LockedRefusal('ceo-recommends-only', 'the CEO runs only in ' + CEO_FOLDER + ', not ' + folder);
  if (!agent.enabled) throw new RunStopped(agent.name + ' is off duty');
  const tier = cfg.engine.tiers[agent.tier]; if (!tier) throw new Error('unknown tier ' + agent.tier);
  const provider = providers.mode === 'mock' ? 'mock' : tier.provider, model = tier.model;
  const prompt = buildAgentPrompt(agent, { promptsDir: cfg.promptsDir, budgets: cfg.station.promptBudgetChars || {} });
  const runId = 'run_' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '_' + crypto.randomBytes(3).toString('hex');
  const run = { runId, runCapUsd };
  let verdict = null, blockedReason = null;
  // failed image attempts per file name, kept on the job (a content refusal counts as a failed attempt, owner E6 c0)
  const imageAttempts = job ? {
    count: (name) => (((store.getJob(job.id) || {}).data || {}).imageAttempts || {})[name] ? store.getJob(job.id).data.imageAttempts[name].length : 0,
    add: (name, why) => { const cur = (((store.getJob(job.id) || {}).data || {}).imageAttempts) || {}; const list = [...(cur[name] || []), { at: Date.now(), why: String(why || '') }]; store.updateJob(job.id, { data: { imageAttempts: { ...cur, [name]: list } } }); return list.length; }
  } : null;
  // B0 (owner, 21/10/2026): the business the run works for (its job's, else its line's or agent's) and its data area: the file tools are
  // jailed to it (a business agent never reaches another business's dataDir; the shared floor's agents serve every business: the data root)
  const businessId = engine.businessOf ? engine.businessOf({ jobId: job ? job.id : null, line, agentKey }) : null, bRec = businessId && engine.building ? engine.building.get(businessId) : null;
  // R1: the data area is the run's product's (products/<id>/; the archived Etsy layout for etsy-shop); B0's business area without one
  const pd = engine.productOf ? engine.productOf({ jobId: job ? job.id : null, line, agentKey }) : null, prod = pd && engine.company ? engine.company.product(pd.productId) : null;
  const businessArea = prod ? productDataArea(engine.J.dataRoot, prod) : bRec ? businessDataArea(engine.J.dataRoot, bRec) : null;
  const ctx = { J: engine.J, folder, agent, job, model, businessId, businessArea, cfg: { ...cfg, blocklist: cfg.blocklist }, guard, providers, run, halt, log, bus, line, contract, image, verdictKind, file1, imageAttempts, imageAttemptLimit, verdictFiles, eng, writes, exec, validators, sleep: engine.sleep || null, onVerdict: (v) => { verdict = v; }, onBlocked: (r) => { blockedReason = r; }, callModel: null };
  const box = createToolbox(ctx);
  // R1: the policy before any reservation: each of the run's tools declares its action (policy.mjs TOOL_ACTIONS); a forbidden one refuses the run
  const pol = engine.policy || null;
  if (pol) for (const d of box.defs) { const act = pol.toolAction(d.name); if (!act || pol.level(act, pd && pd.productId) === 'forbidden') throw new PolicyRefusal('refused before any spend: ' + agent.name + '\'s tool ' + d.name + ' (' + (act || 'no declared action') + ') is forbidden' + (pd ? ' for ' + pd.productId : ''), { action: act, level: 'forbidden' }); }
  async function policyCheck(name, input) {
    // R2: a tool may name the action of this call (a code write is code.edit, a security verdict security.audit …: tools actionOf)
    const act = pol ? ((box.actionOf && box.actionOf(name, input)) || pol.toolAction(name)) : null, actor = { kind: 'agent', key: agentKey };
    if (!act || !box.defs.some((d) => d.name === name)) return;   // not this agent's tool: the toolbox refuses it ("not available")
    assertActor(act, actor);
    const lv = pol.level(act, pd && pd.productId);
    if (lv === 'forbidden') throw new PolicyRefusal(name + ' refused: ' + act + ' is forbidden by the autonomy policy', { action: act, level: lv });
    if (lv === 'owner') { const r = await engine.actions.perform({ action: act, actor, productId: pd.productId, departmentId: pd.departmentId, jobId: job ? job.id : null, summary: agent.name + ': ' + name, payload: JSON.stringify(input || {}) }); if (!r.done) throw new PolicyRefusal(name + ' needs the owner (' + act + '): request ' + r.requestId + ' is in the Owner\'s office; the run ends here', { action: act, level: lv }); }
  }
  const wrapper = exec ? execWrapper({ agent, job, tools: box.defs.map((d) => d.name), folderLabel }) : eng ? engineeringWrapper({ agent, job, step, pass, tools: box.defs.map((d) => d.name), folderLabel, notes: wrapperNotes }) : engineWrapper({ agent, job, step, pass, tools: box.defs.map((d) => d.name), folderLabel, isQa: !!agent.verdict, loopNote });
  const system = [{ type: 'text', text: prompt.soul + '\n' + prompt.text, ...(cfg.engine.runtime.promptCaching ? { cache_control: { type: 'ephemeral' } } : {}) }, { type: 'text', text: wrapper }];
  const promptSha256 = crypto.createHash('sha256').update(JSON.stringify(system)).digest('hex');
  store.insertRun({ runId, jobId: job ? job.id : null, agentKey, step, pass, model, provider, promptSha256, ...(businessId ? { businessId } : {}) });
  bus.emit('run.start', { jobId: job ? job.id : null, agentKey, data: { runId, step, pass, model, provider, effort: agent.effort, thinking: agent.thinking || 'default', ...(image && image.mode ? { imageMode: image.mode } : {}) } });
  log.info('run start', { runId, agent: agentKey, jobId: job && job.id, step, pass, model, provider, effort: agent.effort, thinking: agent.thinking || 'default', ...(image && image.mode ? { imageMode: image.mode, set: image.set, from: image.from, to: image.to } : {}), ...(verdictKind ? { verdictKind } : {}), promptSha256, promptChars: prompt.chars });
  if (hooks.onRunStart) { try { await hooks.onRunStart({ runId, agentKey, job, step, pass }); } catch (e) { log.warn('hook failed (ignored)', { hook: 'onRunStart', runId, error: e.message }); } }

  const totals = { usd: 0, tokensIn: 0, tokensOut: 0, turns: 0, tools: [] };
  // one priced model call through the guard (used by the loop and by image_analyze)
  // visionTokens (image_analyze): the image's visual tokens from its pixel size, added to the text estimate of everything else
  async function callModel({ messages, tools, maxOutputTokens, purpose = 'turn', extraCtx = {}, toolChoice = null, visionTokens = 0 }) {
    const params = { model, max_tokens: maxOutputTokens, system, messages, ...(tools && tools.length ? { tools } : {}), ...(toolChoice && tools && tools.length ? { tool_choice: toolChoice } : {}) };
    const inputTokens = estimateTokens({ system, messages: withoutImageData(messages), tools }) + (visionTokens || 0);
    const { resp, row } = await guardedTextCall({ guard, halt, providers, stopSignal, log, params,
      call: { provider, model, kind: 'text', runId, jobId: job ? job.id : null, agentKey, line, inputTokens, maxOutputTokens, runCapUsd },
      ctx: { agentKey, jobId: job && job.id, job, step, pass, purpose, turn: totals.turns, effort: agent.effort, thinking: agent.thinking || 'default', ...extraCtx },
      retry: providers.mode === 'live' ? cfg.engine.live || {} : {}, ...(engine.sleep ? { sleep: engine.sleep } : {}) });
    totals.usd += row.usd; totals.tokensIn += resp.usage.input_tokens || 0; totals.tokensOut += resp.usage.output_tokens || 0;
    if (purpose === 'image_analyze') return resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return resp;
  }
  ctx.callModel = callModel;

  // the job's transcript (E6 b1): one JSON line per model call, every line through the key redaction, inside data/ only
  const redactKey = makeRedactor([]), redact = (t) => redactKey(log && log.redact ? log.redact(t) : t);
  const transcriptFile = job ? path.join(engine.J.dataRoot, 'jobs', job.id, 'transcript.jsonl') : null;
  const addLine = (rec) => { if (!transcriptFile) return; try { engine.J.add(transcriptFile, redact(JSON.stringify(rec)) + '\n'); } catch (e) { log.warn('transcript write failed (ignored)', { runId, error: e.message }); } };
  // E6 c (owner, 17/10/2026): the price figures each web call returned are kept in full too (returnedPrices, lib/web-sources.mjs),
// and per web_search call with its query (searchPrices: what each search showed, so a brief cannot hide a cheaper result).
// E6 b2 (owner D1): the URLs each web call returned are kept IN FULL (returnedUrls; searchUrls = the web_search part), so a
  // fetch or a citation can be checked against what the web really gave this job, whatever the excerpt length
  const transcript = (resp, uses, results, extra = {}, web = null) => addLine({ at: new Date().toISOString(), runId, agent: agentKey, step, pass, turn: totals.turns, requestId: resp.request_id || null, stop_reason: resp.stop_reason || null,
    text: resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), toolCalls: uses.map((u) => ({ name: u.name, input: u.input })),
    toolResults: results.map((r) => ({ tool_use_id: r.tool_use_id, is_error: !!r.is_error, content: String(r.content).slice(0, TRANSCRIPT_RESULT_CHARS) })),
    ...(web && web.all.size ? { returnedUrls: [...web.all], searchUrls: [...web.search] } : {}), ...(web && web.prices.size ? { returnedPrices: [...web.prices] } : {}), ...(web && web.searches.length ? { searchPrices: web.searches } : {}), ...extra });

  const messages = [{ role: 'user', content: String(input) }];
  let status = 'done', endReason = 'end_turn', error = null, lastText = '', nudges = 0, toolChoice = null, shortfall = null, missing = null, nudgeOnly = null;
  try {
    for (;;) {
      if (halt.isHalted()) throw new RunStopped('e-stop');
      if (stopSignal && stopSignal.aborted) throw new RunStopped('stopped by the owner');
      if (totals.turns >= agent.limits.maxTurns) { status = 'max-turns'; endReason = 'maxTurns ' + agent.limits.maxTurns + ' reached'; break; }
      totals.turns++;
      const after = toolChoice ? { afterNudge: nudges } : {};
      const resp = await callModel({ messages, tools: box.defs, maxOutputTokens: agent.limits.maxOutputTokens, toolChoice });
      const only = toolChoice ? nudgeOnly : null;   // the reply to a nudge may call only the two tools the nudge offered
      toolChoice = null; nudgeOnly = null;
      messages.push({ role: 'assistant', content: resp.content });
      lastText = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || lastText;
      const uses = resp.content.filter((b) => b.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || !uses.length) {
        endReason = resp.stop_reason || 'end_turn';
        transcript(resp, [], [], after);
        // the output contract: an agent that ends its turn with neither its required outputs nor report_blocked is nudged, at
        // most MAX_NUDGES times; each nudge is one more model call, reserved and capped like any other. The nudge offers
        // exactly two ways out (owner D2): write the outputs, or report_blocked with the reason they cannot be produced.
        const c = contract ? contract.check() : null;
        if (c && c.missing.length && nudges < MAX_NUDGES && !['max_tokens', 'refusal'].includes(endReason)) {
          nudges++;
          const msg = '[STATION: required outputs missing, reminder ' + nudges + ' of ' + MAX_NUDGES + '] You ended your turn without: ' + c.missing.join('; ') + '. Do exactly one of two things now: call ' + contract.tool + ' (one call per missing file) if you can produce them with evidence, or call report_blocked with the reason you cannot. Never write an output without its evidence.' + (contract.hint ? ' ' + contract.hint : '');
          messages.push({ role: 'user', content: msg });
          // tool_choice (claude-api skill, read 17/10/2026): `any` = the model must call at least one of the request's tools;
          // there is no "one of these two" choice, so the engine refuses any other tool in the reply (nudgeOnly). Claude
          // Haiku 5.5 accepts a forced choice; Claude Sonnet 5.5 returns a 400 for `any` and `tool`, so its tier sets
          // forcedToolChoice false and the message alone carries the instruction (auto).
          toolChoice = tier.forcedToolChoice === false ? { type: 'auto' } : { type: 'any' };
          nudgeOnly = new Set([contract.tool, 'report_blocked']);
          log.warn('required outputs missing: nudge', { runId, agent: agentKey, jobId: job && job.id, nudge: nudges, missing: c.missing, toolChoice: toolChoice.type, offered: [...nudgeOnly] });
          addLine({ at: new Date().toISOString(), runId, agent: agentKey, step, pass, nudge: nudges, message: msg, tool_choice: toolChoice, offered: [...nudgeOnly] });
          continue;
        }
        if (c && c.missing.length) {
          if (contract.partialOk && c.have >= 1) { shortfall = { have: c.have, want: c.want, missing: c.missing }; endReason = 'shortfall: ' + c.have + ' of ' + c.want + ' (' + c.missing.join('; ') + ')'; }
          else { status = 'incomplete'; missing = c.missing; endReason = 'missing outputs: ' + c.missing.join('; '); }
        }
        break;
      }
      const results = [], web = { all: new Set(), search: new Set(), prices: new Set(), searches: [] };
      for (const u of uses) {
        totals.tools.push(u.name);
        let out, isError = false;
        try {
          if (only && !only.has(u.name)) throw new ToolError(u.name + ' refused: answer the reminder with ' + [...only].join(' or ') + ' only');
          await policyCheck(u.name, u.input);
          out = await box.call(u.name, u.input);
          if (u.name === 'web_search' || u.name === 'web_fetch') { for (const x of urlsIn(out)) { web.all.add(x); if (u.name === 'web_search') web.search.add(x); } const ps = pricesIn(out); for (const p of ps) web.prices.add(p); if (u.name === 'web_search') web.searches.push({ query: String((u.input && u.input.query) || ''), prices: ps }); }
        }
        catch (e) {
          if (e instanceof CapError || e instanceof GuardRefusal || e instanceof RunStopped || e instanceof PolicyRefusal || e instanceof LockedRefusal) { transcript(resp, uses, results, { ...after, error: e.message }); throw e; }
          if (halt.signal.aborted) throw new RunStopped('e-stop', e);
          if (stopSignal && stopSignal.aborted) throw new RunStopped('stopped by the owner', e);
          // W2: a tool's provider call that failed with no HTTP response after its last retry ends the run (the job is blocked); it is
          // never handed back to the agent, whose next call would go into the same dead connection
          if (isConnectionError(e)) { log.warn('connection failed after the last retry: the run ends', { runId, agent: agentKey, tool: u.name, code: e.code }); transcript(resp, uses, results, { ...after, error: e.message }); throw e; }
          isError = true; out = (e instanceof ToolError ? '' : 'tool failed: ') + e.message;
          log.warn('tool error', { runId, agent: agentKey, tool: u.name, error: e.message });
        }
        log.info('tool', { runId, agent: agentKey, tool: u.name, error: isError || undefined });
        results.push({ type: 'tool_result', tool_use_id: u.id, content: String(out).slice(0, 20000), ...(isError ? { is_error: true } : {}) });
      }
      transcript(resp, uses, results, after, web);
      messages.push({ role: 'user', content: results });
      // report_blocked (owner D2): the agent says it cannot produce its outputs; that satisfies the contract and ends the
      // run (no nudge, no further call): status incomplete with the agent's reason, so the job ends incomplete
      // Owner decision 3 (17/10/2026, after b2a): with a partial-allowed contract and at least 1 output already written
      // (drafts are schema-checked on write, so each one is valid), report_blocked records the shortfall and its reason
      // and the line continues with what exists; only report_blocked with 0 outputs (or a contract without partials)
      // ends the run incomplete
      if (blockedReason) {
        const c = contract ? contract.check() : null;
        if (c && contract.partialOk && c.have >= 1) { shortfall = { have: c.have, want: c.want, missing: c.missing, reason: blockedReason }; endReason = 'shortfall: ' + c.have + ' of ' + c.want + ', reported blocked: ' + blockedReason; }
        else { status = 'incomplete'; endReason = 'reported blocked: ' + blockedReason; }
        log.warn('agent reported blocked', { runId, agent: agentKey, jobId: job && job.id, reason: blockedReason, have: c ? c.have : null, continues: status !== 'incomplete' });
        break;
      }
    }
  } catch (e) {
    if (e instanceof CapError) { status = 'cap'; endReason = e.message; }
    else if (e instanceof GuardRefusal) { status = e.code === 'HALT' ? 'stopped' : 'refused'; endReason = e.message; }
    else if (e instanceof RunStopped) { status = 'stopped'; endReason = e.message; }
    else if (e instanceof PolicyRefusal || e instanceof LockedRefusal) { status = 'refused'; endReason = e.message; log.warn('run refused by the policy', { runId, agent: agentKey, error: e.message }); }
    else { status = 'failed'; endReason = 'error'; error = String(e && e.message || e); log.error('run failed', { runId, agent: agentKey, error: String(e && e.stack || e) }); }
  }
  store.finishRun(runId, { status, usd: totals.usd, tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, turns: totals.turns, endReason, error, tools: totals.tools });
  bus.emit('run.end', { jobId: job ? job.id : null, agentKey, data: { runId, status, endReason, usd: Math.round(totals.usd * 1e6) / 1e6, turns: totals.turns, tools: totals.tools.length } });
  log.info('run end', { runId, agent: agentKey, status, endReason, usd: totals.usd, turns: totals.turns, nudges, images: box.counters.images, web: box.counters.web });
  return { runId, status, endReason, error, verdict, text: lastText, ...totals, nudges, shortfall, missing, reportedBlocked: blockedReason, counters: box.counters, promptSha256 };
}
