// providers/anthropic.mjs — the live text provider (E6 step a0): Anthropic Messages through the official SDK
// (@anthropic-ai/sdk, pinned in package.json, licence in ASSETS.md). Same create(params, { signal, ctx }) shape as the
// mock (providers/mock.mjs), so the runtime and the spend guard treat both alike.
//   - Built only when STATION_PROVIDER=live is in this process's environment, never in demo mode, and only with
//     ANTHROPIC_API_KEY set. The key is read once here and kept in this closure: it is never logged, returned, put on
//     an error or written anywhere. Every message that leaves this module goes through redact().
//   - Only the models config/engine.json gives to an anthropic tier (and prices) may run; anything else is refused
//     before any network call. The e-stop and the abort signal are checked before the call.
//   - One HTTP attempt per create(): the SDK's own retries are off (maxRetries 0). Retries belong to the guarded call
//     (runtime.mjs guardedTextCall), which reserves again for every attempt. Errors come back as LiveProviderError with
//     status, type, requestId and `retryable` (429, 5xx, network); 400/401/403 are final. W2: a connection-level failure (no HTTP
//     response: reset, timeout, DNS) is code NETWORK or TIMEOUT and retryable, whether the SDK or the socket raised it
//     (providers/connection.mjs).
//   - Nothing is added to the request: no tools, no prompt caching, no system prompt. The caller's own tools pass through
//     (client tools only: a server or MCP tool is refused on create()), and the agent's effort maps to
//     output_config.effort. E6 c0 (owner D2): an agent whose config says thinking "off" (ctx.thinking) gets the model's
//     own off setting from config/engine.json thinking.off (Haiku 5.5 {type: disabled}, Sonnet 5.5 {type: between_tools});
//     a model with no entry refuses the call before the network (fails closed).
//   - E6 b0: createWithWebTool() is the web backend's door (providers/anthropic-web.mjs), not the agents': exactly ONE
//     server tool, of a type config/engine.json live.web.tools names, with max_uses set, and nothing else in `tools`.
//     The usage it returns carries server_tool_use (web_search_requests / web_fetch_requests) for the settle.
import Anthropic from '@anthropic-ai/sdk';
import { liveInstanceProblem } from '../instance.mjs';
import { connectionFailure, timedOut } from './connection.mjs';

export const BASE_URL = 'https://api.anthropic.com';
// server-side tool types allowed through create() (the agents' door): none. The web tools go through createWithWebTool.
export const SERVER_TOOLS_ALLOWED = [];

export class LiveProviderError extends Error {
  constructor(message, { code, status = undefined, type = null, requestId = null, retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'LiveProviderError';
    Object.assign(this, { code, status, type, requestId, retryable, retryAfterMs });
  }
}

// the models the live provider may call: every anthropic tier in config/engine.json that also has a price
export function allowedModels(engineCfg) {
  const priced = (engineCfg.pricing && engineCfg.pricing.anthropic && engineCfg.pricing.anthropic.models) || {};
  return [...new Set(Object.values(engineCfg.tiers || {}).filter((t) => t.provider === 'anthropic' && priced[t.model]).map((t) => t.model))];
}

// strip the key (and anything shaped like a key or an auth header) from a string
export function makeRedactor(secrets = []) {
  const keys = secrets.filter((s) => typeof s === 'string' && s.length > 8);
  return (s) => {
    let t = String(s ?? '');
    for (const k of keys) t = t.split(k).join('<redacted>');
    return t.replace(/sk-ant-[A-Za-z0-9_-]+/g, '<redacted>').replace(/\b(x-api-key|authorization)(["']?\s*[:=]\s*["']?)(Bearer\s+)?[^\s"',}]+/gi, '$1$2<redacted>');
  };
}

const HINT = {
  400: 'the request was refused as invalid; check the model, max_tokens and the message shape',
  401: 'authentication failed; check that ANTHROPIC_API_KEY holds a valid key for the station workspace',
  403: 'permission denied; check the key\'s workspace and the model\'s availability'
};

// SDK error -> LiveProviderError (key-free). Retryable: 429, 5xx, network and timeouts; 408/409 are left to the caller
// as final in a0 (the SDK would retry them; the station keeps the list to the brief's).
export function normaliseError(e, redact) {
  if (e instanceof LiveProviderError) return e;
  if (e instanceof Anthropic.APIConnectionError) {
    const timeout = e instanceof Anthropic.APIConnectionTimeoutError;
    return new LiveProviderError('Anthropic API ' + (timeout ? 'request timed out' : 'connection failed') + ': ' + redact(e.message), { code: timeout ? 'TIMEOUT' : 'NETWORK', retryable: true });
  }
  if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
    const s = e.status, retryable = s === 429 || s >= 500;
    const raw = e.headers && typeof e.headers.get === 'function' ? e.headers.get('retry-after') : null;
    const ra = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
    const type = e.type || null, requestId = e.requestID || null;
    const msg = 'Anthropic API ' + s + (type ? ' ' + type : '') + ': ' + (HINT[s] || redact(e.message)) + (requestId ? ' (request ' + requestId + ')' : '');
    return new LiveProviderError(msg, { code: 'HTTP_' + s, status: s, type, requestId, retryable, retryAfterMs: Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null });
  }
  // W2: a socket or DNS failure raised outside the SDK's connection class (e.g. the body cut off mid-read) is connection-level too
  if (connectionFailure(e)) {
    const timeout = timedOut(e);
    return new LiveProviderError('Anthropic API ' + (timeout ? 'request timed out' : 'connection failed') + ': ' + redact(e && e.message ? e.message : e), { code: timeout ? 'TIMEOUT' : 'NETWORK', retryable: true });
  }
  return new LiveProviderError('Anthropic call failed: ' + redact(e && e.message ? e.message : e), { code: 'UNKNOWN' });
}

