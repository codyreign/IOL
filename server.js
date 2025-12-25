import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, 'cache');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MODEL = process.env.OLLAMA_MODEL || 'gpt-oss:20b';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/chat';
const PORT = process.env.PORT || 3000;

const pending = new Map();

async function ensureDirs() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(PUBLIC_DIR, { recursive: true });
}

function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function cachePaths(url) {
  const key = hashUrl(url);
  return {
    html: path.join(CACHE_DIR, `${key}.html`),
    meta: path.join(CACHE_DIR, `${key}.json`)
  };
}

async function readCache(url) {
  const { html } = cachePaths(url);
  try {
    return await fs.readFile(html, 'utf8');
  } catch {
    return null;
  }
}

async function writeCache(url, html) {
  const { html: htmlPath, meta } = cachePaths(url);
  await fs.writeFile(htmlPath, html, 'utf8');
  const metaObj = {
    url,
    model: MODEL,
    createdAt: new Date().toISOString()
  };
  await fs.writeFile(meta, JSON.stringify(metaObj, null, 2), 'utf8');
}

function stripCodeFences(text) {
  let trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    trimmed = trimmed.replace(/^```[a-zA-Z]*\s*/, '');
    trimmed = trimmed.replace(/```$/, '').trim();
  }
  return trimmed;
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ensureDocument(html, title) {
  const lower = html.toLowerCase();
  if (!lower.includes('<html')) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${html}</body></html>`;
  }
  let updated = html;
  if (!lower.includes('<head')) {
    updated = updated.replace(/<html[^>]*>/i, match => `${match}<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>`);
  }
  return updated;
}

function insertBeforeBodyClose(html, snippet) {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) {
    return html + snippet;
  }
  return html.slice(0, idx) + snippet + html.slice(idx);
}

function navigationScript(originalUrl) {
  const encoded = JSON.stringify(originalUrl);
  return `\n<script>(function(){\n  const ORIGINAL_URL = ${encoded};\n  document.addEventListener('click', function(event){\n    const link = event.target.closest('a[href]');\n    if (!link) return;\n    const href = link.getAttribute('href');\n    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {\n      return;\n    }\n    event.preventDefault();\n    let target;\n    try {\n      target = new URL(href, ORIGINAL_URL).href;\n    } catch (err) {\n      return;\n    }\n    window.location.href = '/navigate?url=' + encodeURIComponent(target);\n  }, true);\n\n  document.addEventListener('submit', function(event){\n    const form = event.target;\n    if (!form || form.tagName !== 'FORM') return;\n    event.preventDefault();\n    const action = form.getAttribute('action') || ORIGINAL_URL;\n    const method = (form.getAttribute('method') || 'get').toLowerCase();\n    let targetUrl;\n    try {\n      targetUrl = new URL(action, ORIGINAL_URL);\n    } catch (err) {\n      return;\n    }\n    const formData = new FormData(form);\n    const params = new URLSearchParams(formData);\n    if (method !== 'get') {\n      params.set('_iol_method', method);\n    }\n    if (params.toString()) {\n      targetUrl.search = params.toString();\n    }\n    window.location.href = '/navigate?url=' + encodeURIComponent(targetUrl.href);\n  }, true);\n})();</script>\n`;
}

function injectNavigation(html, originalUrl) {
  return insertBeforeBodyClose(html, navigationScript(originalUrl));
}

function normalizeUrl(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('URL is required');
  }
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  return new URL(withScheme).href;
}

function systemPrompt() {
  return [
    'You are Internet Offline (IOL), an offline page reconstruction model.',
    'Recreate the requested website from memory only. Do not browse or fetch external resources.',
    'Think step by step about the layout and content, but do not reveal your reasoning.',
    'Output only a complete HTML document, no markdown and no code fences.',
    'Use inline CSS (or a single <style> block). Do not reference external CSS, fonts, or images.',
    'Inline JS is allowed to recreate interactive features (games, carousels, search UI) but must run entirely offline.',
    'Do not reference external JS files or make any real network requests.',
    'Use /img/blank.png as the only image asset. Always include width and height attributes.',
    'Use text in place of logos when needed. Use reasonable system-safe fonts.',
    'All links and form actions should be absolute URLs where possible, but they will be handled offline.',
    'Prefer form method GET. If a form is present, it must be safe for offline navigation.',
    'If the original page includes interactive widgets (games, maps, video players), recreate them with local JS and placeholder assets.',
    'Be as complete and information-rich as possible. Include full headers, navs, sections, sidebars, footers, and secondary content.',
    'Do not omit details; add plausible content where memory is incomplete.',
    'For search results, include a full results page with many entries, snippets, related queries, and pagination.',
    'Avoid filler like lorem ipsum or TODO. Use real-seeming text.',
    'Keep the page visually faithful and usable, but simple.'
  ].join(' ');
}

function userPrompt(url) {
  return `Recreate the page for ${url}. Aim for a faithful layout, typography, spacing, and content density. Include as much detail as possible.`;
}

async function callOllama(url) {
  const body = {
    model: MODEL,
    stream: false,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(url) }
    ]
  };

  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data.message?.content || data.response;
  if (!content) {
    throw new Error('No content returned from model');
  }
  return content;
}

async function generatePage(url) {
  const raw = await callOllama(url);
  const cleaned = stripCodeFences(raw);
  const title = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return 'IOL Page';
    }
  })();
  const doc = ensureDocument(cleaned, title);
  return injectNavigation(doc, url);
}

async function ensureGenerated(url) {
  const cached = await readCache(url);
  if (cached) {
    return cached;
  }
  if (pending.has(url)) {
    return pending.get(url);
  }
  const job = (async () => {
    const html = await generatePage(url);
    await writeCache(url, html);
    return html;
  })();
  pending.set(url, job);
  try {
    return await job;
  } finally {
    pending.delete(url);
  }
}

function renderHomePage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Internet Offline</title>
  <style>
    body { font-family: 'Georgia', 'Times New Roman', serif; background: #f6f0e8; color: #1c1c1c; margin: 0; }
    .wrap { max-width: 760px; margin: 80px auto; padding: 32px; background: #fff7ee; border: 1px solid #e0d6c8; box-shadow: 0 10px 40px rgba(0,0,0,0.08); }
    h1 { font-size: 40px; margin: 0 0 12px; }
    p { line-height: 1.5; }
    form { margin-top: 24px; display: flex; gap: 12px; }
    input { flex: 1; padding: 12px 14px; font-size: 16px; border: 1px solid #bfb2a3; border-radius: 4px; }
    button { padding: 12px 18px; background: #1c1c1c; color: #fff; border: 0; border-radius: 4px; font-size: 16px; cursor: pointer; }
    .hint { font-size: 13px; color: #6a5f54; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Internet Offline</h1>
    <p>Enter a URL and the local model will recreate the page from memory. Generated pages are cached on disk.</p>
    <form action="/navigate" method="get">
      <input name="url" placeholder="https://example.com" required>
      <button type="submit">Generate</button>
    </form>
    <div class="hint">Default model: ${MODEL}. Configure via OLLAMA_MODEL.</div>
  </div>
</body>
</html>`;
}

