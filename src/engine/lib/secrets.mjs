// lib/secrets.mjs — R1 (RESTRUCTURE.md §5.3; owner, R1 prompt): secrets are refused by path and by content, in code. The action
// secrets.read is forbidden and locked (src/engine/locked.mjs), so no config can allow it. The agents' file tools (tools/index.mjs)
// refuse to read or write a path that names a secret file (.env*, *.db, .venv/, key and credential files, .git/), withhold a file
// whose content matches a secret pattern, and refuse to write content that holds one. Built in, no new dependency.
//   secretPathHit(rel)      -> the pattern a path matches (any segment), or null
//   secretContentHits(text) -> the kinds of secret the text holds ([] when none); never the secret itself

// one entry per kind: a name the refusal can give without repeating the value
const PATH_RULES = [
  ['.env file', (s) => /^\.env(\..*)?$/i.test(s)],
  ['database file', (s) => /\.(db|db-wal|db-shm|db-journal|sqlite|sqlite3)$/i.test(s)],
  ['Python virtual environment', (s) => /^\.?venv$/i.test(s)],
  ['private key or certificate store', (s) => /\.(pem|key|p12|pfx|jks|keystore)$/i.test(s)],
  ['SSH key', (s) => /^id_[a-z0-9]+(\.pub)?$/i.test(s)],
  ['package registry credentials', (s) => /^\.(npmrc|pypirc|netrc)$/i.test(s)],
  ['credentials file', (s) => /^credentials/i.test(s)],
  ['provider keys file', (s) => /^provider-keys\.json$/i.test(s)],
  ['secrets folder', (s) => /^secrets$/i.test(s)],
  ['git internals', (s) => /^\.git$/i.test(s)]
];

const CONTENT_RULES = [
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenRouter or OpenAI-style API key', /\bsk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{32,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Stripe key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Render API key', /\brnd_[A-Za-z0-9]{20,}/],   // R2a.1 (owner, 26/10/2026): ReplyDesk deploys on Render
  ['private key block', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['connection string with a password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@/'"]+@[^\s'"]+/i]
];

// every segment of a relative path: a secret folder anywhere in it, or a secret file name
export function secretPathHit(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  for (let i = 0; i < parts.length; i++) for (const [kind, test] of PATH_RULES) if (test(parts[i])) return kind + ' (' + parts.slice(0, i + 1).join('/') + ')';
  return null;
}

export function secretContentHits(text) {
  const t = String(text == null ? '' : text);
  return CONTENT_RULES.filter(([, re]) => re.test(t)).map(([kind]) => kind);
}

export const SECRET_PATH_KINDS = PATH_RULES.map(([k]) => k);
export const SECRET_CONTENT_KINDS = CONTENT_RULES.map(([k]) => k);
