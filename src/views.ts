/** Server-rendered pages for Seros application. No client framework, no inline styles (CSP-safe). */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const CSS = `
:root{
  --seros-blue:#0009AD;
  --seros-ink:#283053;
  --seros-steel:#608ACD;
  --seros-sky:#B8DAFF;
  --seros-paper:#EDE7DE;
  --seros-grey:#E8E8E9;
  --seros-white:#FBFAF7;
  --seros-success:#2F6B4F;
  --seros-warning:#9A6B1E;
  --seros-danger:#8C2F39;

  --seros:var(--seros-blue);
  --ink:var(--seros-ink);
  --steel:var(--seros-steel);
  --sky:var(--seros-sky);
  --paper:var(--seros-paper);
  --grey:var(--seros-grey);
  --card:var(--seros-white);
  --line:rgba(40,48,83,.18);
  --serif:Georgia,"Iowan Old Style","Times New Roman",serif;
  --mono:"Courier New",Courier,ui-monospace,monospace;
  --maxw:1080px;
}

*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0; background:var(--paper); color:var(--ink);
  font-family:var(--mono); font-size:15px; line-height:1.65;
  -webkit-font-smoothing:antialiased;
  background-image:radial-gradient(1200px 600px at 70% -10%, rgba(184,218,255,.35), transparent 60%);
  background-attachment:fixed;
}

/* Header & Brand Navigation */
header.app-header{
  position:sticky; top:0; z-index:20;
  backdrop-filter:blur(14px) saturate(150%); -webkit-backdrop-filter:blur(14px) saturate(150%);
  background:rgba(237,231,222,.85); border-bottom:1px solid var(--line);
}
.wrap{max-width:var(--maxw); margin:0 auto; padding:0 24px}
header.app-header .wrap{display:flex; align-items:center; justify-content:space-between; min-height:64px; gap:16px; flex-wrap:wrap}

.brand-lockup{display:flex; align-items:center; gap:10px; text-decoration:none; color:var(--ink)}
.brand-lockup img{width:28px; height:28px; border-radius:5px; box-shadow:0 1px 3px rgba(40,48,83,.25)}
.brand-title{font-family:var(--serif); font-weight:700; font-size:1.15rem; letter-spacing:.02em; color:var(--ink)}
.app-tag{font-size:.64rem; font-family:var(--mono); letter-spacing:.12em; text-transform:uppercase; background:rgba(0,9,173,.08); color:var(--seros); padding:2px 7px; border-radius:10px; border:1px solid rgba(0,9,173,.2)}

nav.app-nav{display:flex; items:center; gap:18px; flex-wrap:wrap}
nav.app-nav a{
  color:var(--ink); opacity:.72; text-decoration:none; font-family:var(--mono);
  font-size:.8rem; letter-spacing:.08em; text-transform:uppercase; padding:6px 0; border-bottom:2px solid transparent;
  transition:all .15s ease;
}
nav.app-nav a:hover{opacity:1; color:var(--seros)}
nav.app-nav a.on{opacity:1; color:var(--seros); border-bottom-color:var(--seros); font-weight:600}
nav.app-nav a.ext-link{color:var(--steel); opacity:.9; margin-left:8px; border-bottom:none}
nav.app-nav a.ext-link:hover{color:var(--seros); text-decoration:underline; text-underline-offset:3px}

/* User Profile Badge */
.who{display:flex; align-items:center; gap:12px; background:rgba(251,250,247,.6); border:1px solid var(--line); border-radius:20px; padding:4px 12px}
.whoami{font-size:.74rem; letter-spacing:.06em; text-transform:uppercase; color:var(--ink); font-weight:600; display:flex; align-items:center; gap:6px}
.whoami::before{content:''; display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--seros)}
.role-pill{font-size:.62rem; font-family:var(--mono); letter-spacing:.08em; text-transform:uppercase; background:rgba(96,138,205,.12); color:var(--seros-ink); padding:1px 6px; border-radius:8px; border:1px solid var(--line)}
button.linkish{border:0; background:none; padding:0; color:var(--steel); text-transform:uppercase; font-family:var(--mono); font-size:.7rem; letter-spacing:.08em; cursor:pointer; text-decoration:underline; text-underline-offset:3px}
button.linkish:hover{color:var(--danger)}

/* Content Layout & Headers */
main.wrap{padding-top:32px; padding-bottom:60px}
h1{font-family:var(--serif); font-size:2.1rem; margin:28px 0 6px; letter-spacing:-.01em; color:var(--ink)}
.sub{color:var(--steel); font-size:.92rem; margin:0 0 28px; max-width:68ch; font-family:var(--mono)}

/* Flash Notice Bar */
.flashbar{background:rgba(0,9,173,.07); border-bottom:1px solid rgba(0,9,173,.2)}
.flash{margin:0; padding:12px 0; font-size:.85rem; color:var(--seros); font-family:var(--mono); font-weight:500}
.flash::before{content:'\\2713'; margin-right:8px; font-weight:700}

/* Cards & Plates */
.card{
  background:var(--card); border:1px solid var(--line); border-radius:4px;
  padding:22px 24px; margin-bottom:18px; box-shadow:0 2px 8px rgba(40,48,83,.05);
  transition:border-color .15s ease, box-shadow .15s ease;
}
.card:hover{border-color:rgba(40,48,83,.32)}
.card h3{font-family:var(--serif); margin:0 0 8px; font-size:1.15rem; color:var(--ink)}
.meta{color:var(--steel); font-size:.78rem; letter-spacing:.04em; margin-bottom:8px}
.quote{
  border-left:3px solid var(--seros); background:rgba(184,218,255,.2);
  padding:12px 16px; margin:14px 0; color:var(--ink); font-size:.88rem;
  border-radius:0 4px 4px 0; white-space:pre-wrap;
}

/* Forms & Inputs */
.row{display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-top:16px}
button{
  font-family:var(--mono); font-size:.78rem; letter-spacing:.1em; text-transform:uppercase; padding:10px 18px;
  border:1px solid var(--seros); border-radius:2px; background:transparent; color:var(--seros); cursor:pointer;
  transition:all .15s ease;
}
button.primary{background:var(--seros); color:var(--paper); border-color:var(--seros)}
button.primary:hover{background:var(--ink); border-color:var(--ink); color:#fff}
button.ghost{border-color:var(--line); color:var(--steel)}
button.ghost:hover{border-color:var(--steel); color:var(--ink)}
button.danger{border-color:var(--danger); color:var(--danger)}
button.danger:hover{background:var(--danger); color:#fff}
button:active{transform:translateY(1px)}

input[type=text],input[type=date],input[type=password],input[type=email],select,textarea{
  font-family:var(--mono); font-size:.88rem; padding:9px 12px; border:1px solid var(--line);
  background:var(--card); border-radius:2px; color:var(--ink); outline:none; transition:border-color .15s ease;
}
input:focus,select:focus,textarea:focus{border-color:var(--seros); box-shadow:0 0 0 2px rgba(0,9,173,.15)}
label{display:block; font-size:.72rem; letter-spacing:.09em; text-transform:uppercase; color:var(--steel); margin-bottom:5px; font-weight:600}

.grid{display:grid; grid-template-columns:1fr 1fr; gap:16px}
.empty{padding:48px 24px; text-align:center; color:var(--steel); border:1px dashed var(--line); border-radius:4px; background:rgba(251,250,247,.5)}

/* Tables */
.tablewrap{overflow-x:auto; margin-top:12px}
table{width:100%; border-collapse:collapse; font-size:.86rem}
th{text-align:left; font-family:var(--mono); font-size:.72rem; letter-spacing:.1em; text-transform:uppercase; color:var(--steel); border-bottom:2px solid var(--line); padding:10px 8px}
td{padding:11px 8px; border-bottom:1px solid var(--line); vertical-align:middle}
tr:hover td{background:rgba(184,218,255,.1)}

/* Status Pills */
.pill{
  display:inline-block; font-size:.68rem; letter-spacing:.08em; text-transform:uppercase;
  border:1px solid var(--line); border-radius:20px; padding:3px 10px; color:var(--steel); font-weight:600;
}
.pill.ok,.pill.created,.pill.confirmed{border-color:var(--seros); color:var(--seros); background:rgba(0,9,173,.05)}
.pill.queued,.pill.pending{border-color:var(--seros-steel); color:var(--seros-ink); background:rgba(96,138,205,.1)}
.pill.failed,.pill.rejected{border-color:var(--danger); color:var(--danger); background:rgba(140,47,57,.06)}
.pill.needs_review{border-color:var(--warning); color:var(--warning); background:rgba(154,107,30,.06)}

/* Footer */
footer.app-foot{
  margin-top:60px; padding:24px 0 40px; border-top:1px solid var(--line); color:var(--steel); font-size:.78rem;
  display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;
}
footer.app-foot a{color:var(--steel); text-decoration:none}
footer.app-foot a:hover{color:var(--seros); text-decoration:underline}

/* OAuth buttons */
.oauth-buttons{display:flex; gap:14px; margin-top:20px; flex-wrap:wrap}
.oauth-btn{
  display:inline-flex; align-items:center; gap:8px; padding:11px 22px; border-radius:3px;
  font-family:var(--mono); font-size:.8rem; letter-spacing:.08em; text-transform:uppercase;
  text-decoration:none; cursor:pointer; border:1px solid; transition:all .15s ease;
}
.google-btn{background:#fff; color:#3c4043; border-color:#dadce0}
.google-btn:hover{background:#f8f9fa; border-color:#d2d4d7; color:#202124}
.github-btn{background:#24292e; color:#fff; border-color:#24292e}
.github-btn:hover{background:#1b1f23; border-color:#1b1f23; color:#fff}

/* Keyboard accessibility */
.skip{position:absolute; left:-9999px; top:0; background:var(--seros); color:#fff; padding:10px 16px; z-index:100; text-decoration:none}
.skip:focus{left:0}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{
  outline:2px solid var(--seros); outline-offset:2px; border-radius:2px;
}
input:disabled,button:disabled{opacity:.5; cursor:not-allowed}

.prose{max-width:68ch}
code{background:#eae3d8; padding:2px 6px; border-radius:3px; font-size:.88em}

@media(max-width:760px){
  .grid{grid-template-columns:1fr}
  header.app-header .wrap{padding-top:10px; padding-bottom:10px}
  nav.app-nav{width:100%; overflow-x:auto; padding-bottom:4px}
  .who{margin-left:0; width:100%; justify-content:space-between}
  h1{font-size:1.65rem}
  .card{padding:16px}
  footer.app-foot{flex-direction:column; align-items:flex-start}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important; animation:none!important}}
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
  ['/ask', 'Ask AI'],
  ['/digest', 'Digest'],
  ['/connect', 'Slack'],
  ['/members', 'Members'],
  ['/audit', 'Audit'],
  ['/demo', 'Demo'],
];

export function page(title: string, active: string, body: string, ctx: PageContext = {}): string {
  const nav = NAV.map(([href, label]) =>
    `<a href="${href}"${active === href ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('');

  const who = ctx.member
    ? `<div class="who"><span class="whoami" title="Role: ${esc(ctx.member.role)}">${esc(ctx.member.name)} <span class="role-pill">${esc(ctx.member.role)}</span></span>` +
      (ctx.csrf
        ? `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}">` +
          `<button class="linkish" type="submit">Sign out</button></form>`
        : '') +
      `</div>`
    : `<div class="who"><a href="/login" class="linkish">Sign In</a></div>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="/assets/icon-192.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<title>${esc(title)} — Seros</title><style>${CSS}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="app-header"><div class="wrap">
  <a class="brand-lockup" href="/queue">
    <img src="/assets/icon-192.png" alt="Seros Logo">
    <span class="brand-title">SEROS</span>
    <span class="app-tag">App</span>
  </a>
  <nav class="app-nav">
    ${nav}
    <a href="https://seros.dev" target="_blank" rel="noopener" class="ext-link" title="Visit Marketing & Documentation Website">seros.dev &#8599;</a>
  </nav>
  ${who}
</div></header>
${ctx.flash ? `<div class="flashbar"><div class="wrap"><p class="flash">${esc(ctx.flash)}</p></div></div>` : ''}
<main class="wrap" id="main">${body}</main>
<footer class="wrap app-foot">
  <div>Human confirmation required before any write. &copy; 2026 <strong>Seros, LLC</strong>.</div>
  <div>
    <a href="https://seros.dev" target="_blank" rel="noopener">Website</a> &middot;
    <a href="https://seros.dev/privacy.html" target="_blank" rel="noopener">Privacy</a> &middot;
    <a href="https://seros.dev/terms.html" target="_blank" rel="noopener">Terms</a> &middot;
    <a href="https://seros.dev/security.html" target="_blank" rel="noopener">Security</a>
  </div>
</footer>
</body></html>`;
}
