/** Server-rendered pages for Seros application. No client framework, no inline styles (CSP-safe). */
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const CSS = `
:root{
  /* ---- Surfaces. Same navy/paper pair the marketing site uses. ---- */
  --night:#030620;
  --board:#050a31;
  --board-2:#0b155d;
  --ink:#080d4a;
  --paper:#eef0ff;
  --vellum:#e9eafa;
  --card:#ffffff;
  --ice:#e2e5ff;

  /* ---- Accent: Signal White. A value, not a hue.
     --accent reads only on the dark chrome; --accent-ink is its
     counterpart wherever the surface is light (buttons, focus rings,
     pills on paper). Choosing the wrong one makes it invisible. ---- */
  --accent:#ffffff;
  --accent-dim:#dbe6ff;
  --accent-ink:#1230b8;
  --accent-wash:rgba(18,48,184,.08);

  /* ---- Status. Unchanged in meaning, retuned to sit on the new paper. ---- */
  --ok:#2f6b4f;
  --review:#9a6b1e;
  --danger:#8c2f39;
  --success:var(--ok);
  --warning:var(--review);

  --steel:#5b6ba8;
  --muted:#5a6690;
  --line:rgba(8,13,74,.16);
  --board-line:rgba(219,230,255,.22);
  --board-white:#eef0ff;
  --seros:var(--accent-ink);

  --serif:Georgia,'Iowan Old Style','Times New Roman',serif;
  --sans:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  --maxw:1260px;

  /* One scale, so a card, a notice and a form gutter cannot disagree. */
  --gap:16px;
  --pad:22px;
  --radius:10px;
  --shadow:0 2px 8px rgba(8,13,74,.05);
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

nav.app-nav{display:flex; align-items:center; gap:18px; flex-wrap:wrap}
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
.whoami{font-size:.74rem; letter-spacing:.06em; text-transform:uppercase; color:var(--ink); font-weight:600; display:flex; align-items:center; gap:6px; text-decoration:none}
.whoami:hover{color:var(--seros)}
.whoami::before{content:''; display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--seros)}
.role-pill{font-size:.62rem; font-family:var(--mono); letter-spacing:.08em; text-transform:uppercase; background:rgba(96,138,205,.12); color:var(--ink); padding:1px 6px; border-radius:8px; border:1px solid var(--line)}
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
button,.button{
  display:inline-block; font-family:var(--mono); font-size:.78rem; letter-spacing:.1em; text-transform:uppercase;
  padding:10px 18px; border:1px solid var(--seros); border-radius:2px; background:transparent;
  color:var(--seros); cursor:pointer; transition:all .15s ease; text-decoration:none; text-align:center;
}
button.primary,.button.primary{background:var(--seros); color:var(--paper); border-color:var(--seros)}
button.primary:hover,.button.primary:hover{background:var(--ink); border-color:var(--ink); color:#fff}
button.ghost,.button.ghost{border-color:var(--line); color:var(--steel)}
button.ghost:hover,.button.ghost:hover{border-color:var(--steel); color:var(--ink)}
button.danger,.button.danger{border-color:var(--danger); color:var(--danger)}
button.danger:hover,.button.danger:hover{background:var(--danger); color:#fff}
button:active,.button:active{transform:translateY(1px)}

input[type=text],input[type=date],input[type=password],input[type=email],select,textarea{
  font-family:var(--mono); font-size:.88rem; padding:9px 12px; border:1px solid var(--line);
  background:var(--card); border-radius:2px; color:var(--ink); outline:none; max-width:100%; transition:border-color .15s ease;
}
input:focus,select:focus,textarea:focus{border-color:var(--seros); box-shadow:0 0 0 2px rgba(0,9,173,.15)}
label{display:block; font-size:.72rem; letter-spacing:.09em; text-transform:uppercase; color:var(--steel); margin-bottom:5px; font-weight:600}

.grid{display:grid; grid-template-columns:1fr 1fr; gap:16px}
/* Empty state. Never a dead end: it says what is missing and what to press. */
.empty{
  padding:44px 28px; text-align:center; color:var(--steel);
  border:1px dashed var(--line); border-radius:var(--radius); background:rgba(251,250,247,.5);
}
.empty h3{font-family:var(--serif); font-size:1.2rem; color:var(--ink); margin:0 0 8px}
.empty p{margin:0 auto 18px; max-width:52ch}
.empty .row{justify-content:center; margin-top:0}

/* The onboarding rail: where you are in connect -> pick -> review -> confirm. */
.steps{display:flex; gap:0; margin:0 0 26px; padding:0; list-style:none; flex-wrap:wrap; border:1px solid var(--line); border-radius:var(--radius); overflow:hidden; background:var(--card)}
.steps li{flex:1 1 0; min-width:150px; padding:12px 16px; border-right:1px solid var(--line); font-size:.78rem; color:var(--steel); display:flex; gap:10px; align-items:baseline}
.steps li:last-child{border-right:0}
.steps .n{font-family:var(--serif); font-weight:700; font-size:.9rem; color:var(--line)}
.steps li.done{color:var(--ink); background:rgba(47,107,79,.06)}
.steps li.done .n{color:var(--success)}
.steps li.done .n::before{content:'\\2713 '}
.steps li.now{color:var(--ink); background:rgba(0,9,173,.06); font-weight:600}
.steps .n{color:var(--steel)}
.steps li.now .n{color:var(--seros)}
.steps a{color:inherit; text-decoration:none}
.steps a:hover{text-decoration:underline; text-underline-offset:3px}

/* Channel picker rows. Used by /channels; previously had no rule at all. */
.pick{
  display:flex; align-items:center; gap:12px; padding:9px 10px; margin:0 -10px;
  border-radius:2px; cursor:pointer; font-size:.88rem; text-transform:none;
  letter-spacing:0; color:var(--ink); font-weight:400;
}
.pick:hover{background:rgba(184,218,255,.18)}
.pick input{width:15px; height:15px; accent-color:var(--seros); cursor:pointer; margin:0}
.pick + .pick{border-top:1px solid var(--line)}
.pick span{flex:0 0 auto}

/* Tables */
.tablewrap{overflow-x:auto; margin-top:12px}
table{width:100%; border-collapse:collapse; font-size:.86rem}
th{text-align:left; font-family:var(--mono); font-size:.72rem; letter-spacing:.1em; text-transform:uppercase; color:var(--steel); border-bottom:2px solid var(--line); padding:10px 8px}
td{padding:11px 8px; border-bottom:1px solid var(--line); vertical-align:middle}
tr:hover td{background:rgba(184,218,255,.1)}

/* Notices. One component, four intents. Replaces .empty used as an alert with
   inline colours, which no stylesheet could keep consistent. */
.notice{
  display:flex; gap:12px; align-items:flex-start;
  border:1px solid var(--line); border-left:3px solid var(--steel);
  background:rgba(251,250,247,.75); border-radius:0 var(--radius) var(--radius) 0;
  padding:14px 16px; margin:0 0 18px; font-size:.86rem; color:var(--ink);
}
.notice p{margin:0}
.notice p + p{margin-top:6px}
.notice strong{font-family:var(--serif); font-size:.98rem; letter-spacing:.01em}
.notice::before{font-weight:700; line-height:1.5; flex:0 0 auto}
.notice.info::before{content:'i'; color:var(--seros)}
.notice.good{border-left-color:var(--success)}
.notice.good::before{content:'\\2713'; color:var(--success)}
.notice.warn{border-left-color:var(--warning); background:rgba(154,107,30,.05)}
.notice.warn::before{content:'!'; color:var(--warning)}
.notice.bad{border-left-color:var(--danger); background:rgba(140,47,57,.05)}
.notice.bad::before{content:'\\00d7'; color:var(--danger); font-size:1.1rem; line-height:1.2}
.notice a{color:var(--seros)}

/* Status Pills */
.pill{
  display:inline-block; font-size:.68rem; letter-spacing:.08em; text-transform:uppercase;
  border:1px solid var(--line); border-radius:20px; padding:3px 10px; color:var(--steel); font-weight:600;
}
.pill.ok,.pill.created,.pill.confirmed{border-color:var(--seros); color:var(--seros); background:rgba(0,9,173,.05)}
.pill.queued,.pill.pending{border-color:var(--steel); color:var(--ink); background:rgba(96,138,205,.1)}
.pill.failed,.pill.rejected{border-color:var(--danger); color:var(--danger); background:rgba(140,47,57,.06)}
.pill.needs_review{border-color:var(--warning); color:var(--warning); background:rgba(154,107,30,.06)}

/* Footer */
footer.app-foot{
  margin-top:60px; padding:24px 0 40px; border-top:1px solid var(--line); color:var(--steel); font-size:.78rem;
  display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;
}
footer.app-foot a{color:var(--steel); text-decoration:none}
footer.app-foot a:hover{color:var(--seros); text-decoration:underline}

/* Signed-out pages: sign in, set a password. A narrow plate, centred, with no
   app navigation behind it, because none of those links work until you are in. */
body.auth{display:flex; flex-direction:column; min-height:100vh}
body.auth main.wrap{flex:1; display:flex; align-items:center; justify-content:center; padding-top:40px}
.authbox{width:100%; max-width:430px}
.authbox .brand-lockup{justify-content:center; margin-bottom:26px}
.authbox h1{font-size:1.7rem; margin:0 0 6px; text-align:center}
.authbox .sub{text-align:center; margin-bottom:22px; max-width:none}
.authbox .card{padding:24px}
.authbox label{margin-top:14px}
.authbox label:first-of-type{margin-top:0}
.authbox input[type=text],.authbox input[type=password],.authbox input[type=email]{width:100%}
.authbox .row{margin-top:20px}
.authbox .row button{width:100%; padding:12px 18px}
.authbox .oauth-btn{flex:1 1 auto; justify-content:center}
.authhelp{margin:22px auto 0; text-align:center; max-width:48ch; font-size:.75rem}
.authhelp a{color:var(--seros)}
.authbox footer.app-foot{margin-top:32px; justify-content:center; text-align:center}

/* The CAPTCHA plate, previously six inline styles on the login page. */
.captcha{margin-top:18px; padding:14px; background:rgba(237,231,222,.45); border:1px solid var(--line); border-radius:var(--radius)}
.captcha .cap-row{display:flex; gap:12px; align-items:center; flex-wrap:wrap}
.captcha svg{border:1px solid var(--line); border-radius:2px; background:var(--card); flex:0 0 auto}
.captcha input{width:110px; font-weight:700; letter-spacing:.1em; text-align:center}
.captcha label{margin:0 0 8px}

/* A labelled divider between the password form and the SSO buttons. */
.or{display:flex; align-items:center; gap:14px; margin:24px 0 16px; color:var(--steel); font-size:.68rem; letter-spacing:.14em; text-transform:uppercase}
.or::before,.or::after{content:''; flex:1; height:1px; background:var(--line)}

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
  nav.app-nav{width:100%; overflow-x:auto; padding-bottom:4px; -webkit-overflow-scrolling:touch}
  nav.app-nav a{white-space:nowrap}
  .who{margin-left:0; width:100%; justify-content:space-between}
  h1{font-size:1.65rem}
  .card{padding:16px}
  footer.app-foot{flex-direction:column; align-items:flex-start}
  .steps{flex-direction:column}
  .steps li{border-right:0; border-bottom:1px solid var(--line); min-width:0}
  .steps li:last-child{border-bottom:0}
  .oauth-buttons{flex-direction:column}
  .oauth-btn{justify-content:center}
  .row button,.row form,.row a{width:100%}
  .row a button{width:100%}
  main.wrap{padding-top:22px}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important; animation:none!important}}

/* Operating surface, in the marketing site's language: navy chrome, serif
   headings, rounded glass, Signal White as the accent. The routes keep their
   markup; only the skin changed. */
body{background:var(--paper);font-family:var(--sans);font-size:15px;line-height:1.55;color:var(--ink);background-image:radial-gradient(ellipse 70% 55% at 50% -10%,rgba(18,48,184,.07),transparent 70%)}
.wrap{max-width:var(--maxw)}
header.app-header{position:sticky;background:rgba(3,6,32,.96);color:var(--board-white);border-bottom:1px solid var(--board-line);backdrop-filter:blur(12px)}
header.app-header .wrap{min-height:72px}.brand-lockup{color:#fff;gap:9px}.brand-lockup img{border-radius:50%;box-shadow:none;border:1px solid rgba(255,255,255,.4)}.brand-title{font-family:var(--serif);font-size:1.05rem;letter-spacing:.03em;color:#fff}.app-tag{border-radius:999px;background:rgba(219,230,255,.14);border-color:var(--board-line);color:var(--accent-dim);font-family:var(--mono);font-size:.6rem;letter-spacing:.1em}
nav.app-nav{gap:19px}nav.app-nav a{color:rgba(238,240,255,.72);font-family:var(--serif);font-size:.74rem;letter-spacing:.05em;text-transform:uppercase;border-bottom-width:2px;padding:9px 0}nav.app-nav a:hover,nav.app-nav a.on{color:#fff;border-bottom-color:var(--accent)}nav.app-nav a.ext-link{color:var(--accent-dim)}.who{background:transparent;border-color:var(--board-line);border-radius:999px;color:#fff;padding:5px 11px}.whoami{color:#fff}.whoami::before{background:var(--accent)}.role-pill{background:rgba(219,230,255,.1);border-color:var(--board-line);color:var(--accent-dim)}.linkish{color:var(--accent-dim)!important}.linkish:hover{color:#fff!important}.linkish:focus-visible{outline:2px solid #fff;outline-offset:3px}
main.wrap{padding-top:46px;padding-bottom:76px}h1{font-family:var(--serif);font-weight:400;font-size:clamp(2.1rem,4vw,3.4rem);letter-spacing:-.02em;margin:8px 0 12px}h2,h3{font-family:var(--serif);font-weight:400}.sub{color:var(--muted);font-size:1.02rem;max-width:740px;margin-bottom:34px}.flashbar{background:var(--accent-ink);border:0;border-radius:var(--radius)}.flash{color:#fff;font-family:var(--mono);font-size:.72rem;letter-spacing:.04em}.flash::before{color:var(--accent-dim)}
.card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:24px;margin-bottom:16px;box-shadow:0 10px 30px rgba(8,13,74,.07);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}.card:hover{border-color:rgba(18,48,184,.35);box-shadow:0 16px 38px rgba(8,13,74,.1);transform:translateY(-2px)}.card h3{font-family:var(--serif);font-size:1.15rem;letter-spacing:-.01em}.meta,label,th{font-family:var(--mono);font-size:.64rem;letter-spacing:.11em;text-transform:uppercase;color:var(--muted)}.quote{background:var(--accent-wash);border-left:3px solid var(--accent-ink);border-radius:0 var(--radius) var(--radius) 0;font-size:.92rem}.grid{gap:16px}
button,.button{border-radius:999px;font-family:var(--serif);font-weight:700;font-size:.78rem;letter-spacing:.04em;padding:11px 20px}.button.primary,button.primary{background:var(--accent-ink);border-color:var(--accent-ink);color:#fff;box-shadow:0 10px 24px rgba(18,48,184,.28)}.button.primary:hover,button.primary:hover{background:#0e2596;border-color:#0e2596;transform:translateY(-2px);box-shadow:0 14px 30px rgba(18,48,184,.3)}button.ghost,.button.ghost{border-color:rgba(8,13,74,.3);color:var(--ink);background:transparent}button.ghost:hover,.button.ghost:hover{border-color:var(--accent-ink);color:var(--accent-ink)}button.danger,.button.danger{border-color:var(--danger);color:var(--danger)}input[type=text],input[type=date],input[type=password],input[type=email],select,textarea{border-radius:8px;font-family:var(--sans);border-color:rgba(8,13,74,.24);background:#fff;padding:11px 12px;width:100%}input:focus,select:focus,textarea:focus{border-color:var(--accent-ink);box-shadow:0 0 0 3px var(--accent-wash);outline:none}
.steps{border-radius:var(--radius);border-color:var(--line);margin-bottom:34px;background:#fff;overflow:hidden}.steps li{font-family:var(--mono);font-size:.69rem;letter-spacing:.04em;background:#fff}.steps li.done{background:var(--vellum)}.steps li.now{background:var(--night);color:#fff}.steps li.now .n{color:var(--accent)}.steps .n{font-family:var(--mono)}.empty{border-radius:var(--radius);border-style:solid;border-left:4px solid var(--accent-ink);background:#fff;padding:48px 30px;text-align:left}.empty .row{justify-content:flex-start}.empty h3{font-family:var(--serif);font-size:1.4rem}.notice{border-radius:var(--radius);background:#fff}.notice.warn{background:#fff8e7}.notice.good{background:#eef7f2}
.pick{border-radius:8px;padding:13px 12px;font-family:var(--sans)}.pick:hover{background:var(--vellum)}.pick input{accent-color:var(--accent-ink)}.tablewrap{border-top:2px solid var(--night);border-radius:var(--radius) var(--radius) 0 0;overflow:hidden}table{font-family:var(--sans)}caption.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}th{background:var(--vellum);border-bottom:1px solid rgba(8,13,74,.2)}td{padding:13px 9px}tr:hover td{background:var(--accent-wash)}.pill{border-radius:999px;font-family:var(--mono);font-size:.59rem;font-weight:800;letter-spacing:.07em}.pill.ok,.pill.created,.pill.confirmed{border-color:var(--ok);color:var(--ok);background:#eaf4ef}.pill.queued,.pill.pending{border-color:var(--accent-ink);color:var(--accent-ink);background:var(--accent-wash)}.pill.needs_review{border-color:var(--review);color:var(--review);background:#fdf5e6}.pill.failed,.pill.rejected{border-color:var(--danger);color:var(--danger);background:#fbeff0}
footer.app-foot{border-top:1px solid var(--line);font-family:var(--mono);font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.authbox{max-width:470px}.authbox .card{box-shadow:0 24px 60px rgba(3,6,32,.45)}body.auth{background:var(--night);background-image:radial-gradient(ellipse 60% 50% at 50% 0%,rgba(18,48,184,.4),transparent 70%)}body.auth .app-header{background:transparent;border-color:var(--board-line)}body.auth main.wrap{background:transparent}body.auth .authbox h1{color:#fff}body.auth .authbox .sub{color:var(--accent-dim)}body.auth .app-foot{border-color:var(--board-line);color:var(--accent-dim)}body.auth .app-foot a{color:#fff}
@media(max-width:760px){header.app-header .wrap{padding-top:12px;padding-bottom:12px}nav.app-nav{gap:14px}.card{padding:18px}.steps li.now{background:var(--night)}main.wrap{padding-top:27px}}
`;

