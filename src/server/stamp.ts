/**
 * The "checked" stamp a docs site embeds with one script tag:
 *
 *   <script src="https://staleproof.dev/api/verified/<owner>/<repo>/stamp.js" async referrerpolicy="no-referrer"></script>
 *
 * It reads the page's source file (`[data-staleproof-stamp][data-path]`, then
 * `<meta name="staleproof:source">`, then the script's `data-path`, then its `data-map`
 * pattern such as `docs/{path}.md` filled from the URL), fetches the repository's checked
 * pages (`/api/verified/<owner>/<repo>.json`, no cookies, no referrer) and renders one
 * line: what was checked against which commit and when, or how many references on the
 * page are out of date. It sets no cookies, uses no storage and reports nothing back.
 * `window.StaleproofStamp()` renders again after client-side navigation.
 *
 * Kept as a string so it ships inside `dist/` (the Vercel function bundles only `dist/**`),
 * and kept under 4 KB.
 */

const SCRIPT = String.raw`(function(){
var R=__REPO__,S=document.currentScript,B=S&&S.src||location.href,J=new URL("/api/verified/"+R+".json",B).href,A=new URL("/#/audit?repo="+encodeURIComponent(R),B).href,D,C="sp-stamp",doc=document;
function load(){return D||(D=fetch(J,{credentials:"omit",referrerPolicy:"no-referrer"}).then(function(r){return r.ok?r.json():null}).catch(function(){return null}))}
function at(n){return S&&S.getAttribute(n)}
function q(x){return doc.querySelector(x)}
function sources(){var e=q("[data-staleproof-stamp][data-path]"),m=q('meta[name="staleproof:source"]'),map=at("data-map");if(e)return{c:[e.getAttribute("data-path")],slot:e};
if(m&&m.content)return{c:[m.content]};if(at("data-path"))return{c:[at("data-path")]};if(!map)return{c:[]};
var p=decodeURIComponent(location.pathname),b=at("data-base");if(b&&!p.indexOf(b))p=p.slice(b.length);
p=p.replace(/^\/+|\/+$/g,"").replace(/\.html?$/,"")||"index";return{c:map.split(/[\s,]+/).filter(Boolean).map(function(t){return t.replace("{path}",p)})}}
function ago(t){var s=(Date.now()-t)/1e3,u=[[31536e3,"year"],[2592e3,"month"],[86400,"day"],[3600,"hour"],[60,"minute"]];
for(var i=0;i<5;i++){var n=Math.floor(s/u[i][0]);if(n>=1)return pl(n,u[i][1])+" ago"}return"just now"}
function el(t,x,c){var e=doc.createElement(t);if(x)e.textContent=x;if(c)e.className=c;return e}
function pl(n,w){return n+" "+w+(n==1?"":"s")}
function css(){if(q("#sp-css"))return;var d="{--g:#3fb950;--y:#d29922}",s=el("style",".sp-stamp{--g:#1a7f37;--y:#9a6700;margin:.75em 0;padding:.35em .7em;border:1px solid rgba(127,127,127,.4);border-radius:6px;font-size:.85em;line-height:1.5}.sp-i{font-weight:700;color:var(--g)}.sp-drift{border-color:var(--y)}.sp-drift .sp-i{color:var(--y)}@media(prefers-color-scheme:dark){.sp-stamp"+d+"}[data-theme=dark] .sp-stamp,.dark .sp-stamp,[data-md-color-scheme=slate] .sp-stamp"+d);s.id="sp-css";doc.head.appendChild(s)}
function place(n,slot){var t=at("data-target"),x=slot||t&&q(t),r=q("article,main,[role=main]")||doc.body,h=r.querySelector("h1");if(x)x.appendChild(n);else if(h)h.after(n);else r.appendChild(n)}
function render(){return load().then(function(d){doc.querySelectorAll("."+C).forEach(function(o){o.remove()});if(!d||!d.pages)return;
var s=sources(),pg;s.c.some(function(c){return pg=d.pages.find(function(x){return x.path==c.replace(/^\.?\//,"")})});
if(!pg)return;css();var ok=pg.status=="checked",n=el("aside","",C+(ok?"":" sp-drift")),rf=pg.findings+pg.mismatches,r=pg.runs||{},f=r.fail,fr=pl(f,"example")+(f==1?" fails":" fail")+" when run",
ic=el("span",ok?"✓":"⚠","sp-i"),tm=el("time",ago(pg.checkedAt)),a=el("a","Staleproof");
function add(x){n.appendChild(typeof x=="string"?doc.createTextNode(x):x)}
n.setAttribute("aria-label","Staleproof docs check");n.setAttribute("data-state",pg.status);ic.setAttribute("aria-hidden","true");add(ic);
add(" "+(ok?(pg.examples&&d.checks.examples?d.checks.references?"Examples and references":"Examples":"References")+" checked against ":(rf?pl(rf,"reference")+" on this page "+(rf==1?"is":"are")+" out of date"+(f?" · "+fr:""):fr.replace(/(examples?)/,"$1 on this page"))+" · checked against "));
add(el("code",pg.sha.slice(0,7)));if(ok&&r.pass)add(" · "+pl(r.pass,"example")+" ran");add(" · ");
tm.setAttribute("datetime",new Date(pg.checkedAt).toISOString());add(tm);add(" · ");a.href=A;a.title="Staleproof docs audit";add(a);place(n,s.slot)})}
window.StaleproofStamp=render;render()})();`;

/** Inline `s` into the script as a JS string literal that cannot close a `<script>` element. */
function literal(s: string): string {
  return JSON.stringify(s).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** The stamp script for one repository (`owner/name`; GitHub names need no escaping). Its URLs resolve against the script's own. */
export function stampScript(repo: string): string {
  return SCRIPT.replace('__REPO__', literal(repo));
}

/** The stamp script's size budget (spec R7.1). */
export const STAMP_MAX_BYTES = 4096;