function checkTools(params) {
  if (params.mcp_servers) throw new LiveProviderError('MCP servers are not allowed on the live provider', { code: 'TOOLS' });
  for (const t of params.tools || []) {
    if (t && t.type && t.type !== 'custom' && !SERVER_TOOLS_ALLOWED.includes(t.type)) throw new LiveProviderError('server tool ' + t.type + ' is not allowed on the live provider', { code: 'TOOLS' });
  }
}

// the web backend's request: one server web tool of a configured type, max_uses a whole number >= 1, nothing else
function checkWebTool(params, webTypes) {
  if (params.mcp_servers) throw new LiveProviderError('MCP servers are not allowed on the live provider', { code: 'TOOLS' });
  const tools = params.tools || [];
  if (tools.length !== 1) throw new LiveProviderError('a web request carries exactly one server web tool (got ' + tools.length + ')', { code: 'TOOLS' });
  const t = tools[0];
  if (!t || !webTypes.includes(t.type)) throw new LiveProviderError('server tool ' + (t && t.type) + ' is not a configured web tool (allowed: ' + webTypes.join(', ') + ')', { code: 'TOOLS' });
  if (!(Number.isInteger(t.max_uses) && t.max_uses >= 1)) throw new LiveProviderError('a web tool needs max_uses (a whole number, at least 1)', { code: 'TOOLS' });
}

const usageOf = (u = {}) => {
  const s = u.server_tool_use || {};
  return { input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_creation_input_tokens: u.cache_creation_input_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0,
    server_tool_use: { web_search_requests: s.web_search_requests || 0, web_fetch_requests: s.web_fetch_requests || 0 } };
};