export interface PageContext {
  /** Who is signed in, if anyone. Absent renders the signed-out header. */
  member?: { id: string; name: string; role: string } | undefined;
  csrf?: string | undefined;
  /** A one-line confirmation of what just happened. */
  flash?: string | undefined;
  /**
   * 'auth' drops the application navigation. A visitor who is not signed in
   * cannot reach /queue or /members, so offering the links is a row of dead
   * ends; the sign-in page shows the brand and the way back to the site instead.
   */
  chrome?: 'app' | 'auth' | undefined;
}

/** Intent of a notice. `bad` is a failure, `warn` a misconfiguration, `good` a success. */
export type NoticeKind = 'info' | 'good' | 'warn' | 'bad';

/**
 * One notice component for every page. Before this, a failure was an `.empty`
 * box with an inline colour, which meant each page invented its own alert and
 * none of them agreed. Text is escaped; `html` is for a caller-built fragment
 * that has already escaped its own values.
 */
export function notice(kind: NoticeKind, title: string, detail?: string, html?: string): string {
  return `<div class="notice ${kind}" role="${kind === 'bad' || kind === 'warn' ? 'alert' : 'status'}">` +
    `<div><p><strong>${esc(title)}</strong></p>` +
    (detail ? `<p>${esc(detail)}</p>` : '') +
    (html ?? '') +
    `</div></div>`;
}

