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
footer{margin:50px 0 40px;color:var(--steel);font-size:.76rem;border-top:1px solid var(--line);padding-top:16px}

/* signed-in identity and sign out */
.who{display:flex;align-items:center;gap:12px;margin-left:20px}
.whoami{font-size:.76rem;letter-spacing:.06em;text-transform:uppercase;color:var(--steel)}
.whoami::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;
  background:var(--seros);margin-right:7px;vertical-align:middle}
button.linkish{border:0;background:none;padding:0;color:var(--steel);text-transform:uppercase;
  font-size:.72rem;letter-spacing:.08em;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
button.linkish:hover{color:var(--seros)}

/* the one line telling you what just happened */
.flashbar{background:#eef0fb;border-bottom:1px solid var(--line)}
.flash{margin:0;padding:11px 0;font-size:.82rem;color:var(--seros)}
.flash::before{content:'\\2713';margin-right:9px;font-weight:700}

/* keyboard users are users */
.skip{position:absolute;left:-9999px;top:0;background:var(--seros);color:#fff;padding:10px 16px;z-index:10}
.skip:focus{left:0}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{
  outline:2px solid var(--seros);outline-offset:2px;border-radius:2px}
input:disabled,button:disabled{opacity:.55;cursor:not-allowed}
.menu{display:none}

/* readable text, and a table that does not overflow a phone */
.prose{max-width:62ch}
.tablewrap{overflow-x:auto}
code{background:#eae3d8;padding:1px 5px;border-radius:2px;font-size:.86em}

@media(max-width:760px){
  .grid{grid-template-columns:1fr}
  header .wrap{height:auto;padding-top:10px;padding-bottom:10px;flex-wrap:wrap;gap:6px}
  nav{order:3;width:100%;display:flex;gap:14px;overflow-x:auto;padding-bottom:4px}
  nav a{margin-left:0;white-space:nowrap}
  .who{margin-left:auto}
  h1{font-size:1.55rem}
  .card{padding:14px}
  input[type=text],input[type=date]{width:100%}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

export interface PageContext {
  /** Who is signed in, if anyone. Absent renders the signed-out header. */
  member?: { id: string; name: string; role: string } | undefined;
  csrf?: string | undefined;
  /** A one-line confirmation of what just happened. */
  flash?: string | undefined;
}

const NAV: [string, string][] = [
  ['/queue', 'Queue'],
  ['/tasks', 'Tasks'],
  ['/ask', 'Ask'],
  ['/digest', 'Digest'],
  ['/members', 'Members'],
  ['/audit', 'Audit'],
  ['/demo', 'Demo'],
];

export function page(title: string, active: string, body: string, ctx: PageContext = {}): string {
  const nav = NAV.map(([href, label]) =>
    `<a href="${href}"${active === href ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('');

  const who = ctx.member
    ? `<div class="who"><span class="whoami" title="${esc(ctx.member.role)}">${esc(ctx.member.name)}</span>` +
      (ctx.csrf
        ? `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}">` +
          `<button class="linkish" type="submit">Sign out</button></form>`
        : '') +
      `</div>`
    : '';

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — Seros</title><style>${CSS}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header><div class="wrap">
  <a class="brand" href="/">Seros</a>
  <button class="menu" type="button" aria-label="Menu" onclick="void 0">&#9776;</button>
  <nav>${nav}</nav>
  ${who}
</div></header>
${ctx.flash ? `<div class="flashbar"><div class="wrap"><p class="flash">${esc(ctx.flash)}</p></div></div>` : ''}
<main class="wrap" id="main">${body}</main>
<footer class="wrap">Human confirmation is required before any write. Seros, LLC.</footer>
</body></html>`;
}