function renderLoadingPage(url) {
  const encoded = JSON.stringify(url);
  const displayUrl = escapeHtml(url);
  const navUrl = '/page?url=' + encodeURIComponent(url);
  const genUrl = '/generate?url=' + encodeURIComponent(url);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Generating...</title>
  <style>
    body { font-family: 'Georgia', 'Times New Roman', serif; background: radial-gradient(circle at 20% 20%, #f3e7d7, #efe5da 60%, #e5ddd2); color: #1c1c1c; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: rgba(255,255,255,0.8); border: 1px solid #d7c9b8; padding: 32px 40px; border-radius: 12px; box-shadow: 0 20px 50px rgba(0,0,0,0.15); width: min(520px, 90vw); }
    .title { font-size: 26px; margin: 0 0 12px; }
    .url { font-size: 14px; color: #6a5f54; word-break: break-all; }
    .bar { height: 6px; background: #e4d8c9; border-radius: 999px; overflow: hidden; margin: 20px 0 6px; }
    .bar span { display: block; height: 100%; width: 40%; background: #1c1c1c; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide { 0% { transform: translateX(-60%); } 50% { transform: translateX(120%); } 100% { transform: translateX(-60%); } }
    .status { font-size: 14px; color: #3a332e; }
  </style>
</head>
<body>
  <div class="card">
    <div class="title">Rebuilding the page</div>
    <div class="url">${displayUrl}</div>
    <div class="bar"><span></span></div>
    <div class="status" id="status">Warming up the model and drafting layout...</div>
  </div>
  <script>
    const target = ${encoded};
    async function run() {
      try {
        const response = await fetch('${genUrl}');
        if (!response.ok) {
          throw new Error('Generation failed');
        }
        window.location.href = '${navUrl}';
      } catch (err) {
        const status = document.getElementById('status');
        if (status) {
          status.textContent = 'Failed to generate. Check that Ollama is running.';
        }
      }
    }
    run();
  </script>
</body>
</html>`;
}

const app = express();
app.use('/img', express.static(path.join(PUBLIC_DIR, 'img')));

app.get('/', (req, res) => {
  res.type('html').send(renderHomePage());
});

app.get('/navigate', (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    res.type('html').send(renderLoadingPage(url));
  } catch (err) {
    res.status(400).send('Invalid URL');
  }
});

app.get('/generate', async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    await ensureGenerated(url);
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/page', async (req, res) => {
  try {
    const url = normalizeUrl(req.query.url || '');
    const cached = await readCache(url);
    if (!cached) {
      res.redirect(`/navigate?url=${encodeURIComponent(url)}`);
      return;
    }
    res.type('html').send(cached);
  } catch (err) {
    res.status(400).send('Invalid URL');
  }
});

ensureDirs()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`IOL server running at http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to start server', err);
    process.exit(1);
  });