/** A recovery action on an error page. `href` is a same-origin application path. */
export interface ErrorAction { href: string; label: string; primary?: boolean }

/**
 * What each refusal is called, in the words of the person who hit it rather than
 * the words of the status line. A status with no entry gets the neutral heading.
 */
const STATUS_HEADING: Record<number, string> = {
  400: 'That form could not be read',
  401: 'You are signed out',
  403: 'That action was refused',
  404: 'That item is not here',
  409: 'Someone got there first',
  429: 'Too many attempts',
  500: 'Something went wrong',
};

/**
 * The page a refused request gets. Before this, a refusal was a bare string -
 * `bad csrf token`, `too many requests` - served with the right status and no way
 * back: no header, no navigation, no statement of what to do next.
 *
 * `cause` is the one line naming what happened, `detail` says what to do about it.
 * Both are escaped, so a caller may not smuggle markup or an internal error string
 * into the page through them; callers pass their own sentence, never a provider
 * message, a token or a reason code. The status is the caller's business and is
 * unchanged by this function - it renders a body, nothing else.
 */
export function errorPage(
  status: number,
  cause: string,
  detail: string,
  opts: {
    heading?: string; title?: string; active?: string;
    actions?: ErrorAction[]; ctx?: PageContext; extra?: string;
  } = {},
): string {
  const heading = opts.heading ?? STATUS_HEADING[status] ?? 'That request did not complete';
  const actions = opts.actions?.length
    ? opts.actions
    : [{ href: '/queue', label: 'Return to the queue', primary: true }];
  const body = `<h1>${esc(heading)}</h1>
  ${notice('bad', cause, detail)}
  ${opts.extra ?? ''}
  <div class="row">${actions.map((a) =>
    `<a class="button${a.primary ? ' primary' : ''}" href="${esc(a.href)}">${esc(a.label)}</a>`).join('')}</div>`;
  return page(opts.title ?? heading, opts.active ?? '', body, opts.ctx ?? {});
}