// createAnthropicText({ engineCfg, env, demo, halt, log, client, timeoutMs }) — `client` is injected by tests only
export function createAnthropicText({ engineCfg, env = process.env, demo = false, halt = null, log = null, client = null, timeoutMs = null } = {}) {
  if (demo) throw new LiveProviderError('the live provider never runs in demo mode', { code: 'DEMO' });
  if (env.STATION_PROVIDER !== 'live') throw new LiveProviderError('the live provider needs STATION_PROVIDER=live in this process\'s environment (it is "' + (env.STATION_PROVIDER || 'unset') + '")', { code: 'NOT_LIVE' });
  const notLive = liveInstanceProblem(env); if (notLive) throw new LiveProviderError(notLive, { code: 'NOT_LIVE_INSTANCE' });   // L1
  if (!engineCfg) throw new LiveProviderError('the live provider needs config/engine.json', { code: 'CONFIG' });
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key !== 'string' || !key.trim()) throw new LiveProviderError('ANTHROPIC_API_KEY is not set: the live provider cannot start', { code: 'NO_KEY' });
  const models = allowedModels(engineCfg);
  if (!models.length) throw new LiveProviderError('no anthropic model with a price in config/engine.json', { code: 'CONFIG' });
  const live = engineCfg.live || {};
  const timeout = timeoutMs ?? live.timeoutMs;
  if (!(timeout > 0)) throw new LiveProviderError('config/engine.json live.timeoutMs is not set', { code: 'CONFIG' });
  const efforts = engineCfg.effortLevels || [];
  const thinkingOff = (engineCfg.thinking && engineCfg.thinking.off) || {};
  const redact = makeRedactor([key]);
  // explicit apiKey, no auth token, fixed base URL: the environment cannot redirect the key or add a second credential
  const sdk = client || new Anthropic({ apiKey: key, authToken: null, baseURL: BASE_URL, maxRetries: 0, timeout, logLevel: 'off' });
  const webTypes = Object.values((live.web && live.web.tools) || {});
  let calls = 0;

  async function send(params, { signal, ctx = {} } = {}, check) {
    if (halt && halt.isHalted()) throw new LiveProviderError('e-stop is on: no call made', { code: 'HALT' });
    if (signal && signal.aborted) throw signal.reason || new LiveProviderError('aborted before the call', { code: 'ABORTED' });
    if (!models.includes(params.model)) throw new LiveProviderError('model ' + params.model + ' is not in config/engine.json (allowed: ' + models.join(', ') + ')', { code: 'MODEL' });
    if (!(params.max_tokens > 0)) throw new LiveProviderError('max_tokens must be set', { code: 'BAD_PARAMS' });
    check(params);
    const body = { ...params };
    if (ctx.effort && efforts.includes(ctx.effort) && !body.output_config) body.output_config = { effort: ctx.effort };
    if (ctx.thinking === 'off' && !body.thinking) {
      const t = thinkingOff[body.model];
      if (!t || typeof t.type !== 'string') throw new LiveProviderError('thinking "off" has no setting for ' + body.model + ' in config/engine.json thinking.off: no call made', { code: 'CONFIG' });
      body.thinking = { ...t };
    } else if (ctx.thinking != null && ctx.thinking !== 'off' && ctx.thinking !== 'default') throw new LiveProviderError('thinking must be "off" or "default" (got ' + JSON.stringify(ctx.thinking) + '): no call made', { code: 'CONFIG' });
    const t0 = Date.now();
    calls++;
    let msg;
    try { msg = await sdk.messages.create(body, { signal, timeout }); }
    catch (e) {
      if (signal && signal.aborted) throw e;   // the caller's e-stop / Stop path settles it
      const err = normaliseError(e, redact);
      log && log.warn('anthropic call failed', { model: body.model, status: err.status ?? null, code: err.code, type: err.type, requestId: err.requestId, retryable: err.retryable, ms: Date.now() - t0, agent: ctx.agentKey || null, jobId: ctx.jobId || null, ...(ctx.web ? { web: ctx.web } : {}) });
      throw err;
    }
    const requestId = msg._request_id || null;
    const usage = usageOf(msg.usage);
    log && log.info('anthropic call', { model: msg.model || body.model, requestId, messageId: msg.id, stop: msg.stop_reason, thinking: body.thinking ? body.thinking.type : 'default', usage: { in: usage.input_tokens, out: usage.output_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens, webSearches: usage.server_tool_use.web_search_requests, webFetches: usage.server_tool_use.web_fetch_requests }, ms: Date.now() - t0, agent: ctx.agentKey || null, jobId: ctx.jobId || null, ...(ctx.web ? { web: ctx.web } : {}) });
    return { id: msg.id, type: msg.type, role: msg.role, model: msg.model, content: msg.content, stop_reason: msg.stop_reason, stop_details: msg.stop_details ?? null, usage, request_id: requestId };
  }

  return {
    id: 'anthropic',
    models,
    get calls() { return calls; },
    // the agents' door: client tools only
    create: (params, opts) => send(params, opts, checkTools),
    // the web backend's door (anthropic-web.mjs): one configured server web tool, max_uses set
    createWithWebTool: (params, opts) => send(params, opts, (p) => checkWebTool(p, webTypes)),
    // free model metadata (Models API, no tokens): does `model` accept the web search tool? Fails closed (false) when the
    // field is missing. Web fetch is not covered by the Models API.
    async webSearchSupported(model) {
      if (halt && halt.isHalted()) throw new LiveProviderError('e-stop is on: no call made', { code: 'HALT' });
      if (!models.includes(model)) throw new LiveProviderError('model ' + model + ' is not in config/engine.json', { code: 'MODEL' });
      try { const m = await sdk.models.retrieve(model, undefined, { timeout }); const c = m && m.capabilities && m.capabilities.server_tools; return { model, supported: !!(c && c.web_search && c.web_search.supported === true), reported: !!(c && c.web_search) }; }
      catch (e) { throw normaliseError(e, redact); }
    }
  };
}
