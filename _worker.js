const J = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const API = 'https://api.github.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WORKFLOW = `name: build
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run build
`;

async function gemini(b, env) {
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
  const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 4).map(i => ({ inlineData: { mimeType: String(i.mime || 'image/jpeg'), data: String(i.data || '') } }));
  const body = {
    systemInstruction: { parts: [{ text: b.system || '' }] },
    contents: [{ role: 'user', parts: [...imgs, { text: b.prompt || '' }] }],
    generationConfig: b.json ? { responseMimeType: 'application/json' } : {}
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY || '' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) return J(429, { limit: true, error: (data.error && data.error.message) || 'Limite grátis atingido' });
  if (!res.ok) return J(res.status, { error: (data.error && data.error.message) || 'Erro no Gemini' });
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return J(200, { text: parts.map(p => p.text || '').join('') });
}

async function github(b, env) {
  const tk = env.GITHUB_TOKEN, owner = env.GITHUB_OWNER;
  if (!tk || !owner) return J(500, { error: 'Faltam GITHUB_TOKEN ou GITHUB_OWNER no Cloudflare' });
  const app = String(b.app || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 60);
  if (!app && b.action !== 'report') return J(400, { error: 'Nome do app inválido' });
  const repo = owner + '/' + app;
  const call = (url, method = 'GET', body) => fetch(API + url, {
    method,
    headers: { Authorization: 'Bearer ' + tk, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Se7e-IA', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const g = async (path, method, body) => {
    const r = await call('/repos/' + repo + path, method, body);
    if (!r.ok) throw new Error('GitHub ' + r.status + ': ' + (await r.text()).slice(0, 200));
    return r;
  };

  if (b.action === 'report') {
    const apps = (Array.isArray(b.apps) ? b.apps : []).map(a => String(a).toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean).slice(0, 15);
    const items = await Promise.all(apps.map(async (a) => {
      const base = '/repos/' + owner + '/' + a;
      const [ri, ru] = await Promise.all([call(base), call(base + '/actions/runs?per_page=1')]);
      if (!ri.ok) return { app: a, error: ri.status === 404 ? 'repositório não encontrado' : 'erro ' + ri.status };
      const info = await ri.json();
      const run = ru.ok ? ((await ru.json()).workflow_runs || [])[0] : null;
      return { app: a, url: info.html_url, privado: info.private, atualizado: info.pushed_at, build: run ? (run.status === 'completed' ? run.conclusion : run.status) : 'sem build' };
    }));
    return J(200, { items });
  }
  if (b.action === 'push') {
    if (!b.files) return J(400, { error: 'Dados incompletos' });
    let info = await call('/repos/' + repo);
    if (info.status === 404) {
      const c = await call('/orgs/' + owner + '/repos', 'POST', { name: app, private: true });
      if (!c.ok) return J(409, { error: 'Não consegui criar o repositório "' + app + '" em ' + owner + '. Crie um repositório vazio com esse nome lá e toque em Continuar. (erro ' + c.status + ')' });
      info = await call('/repos/' + repo);
    } else if (b.first) {
      let n = 0;
      try { n = (await (await g('/commits?per_page=2')).json()).length; } catch {}
      if (n > 1) return J(409, { exists: true, error: 'Repositório já existe' });
    }
    if (!info.ok) throw new Error('GitHub ' + info.status);
    const branch = (await info.json()).default_branch || 'main';
    let ref = await call('/repos/' + repo + '/git/ref/heads/' + branch);
    if (!ref.ok) {
      await g('/contents/README.md', 'PUT', { message: 'Início', content: btoa('# ' + app + '\n') });
      for (let i = 0; i < 5 && !ref.ok; i++) { await sleep(800); ref = await call('/repos/' + repo + '/git/ref/heads/' + branch); }
      if (!ref.ok) throw new Error('Não achei a branch ' + branch);
    }
    const sha0 = (await ref.json()).object.sha;
    const base = await (await g('/git/commits/' + sha0)).json();
    const tree = Object.entries(b.files).map(([p, c]) => ({
      path: p.split('/').filter(s => s && s !== '..' && s !== '.').join('/'),
      mode: '100644', type: 'blob', content: String(c)
    }));
    tree.push({ path: '.github/workflows/build.yml', mode: '100644', type: 'blob', content: WORKFLOW });
    const t = await (await g('/git/trees', 'POST', { base_tree: base.tree.sha, tree })).json();
    const c = await (await g('/git/commits', 'POST', { message: 'Se7e-IA: ' + app, tree: t.sha, parents: [sha0] })).json();
    await g('/git/refs/heads/' + branch, 'PATCH', { sha: c.sha });
    return J(200, { sha: c.sha });
  }
  if (b.action === 'status') {
    const runs = await (await g('/actions/runs?head_sha=' + encodeURIComponent(b.sha || ''))).json();
    const run = (runs.workflow_runs || [])[0];
    if (!run || run.status !== 'completed') return J(200, { state: 'pending' });
    if (run.conclusion === 'success') return J(200, { state: 'success' });
    const jobs = await (await g('/actions/runs/' + run.id + '/jobs')).json();
    const job = (jobs.jobs || []).find(j => j.conclusion === 'failure') || (jobs.jobs || [])[0];
    let log = 'Sem log disponível';
    if (job) { try { log = (await (await g('/actions/jobs/' + job.id + '/logs')).text()).slice(-6000); } catch (e) { log = e.message; } }
    return J(200, { state: 'failure', log });
  }
  return J(400, { error: 'Ação desconhecida' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/gemini' || url.pathname === '/api/github') {
      if (request.method !== 'POST') return J(405, { error: 'Método inválido' });
      let b;
      try { b = await request.json(); } catch { return J(400, { error: 'JSON inválido' }); }
      if (!env.APP_PASSWORD || b.password !== env.APP_PASSWORD) return J(401, { error: 'Senha incorreta' });
      try { return url.pathname === '/api/gemini' ? await gemini(b, env) : await github(b, env); }
      catch (e) { return J(500, { error: e.message }); }
    }
    return env.ASSETS.fetch(request);
  }
};