/**
 * An empty state that names the next action instead of only reporting absence.
 * `action` is a caller-built fragment, already escaped.
 */
export function empty(title: string, detail: string, action?: string): string {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(detail)}</p>` +
    (action ? `<div class="row">${action}</div>` : '') + `</div>`;
}

/** The four steps from an empty workspace to a confirmed task, and where you are. */
export type SetupStep = 'connect' | 'channels' | 'queue' | 'tasks';
const SETUP: [SetupStep, string, string][] = [
  ['connect', '/connect', 'Connect Slack'],
  ['channels', '/channels', 'Choose channels'],
  ['queue', '/queue', 'Review drafts'],
  ['tasks', '/tasks', 'Confirmed work'],
];

/**
 * The onboarding rail. `done` is what the workspace has actually achieved, so a
 * member can see the whole path on their first visit rather than discovering it
 * one dead end at a time. Rendered only while setup is incomplete.
 */
export function setupRail(now: SetupStep, done: Set<SetupStep>): string {
  const items = SETUP.map(([key, href, label], i) => {
    const cls = key === now ? 'now' : done.has(key) ? 'done' : '';
    const inner = `<span class="n">${i + 1}</span><span>${esc(label)}</span>`;
    return `<li class="${cls}">${key === now ? inner : `<a href="${href}">${inner}</a>`}</li>`;
  }).join('');
  return `<ol class="steps" aria-label="Setup progress">${items}</ol>`;
}

const NAV: [string, string][] = [
  ['/queue', 'Queue'],
  ['/tasks', 'Tasks'],
  ['/ask', 'Ask AI'],
  ['/digest', 'Digest'],
  ['/connect', 'Slack'],
  ['/members', 'Members'],
  ['/audit', 'Audit'],
];

const BRAND = (href: string) => `<a class="brand-lockup" href="${href}">
    <img src="/assets/icon-192.png" alt="">
    <span class="brand-title">SEROS</span>
    <span class="app-tag">App</span>
  </a>`;

const FOOT = `<footer class="wrap app-foot">
  <div>Human confirmation required before any write. &copy; 2026 <strong>Seros, LLC</strong>.</div>
  <div>
    <a href="https://seros.dev/">Website</a> &middot;
    <a href="https://seros.dev/pricing">Pricing</a> &middot;
    <a href="https://seros.dev/privacy">Privacy</a> &middot;
    <a href="https://seros.dev/terms">Terms</a> &middot;
    <a href="https://seros.dev/security">Security</a>
  </div>
