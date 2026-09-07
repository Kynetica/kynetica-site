// Minimal visitor counter: appends one JSON line per hit to a GitHub-hosted
// log file via the Contents API. No visitor PII beyond what the browser
// sends anyway (referrer, UA is NOT stored). Fire-and-forget from the client.
//
// Env vars required (set via `vc env add --scope kynetica`):
//   HIT_GH_TOKEN   - GitHub token with repo contents:write on Kynetica/kynetica-hits
//   HIT_GH_REPO    - "Kynetica/kynetica-hits" (dedicated tiny repo, not the site repo)
//   HIT_GH_PATH    - "hits.jsonl"

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { path = '', ref = '', utm = '' } = req.query || {};
    const token = process.env.HIT_GH_TOKEN;
    const repo = process.env.HIT_GH_REPO;
    const filePath = process.env.HIT_GH_PATH || 'hits.jsonl';

    if (!token || !repo) {
      // Not configured yet — don't error the client, just no-op.
      res.status(204).end();
      return;
    }

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      path: String(path).slice(0, 200),
      ref: String(ref).slice(0, 200),
      utm: String(utm).slice(0, 100),
    }) + '\n';

    const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'kynetica-hit-counter',
      Accept: 'application/vnd.github+json',
    };

    // Get current file (for its sha + content), then append.
    const getResp = await fetch(apiBase, { headers });
    let sha, existing = '';
    if (getResp.ok) {
      const data = await getResp.json();
      sha = data.sha;
      existing = Buffer.from(data.content, 'base64').toString('utf8');
    }
    const updated = existing + line;
    const body = {
      message: `hit ${new Date().toISOString()}`,
      content: Buffer.from(updated).toString('base64'),
      ...(sha ? { sha } : {}),
    };
    await fetch(apiBase, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    res.status(204).end();
  } catch (e) {
    // Never let counter failures break the page.
    res.status(204).end();
  }
}
