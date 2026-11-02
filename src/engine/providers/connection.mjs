// providers/connection.mjs — W2 (owner, 20/10/2026): one test for "the call ended with no HTTP response" (a reset, a timeout, DNS),
// shared by the live providers, the guarded calls and the ledger.
//   connectionFailure(e)  a raw error (the SDK's, undici's or Node's) that is connection-level: a known socket or DNS code anywhere in
//                         its cause chain, or undici's own wording ("fetch failed", "terminated", "other side closed", ...). The
//                         providers turn it into code NETWORK or TIMEOUT, retryable like a 429 or a 5xx.
//   isConnectionError(e)  a provider error that is connection-level (code NETWORK or TIMEOUT, no HTTP status): retried with the same
//                         backoff and count as a 429/5xx; after the last retry the run ends and the job is blocked (runtime.mjs),
//                         never handed back to the agent as a tool error.
//   failedCallReason(e)   the reason on the estimated ledger row of a call that failed without a usage report: NO_RESPONSE for a
//                         connection-level failure (charged at its reserved maximum until the owner settles it: npm run settle:failed),
//                         else the error code (a response came back but could not be used).
export const CONNECTION_CODES = ['NETWORK', 'TIMEOUT'];
export const NO_RESPONSE = 'no response (connection failed)';

const SOCKET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const SOCKET_WORDS = /\b(fetch failed|terminated|other side closed|socket hang up|connection (reset|refused|error|closed)|network error|getaddrinfo)\b/i;

export function connectionFailure(e) {
  for (let x = e, depth = 0; x && depth < 6; x = x.cause, depth++) {
    if (typeof x !== 'object' && typeof x !== 'function') return SOCKET_WORDS.test(String(x));
    if (x.status != null && Number.isFinite(Number(x.status))) return false;   // an HTTP response came back: not a connection failure
    if (SOCKET_CODES.has(x.code) || SOCKET_CODES.has(x.errno)) return true;
    if (SOCKET_WORDS.test(String(x.message || ''))) return true;
  }
  return false;
}
export const timedOut = (e) => { for (let x = e, d = 0; x && d < 6; x = x.cause, d++) if (/TIMEOUT/.test(String(x.code || '')) || x.name === 'TimeoutError' || x.code === 'ETIMEDOUT') return true; return false; };

export const isConnectionError = (e) => !!(e && CONNECTION_CODES.includes(e.code) && e.status == null);
export const failedCallReason = (e) => (isConnectionError(e) ? NO_RESPONSE : 'failed without a usage report (' + ((e && e.code) || 'error') + ')');