</footer>`;

export function page(title: string, active: string, body: string, ctx: PageContext = {}): string {
  // A signed-out page carries no application navigation. Every link in it would
  // bounce off requireSession and come back to this same page.
  const auth = ctx.chrome === 'auth';

  const nav = NAV.map(([href, label]) =>
    `<a href="${href}"${active === href ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('');

  const who = ctx.member
    ? `<div class="who"><a class="whoami" href="/password" title="Your account. Role: ${esc(ctx.member.role)}">${esc(ctx.member.name)} <span class="role-pill">${esc(ctx.member.role)}</span></a>` +
      (ctx.csrf
        ? `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}">` +
          `<button class="linkish" type="submit">Sign out</button></form>`
        : '') +
      `</div>`
    : `<div class="who"><a href="/login" class="linkish">Sign in</a></div>`;

  const header = auth
    ? `<header class="app-header"><div class="wrap">
  ${BRAND('/login')}
  <nav class="app-nav">
    <a href="https://seros.dev/" class="ext-link" title="Back to the Seros website">&#8592; seros.dev</a>
  </nav>
</div></header>`
    : `<header class="app-header"><div class="wrap">
  ${BRAND('/queue')}
  <nav class="app-nav">
    ${nav}
    <a href="https://seros.dev/" class="ext-link" title="Back to the Seros website">&#8592; seros.dev</a>
  </nav>
  ${who}
</div></header>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="/assets/icon-192.png">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<title>${esc(title)} — Seros</title><style>${CSS}</style></head><body${auth ? ' class="auth"' : ''}>
<a class="skip" href="#main">Skip to content</a>
${header}
${ctx.flash ? `<div class="flashbar"><div class="wrap"><p class="flash">${esc(ctx.flash)}</p></div></div>` : ''}
<main class="wrap" id="main">${auth ? `<div class="authbox">${body}</div>` : body}</main>
${FOOT}
</body></html>`;
}
