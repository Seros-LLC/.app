/** Server-rendered pages. No client framework, no inline styles (CSP-safe). */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const CSS = `
:root{--paper:#f2ece3;--ink:#161b2e;--steel:#5d6478;--seros:#1a2ea0;--line:#d9d0c3;--card:#fbf8f3}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font:15px/1.55 ui-monospace,"SF Mono",Menlo,monospace}
header{border-bottom:1px solid var(--line);background:#fbf8f3cc;position:sticky;top:0;backdrop-filter:blur(6px)}
.wrap{max-width:1040px;margin:0 auto;padding:0 24px}
header .wrap{display:flex;align-items:center;justify-content:space-between;height:62px}
.brand{font-weight:700;letter-spacing:.02em;text-decoration:none;color:var(--ink)}
nav a{color:var(--steel);text-decoration:none;margin-left:22px;font-size:.82rem;letter-spacing:.08em;text-transform:uppercase}
nav a:hover,nav a.on{color:var(--seros)}
h1{font-family:Georgia,"Times New Roman",serif;font-size:2rem;margin:34px 0 6px;letter-spacing:-.01em}
.sub{color:var(--steel);font-size:.9rem;margin:0 0 26px}
.card{background:var(--card);border:1px solid var(--line);border-radius:3px;padding:18px 20px;margin-bottom:14px}
.card h3{margin:0 0 6px;font-size:1.02rem}
.meta{color:var(--steel);font-size:.78rem;letter-spacing:.04em}
.quote{border-left:2px solid var(--line);padding-left:12px;margin:12px 0;color:var(--steel);font-size:.86rem;white-space:pre-wrap}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:14px}
button{font:inherit;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase;padding:9px 16px;
  border:1px solid var(--seros);border-radius:2px;background:transparent;color:var(--seros);cursor:pointer}
button.primary{background:var(--seros);color:#fff}
button:active{transform:translateY(1px)}
input[type=text],input[type=date]{font:inherit;font-size:.86rem;padding:7px 9px;border:1px solid var(--line);
  background:#fff;border-radius:2px;color:var(--ink)}
label{display:block;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;color:var(--steel);margin-bottom:4px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.empty{padding:44px 20px;text-align:center;color:var(--steel);border:1px dashed var(--line);border-radius:3px}
table{width:100%;border-collapse:collapse;font-size:.84rem}
th{text-align:left;font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:var(--steel);
  border-bottom:1px solid var(--line);padding:8px 6px}
td{padding:9px 6px;border-bottom:1px solid var(--line)}
.pill{display:inline-block;font-size:.68rem;letter-spacing:.07em;text-transform:uppercase;
  border:1px solid var(--line);border-radius:20px;padding:2px 9px;color:var(--steel)}
.pill.ok{border-color:var(--seros);color:var(--seros)}
footer{margin:50px 0 40px;color:var(--steel);font-size:.76rem}
@media(max-width:720px){.grid{grid-template-columns:1fr}}
`;

export function page(title: string, active: string, body: string): string {
  const nav = (href: string, label: string) =>
    `<a href="${href}"${active === href ? ' class="on"' : ''}>${label}</a>`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Seros</title><style>${CSS}</style></head><body>
<header><div class="wrap"><a class="brand" href="/">Seros</a><nav>
${nav('/queue', 'Queue')}${nav('/tasks', 'Tasks')}${nav('/audit', 'Audit')}${nav('/demo', 'Demo')}
</nav></div></header><main class="wrap">${body}</main>
<footer class="wrap">Human confirmation is required before any write. Seros, LLC.</footer>
</body></html>`;
}
