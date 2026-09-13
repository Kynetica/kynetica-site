// Engine v2 for the Office Leak Finder result (free) and the Full Breakdown ($7).
// Third control (operator, 2026-09-11): one fix library, one set of named tools, one validator, three depths.
// Contract: kynetica-marketing/engine/result.schema.json (v0.2 fields: fix_this_week.tools[], breakdown.steps[].tools[],
// breakdown.monthly_total_usd). Validator mirrors kynetica-marketing/engine/validator.py depth=free|breakdown;
// tools/test_engine_v2.py proves parity on the shared fixtures. Library + tools are generated (api/_fix_library.js,
// api/_tools_catalog.js) by tools/gen_engine_assets.py.
import { FIX_LIBRARY } from './_fix_library.js';
import { TOOLS } from './_tools_catalog.js';
import { QUESTIONS } from './_questions.js';

export const ENGINE_VERSION = 'v2.1';
const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.tool_id, t]));
const VERIFIED = new Set(TOOLS.filter((t) => t.verified && String(t.vendor_pricing_url || '').startsWith('http') && t.price_checked_on).map((t) => t.tool_id));
const LOGIN_WORDS = [/\b(?:log-?in|login|username|password|passwords|credentials|sign-?in details)\b/i, /\byour [a-z ]{0,20}(?:account )?(?:login|password)\b/i, /\bshare (?:your|the) (?:login|password|credentials)\b/i];
const MAX_SENTENCE_WORDS = 32;
const ALIASES = { jobber: 'T-JOBBER', 'housecall pro': 'T-HCP', housecall: 'T-HCP', servicetitan: 'T-ST', 'service titan': 'T-ST', 'quickbooks online': 'T-QBO', quickbooks: 'T-QBO', qbo: 'T-QBO', 'square invoices': 'T-SQI', square: 'T-SQI', quo: 'T-QUO', openphone: 'T-QUO', podium: 'T-PODIUM', nicejob: 'T-NICEJOB', companycam: 'T-CCAM', 'quickbooks time': 'T-QBT', 'google workspace': 'T-GWS', 'google forms': 'T-GWS', 'google sheets': 'T-GWS', 'google calendar': 'T-GWS', stripe: 'T-STRIPE', 'kynetica pdf prefill': 'T-PDFFILL', 'pdf prefill': 'T-PDFFILL' };
const PAPER = /\b(?:paper|whiteboard|re-?typ|retyp|at night|by hand|binder|carbon|notebook|clipboard)/i;

// ---------- retrieval ----------
const STOP = new Set('the a an and or of to in on at for with your you it is are be this that from into by as we i my our their his her its up out then than every each one all any some me him them'.split(' '));
function nouns(s) { return new Set((String(s || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((w) => !STOP.has(w))); }
function inter(a, b) { const o = new Set(); for (const x of a) if (b.has(x)) o.add(x); return o; }
export function paperOffice(task, answers, team) {
  const sig = (String(task || '').match(new RegExp(PAPER.source, 'gi')) || []).length + (answers?.[3] === 0 ? 1 : 0) + (answers?.[6] === 0 ? 1 : 0);
  return sig >= 3 && team && team !== '1-2';
}
export function retrieveRows(task, trade, answers, k = 6, team = '') {
  const t = String(task || '').toLowerCase();
  const scored = FIX_LIBRARY.map((r) => {
    let s = 0;
    for (const w of r.signal_words) if (t.includes(w.toLowerCase())) s += 3;
    const pn = nouns(r.leak_pattern); for (const w of nouns(t)) if (pn.has(w)) s += 1;
    if (r.trade === trade) s += 1.5; else if (r.trade !== 'all') s -= 1;
    if (Array.isArray(answers)) {
      if (answers[3] === 0 && r.automation_category === 'record_once_sync') s += 1;
      if (answers[5] === 0 && r.stage === 'invoice_to_money') s += 0.5;
      if (answers[7] === 0 && r.automation_category === 'auto_reply_with_intake') s += 1;
      if (answers[4] === 0 && ['shared_calendar_with_confirmations', 'appointment_reminder_sms'].includes(r.automation_category)) s += 0.5;
    }
    if (r.id === 'FL-000') s = paperOffice(task, answers, team) ? 99 : -99;
    return [s, r];
  }).sort((a, b) => b[0] - a[0]);
  const seen = new Set(), out = [];
  for (const [s, r] of scored) { if (s <= 0 || seen.has(r.leak_category)) continue; seen.add(r.leak_category); out.push(r); if (out.length >= k) break; }
  return out;
}
export function answersNarrative(answers) {
  if (!Array.isArray(answers) || answers.length !== QUESTIONS.length) return '';
  return QUESTIONS.map((q, i) => { const o = q.options.find((x) => x.score === answers[i]); return `Q${i + 1} "${q.text}" -> "${o ? o.label : 'no answer'}"`; }).join('\n');
}

// ---------- validator (mirror of engine/validator.py, depth free|breakdown) ----------
const NOT_YET = [/\b(?:can(?:no|')t|cannot|unable to|not able to) (?:[a-z]+ ){0,3}(?:yet|this one|for you)\b/i, /\bnot yet (?:able|available|possible|buildable|something I)\b/i, /^not yet\b/i, /\bcan(?:'|no)t build\b/i, /\bnot granted\b/i, /\bneeds? (?:your|the owner'?s?) (?:real )?(?:count|number|numbers|figure|volume|rate|input)\b/i, /\bfrom (?:the )?owner\b/i, /\bneeds? [a-z /]{0,25} from (?:you|the owner)\b/i, /\buntil (?:you|the owner) (?:tell|give|send|confirm)s?\b/i];
const UNNAMED_TOOL = [/\b(?:your|the|a|an) (?:scheduling|booking|invoicing|accounting|field[- ]service|texting|messaging|phone|payment|time[- ]tracking|photo) (?:software|app|tool|platform|system|provider)(?: you (?:already )?(?:pay for|use|own|have))?\b(?! \((?:jobber|housecall|servicetitan|quickbooks|square|quo|nicejob|companycam|google|stripe)[^)]*\))/i, /\bbusiness texting app\b/i, /\ba connector\b(?! \(|,? (?:jobber|zapier))/i, /\bshared spreadsheet\b(?! \(google)/i, /\bmobile form app\b/i, /\bthe phone app\b(?! \((?:jobber|housecall|quickbooks))/i, /\b(?:the|your) app\b(?! \((?:jobber|housecall|quickbooks))/i, /\bsoftware (?:you |they )?already pay for\b(?!, (?:jobber|housecall|quickbooks))/i];
const RAW_EVIDENCE = [/(?:^|[\s(;])(?:task|answer q\d|site|assumption):\s/im, /\bEvidence:\s/i];
const BOILERPLATE = [/https?:\/\/[^\s)]+/i, /payback in (?:about )?0 weeks/i, /\$0 one-time,? \$0 a month/i, /\$0 a year in cost/i, /about 0 weeks/i];
const MANUAL = [/\bphotograph(?:s|ing)?\b[^.]*\b(?:text|send|email|forward)s?\b/i, /\b(?:photo|picture) (?:of )?(?:the )?(?:part|label|serial|data plate|ticket)\b[^.]*\b(?:office|wife|typed|type)\b/i, /\btext (?:the|a) (?:photo|picture|image)s?\b/i, /\bwrite (?:it )?(?:more )?(?:clearly|bigger|neater)\b/i, /\bkeep a (?:notebook|notepad|binder|shoebox)\b/i, /\bhire (?:a|an|someone|your|another)\b/i, /\bblock out\b/i, /\bprint (?:the|a|it)\b/i, /\bremind (?:the owner|yourself|techs?|the team)\b/i, /\bset (?:a|an) (?:alarm|reminder) (?:for yourself|to)\b/i, /\bhave (?:your|the) (?:wife|spouse|husband|partner|kid|nephew|cousin) (?:do|handle|enter|type)\b/i, /\bcopy[- ]paste\b/i, /\bdouble[- ]check by hand\b/i, /\bmanually\b.*\b(?:each|every)\b/i, /\bcall (?:every|each) customer\b/i, /\bmake (?:a|one) (?:new )?folder\b/i, /\bmove the last \w+ /i, /\bscan(?:ning)? (?:each|every|the) (?:receipt|invoice|ticket)s?\b.*\b(?:email|inbox|folder)\b/i];
const BANNED_ALL = [[/\u2014/, 'em dash'], [/\b(?:ChatGPT|GPT-4|Grok|Claude|OpenAI|xAI|Anthropic)\b/, 'AI provider named'], [/\b(?:will|you'll|we'll) (?:save|recover|get back) \$?\d/i, 'promised result as fact'], [/\b(?:clients? (?:like you|of ours)|other (?:owners|shops) (?:saw|got))\b/i, 'implied testimonial'], [/\bI(?:'ll| will) [a-z ]{0,30}by hand\b/i, 'Daniel by hand'], [/(?<![\w/-])(?:we|us|our)(?![\w-])(?! refund)/i, 'first person plural']];
const SELL = /\b(?:\$7|\$249|Full Breakdown|Automation Audit|guarantee|refund|unlock|upgrade)\b/i;
function textOf(v, out = []) { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => textOf(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => textOf(x, out)); return out.join('\n'); }
export function toolIdsIn(text) { const t = String(text || '').toLowerCase(); const ids = new Set(); for (const [a, id] of Object.entries(ALIASES)) if (new RegExp('\\b' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t)) ids.add(id); return ids; }
function checkTools(tools, tag, f, needPrice) {
  if (!tools || !tools.length) { f.push(`R2 ${tag} names no tool`); return; }
  for (const x of tools) {
    const name = typeof x === 'object' ? x.name : x;
    const ids = toolIdsIn(name);
    if (!ids.size) f.push(`R2 ${tag} tool '${name}' is not in tools-catalog.csv`);
    else if (![...ids].some((i) => VERIFIED.has(i))) f.push(`R2 ${tag} tool '${name}' has no vendor-verified price (vendor_pricing_url + price_checked_on + verified=yes required in tools-catalog.csv)`);
    if (needPrice && typeof x === 'object') { const m = x.monthly_cost_usd || {}; if (typeof m.low !== 'number' || typeof m.high !== 'number') f.push(`R2 ${tag} tool '${name}' has no monthly price`); }
    if (typeof x === 'object' && String(x.why || '').length < 15) f.push(`R2 ${tag} tool '${name}' has no 'why this one'`);
  }
}
function common(t, f, depth) {
  for (const p of NOT_YET) { const m = t.match(p); if (m) f.push(`R1 not-yet/needs-from-owner: '${m[0]}'`); }
  for (const p of UNNAMED_TOOL) { const m = t.match(p); if (m) f.push(`R2 unnamed tool category: '${m[0]}'`); }
  for (const p of RAW_EVIDENCE) { const m = t.match(p); if (m) f.push(`R3 raw evidence line: '${m[0].trim()}'`); }
  for (const p of BOILERPLATE) { const m = t.match(p); if (m) f.push(`R6 boilerplate: '${m[0]}'`); }
  for (const [p, why] of BANNED_ALL) { const m = t.match(p); if (m) f.push(`R7 ${why}: '${m[0]}'`); }
  for (const p of LOGIN_WORDS) { const m = t.match(p); if (m) f.push(`R9 asks for or mentions a login/password: '${m[0]}' (every access request is an invite: accountant access in QuickBooks Online, a user in Jobber, an editor on the website; removed when done)`); }
  for (const sent of t.split(/(?<=[.!?])\s+|\n+/)) { const w = sent.trim().split(/\s+/).filter(Boolean); if (w.length > MAX_SENTENCE_WORDS && !/\d+ to \d+ hours a week x/.test(sent)) f.push(`R10 sentence over ${MAX_SENTENCE_WORDS} words (${w.length}): '${sent.slice(0, 70)}...'`); }
  if (SELL.test(t)) f.push('R7 sells or references the ladder inside a result');
}
export function validateResult(r, depth) {
  const f = [];
  if (!r || typeof r !== 'object') return ['S not an object'];
  for (const k of ['version', 'tier_paid', 'task_restated', 'biggest_leak', 'fix_this_week', 'estimates', 'cannot_see', 'sign_off']) if (!(k in r)) f.push(`S missing '${k}'`);
  if (f.length) return f;
  if (r.tier_paid !== (depth === 'breakdown')) return [`S tier_paid must be ${depth === 'breakdown'} for depth ${depth}`];
  if (r.sign_off !== 'Daniel Kane, Kynetica (AI)') f.push('S sign_off');
  if (!String(r.task_restated).startsWith('You told me the task eating your week is')) f.push('R7 task_restated opener');
  const fx = r.fix_this_week || {}, bl = r.biggest_leak || {}, est = r.estimates || {};
  const fixText = `${fx.what || ''} ${fx.removes_step || ''}`;
  for (const p of MANUAL) { const m = fixText.match(p); if (m) f.push(`R4 manual workaround: '${m[0].slice(0, 50)}'`); }
  checkTools(fx.tools, 'fix', f, depth === 'breakdown');
  if (!(r.fix_library_ids || []).length && r.leak_category !== 'unknown') f.push('S fix_library_ids empty');
  for (const name of ['hours_per_week', 'setup_effort_hours']) { const d = est[name] || {}; if (typeof d.low !== 'number' || typeof d.high !== 'number') { f.push(`R5 ${name} missing`); continue; } if (d.high < d.low || d.high <= 0) f.push(`R5 ${name} bad range`); }
  if (est.label !== 'estimate until you correct it') f.push('R5 label');
  if (!/\b(?:about |roughly |around )?\d+(?:\.\d+)?\s+[a-z][a-z -]{2,40}? (?:a|per|each) (?:day|week|month|year)\b/i.test(String(est.basis || ''))) f.push("R5 basis does not state the count it assumed with its unit (e.g. 'about 40 jobs a week', 'about 5 quote texts a week')");
  const tn = nouns(r.task_restated), ln = nouns(bl.where), fn = nouns(fixText);
  if (tn.size && ln.size && !inter(tn, ln).size) f.push('C leak shares no nouns with the task');
  const taskCore = String(r.task_restated).replace(/^You told me the task eating your week is\s*/i, '').trim().replace(/\.$/, '').toLowerCase();
  if (taskCore && String(bl.where || '').toLowerCase().includes(taskCore.slice(0, 60))) f.push('C biggest_leak.where repeats the task instead of naming the step where the time leaks');
  if (/\bmy (?:wife|husband|spouse|kid|nephew|cousin|office lady)\b/i.test(`${bl.where || ''} ${fixText}`)) f.push("R7 the owner's 'my wife/my nephew' copied into Daniel's voice; write 'your wife'");
  if (ln.size && fn.size && !inter(ln, fn).size) f.push('C fix shares no nouns with the leak');
  if (depth === 'free' && r.breakdown) f.push('C free result carries a breakdown');
  if (depth === 'breakdown') {
    const b = r.breakdown; if (!b) { f.push('S breakdown required'); return f; }
    const steps = b.steps || []; if (steps.length < 2) f.push('C fewer than 2 steps');
    if (!steps.some((s) => s.keep_manual === false)) f.push('C no step is automated');
    for (const s of steps) {
      if (s.keep_manual === true && s.automate && !String(s.automate).toLowerCase().startsWith('stays manual')) f.push(`C step '${s.name}' both manual and automated (a manual step's note must start 'Stays manual')`);
      if (s.keep_manual === false) { if (!s.automate) f.push(`C step '${s.name}' automated with no how`); checkTools(s.tools || [], `step '${s.name}'`, f, true); }
    }
    const cats = (b.secondary_leaks || []).map((x) => x.leak_category);
    if (cats.length > 2) f.push('C more than 2 secondary leaks');
    if (cats.length === 0 && !(r.cannot_see || []).length) f.push('C no secondary leaks and nothing in cannot_see; say what the answers did not show');
    if (cats.includes(r.leak_category) || (cats.length === 2 && cats[0] === cats[1])) f.push('C secondary leaks repeat');
    if (!b.monthly_total_usd || typeof b.monthly_total_usd.high !== 'number') f.push('R2 breakdown needs monthly_total_usd for the named tools');
  }
  const scrub = { ...r }; delete scrub.fix_library_ids; delete scrub.leak_category; delete scrub.trade; delete scrub.team_size; delete scrub.task_restated;
  common(textOf(scrub), f, depth);
  return f;
}

// ---------- prompt ----------
function toolsBlock() { return TOOLS.filter((t) => VERIFIED.has(t.tool_id)).map((t) => `- ${t.name} ($${t.monthly_low_usd} to $${t.monthly_high_usd}/mo; ${t.pricing_note}). Best for: ${t.best_for}. Why: ${t.why_this_one}`).join('\n'); }
function libraryBlock(rows) { return rows.map((r) => `- ${r.id} [${r.leak_category}] ${r.leak_pattern}. Named tools (first = recommended): ${r.named_tools.map((id) => TOOL_BY_ID[id]?.name || id).join(', ')}. What the owner does: ${r.diy_steps} Stays manual: ${r.manual_step_that_stays}. hours/wk ${r.hours_week_low}-${r.hours_week_high}, setup ${r.setup_hours_low}-${r.setup_hours_high}h. NEVER: ${r.anti_pattern_to_reject}.`).join('\n'); }

export function buildPrompt({ task, trade, teamSize, answers, paid, rows, priorFailures }) {
  const system = `You are Daniel Kane, the AI that runs Kynetica. A trade-business owner answered nine questions and named, in one sentence, the task that eats their week. Return ONE JSON object and nothing else (no prose, no code fence):

{"version":"0.2","tier_paid":${paid},"trade":"<HVAC|Plumbing|Electrical|Roofing|Solar|Landscaping|Pest|Window_Door|Dental|Agency|Other>","team_size":"<1-2|3-9|10-25|25+|>",
"task_restated":"You told me the task eating your week is <their task, their nouns, one sentence>.",
"leak_category":"<from the library row you pick, or unknown>",
"fix_library_ids":["FL-xxx"],
"biggest_leak":{"where":"<the exact step(s) in THEIR process where the time leaks, their nouns, 1-3 sentences>","why_it_costs":"<1-2 sentences>"},
"fix_this_week":{"what":"<ONE real automation fix they can set up this week, naming the tool: what it replaces and what stops happening. 2-4 sentences.>","automation_category":"<from the row>","tools":[{"name":"<EXACT name from TOOLS>","why":"<why this one for this shop, one sentence>"${paid ? ',"monthly_cost_usd":{"low":n,"high":n}' : ''}}],"removes_step":"<the step that no longer happens>","manual_steps_remaining":["<what stays human>"]},
"estimates":{"hours_per_week":{"low":n,"high":n},"setup_effort_hours":{"low":n,"high":n},"assumed_count":n,"assumed_unit":"<plural noun for what you counted, in the owner's words: jobs, paper tickets, quote texts, storm leads, maintenance customers>","assumed_minutes":n,"label":"estimate until you correct it"},
"cannot_see":["<inputs you did not have>"]${paid ? `,
"breakdown":{"steps":[{"name":"<step>","today":"<how it happens now>","automate":"<how, naming the tool>" or null,"keep_manual":true|false,"tools":[{"name":"<EXACT TOOLS name>","monthly_cost_usd":{"low":n,"high":n},"why":"<one sentence>"}],"setup_hours":{"low":n,"high":n}} x 3 to 8 in the order the steps happen],
"secondary_leaks":[<0 to 2 items, ONLY when a specific answer shows the leak; never invent> {"leak_category":"<different from the main one>","sentence":"<one sentence tied to a specific answer, naming the tool that closes it>"}],
"monthly_total_usd":{"low":n,"high":n}}` : ''},
"sign_off":"Daniel Kane, Kynetica (AI)"}

Rules that never bend:
- breakdown.steps: the task's real steps in order, 2 to 6. A step that stays manual has keep_manual true and automate null (or a note starting 'Stays manual'). At least one step is automated.\n- Never write 'the app', 'the phone app', 'the software' on its own: write the tool's name (Jobber, QuickBooks Online, Quo) every time.
- Sentences of 32 words or fewer. Never mention a login, password or credentials; if access comes up, it is an invite (accountant access in QuickBooks Online, a user in Jobber) removed when done.
- Use THEIR nouns. Paper tickets stay paper tickets; QuickBooks stays QuickBooks. But biggest_leak.where is NOT a repeat of the task: it names the exact step or hand-off where the time goes ("the hand-off from the paper ticket to the QuickBooks screen at night, where part numbers get re-read and re-typed"). Write about the owner in second person: "your wife", never "my wife".
- NAME the tool, from TOOLS only, and say why this one. Never "scheduling software", "invoicing tool", "business texting app", "a connector", "shared spreadsheet", "the app" on their own. If they already pay for QuickBooks Online, prefer what is inside their login first; if they are a paper office with 3 or more people (paper tickets, whiteboard, re-typing at night, same info typed into several places), the fix is moving to Jobber (Housecall Pro if online booking matters; never ServiceTitan under 10 techs) with QuickBooks Online sync, and you say it covers the re-typing, the parts and the invoicing in one move.
- Parts and serial numbers are picked from a price book or equipment record on the job form. Never photographed and sent.
- The fix REMOVES work. Photographing and texting, a folder, hiring, reminders to yourself, printing, "write clearer", doing it on another day are not fixes; if a row's NEVER line describes your fix, pick another.
- Numbers are estimates; give assumed_count (a number), assumed_unit (plural noun in the owner's words) and assumed_minutes (per unit). Never "needs your count" or "from the owner".
- Never a price of ours, a product of ours, an audit, a guarantee, a refund. You deliver the result; you do not sell. ${paid ? 'Tool monthly prices ARE required here (this is the paid breakdown).' : 'No tool prices at this depth.'}
- Plain first person, I. Never we, us, our. No em dashes. No exclamation points. No URLs. Never mention an AI model or provider.
- Do not describe their score or tier. No generic advice.${priorFailures?.length ? `

Your previous attempt was REJECTED by the validator. Fix every one:
${priorFailures.map((x) => '- ' + x).join('\n')}` : ''}`;
  const user = `Trade: ${trade || 'not given'}. Team size: ${teamSize || 'not given'}.
Their task, in their words: "${task}"

Their nine answers:
${answersNarrative(answers)}

TOOLS (the only names allowed):
${toolsBlock()}

Candidate fix-library rows (respect every NEVER):
${libraryBlock(rows)}

Return the JSON object only.`;
  return { system, user };
}

// ---------- model call ----------
async function callModel(system, user, paid, key) {
  const models = ['grok-4-fast', 'grok-3-mini']; let lastErr;
  for (const model of models) {
    try {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), paid ? 50000 : 25000);
      const resp = await fetch('https://api.x.ai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.35, max_tokens: paid ? 2600 : 1300, response_format: { type: 'json_object' } }), signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) { lastErr = new Error(`xai_${resp.status}`); continue; }
      const data = await resp.json(); const text = data?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) return text.trim();
      lastErr = new Error('xai_empty');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('xai_failed');
}
export function parseJson(text) { let t = String(text).trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, ''); const i = t.indexOf('{'), j = t.lastIndexOf('}'); if (i >= 0 && j > i) t = t.slice(i, j + 1); return JSON.parse(t); }

// Code owns the arithmetic: tool prices from the catalog, monthly total.
export function structuralBasis(r) {
  const e = r.estimates || (r.estimates = {});
  const n = Number(e.assumed_count), m = Number(e.assumed_minutes); const unit = String(e.assumed_unit || '').trim().replace(/[.]+$/, '');
  if (Number.isFinite(n) && n > 0 && unit) e.basis = `I assumed about ${n} ${unit} a week${Number.isFinite(m) && m > 0 ? ` and ${m} minutes each` : ''}.`;
  return r;
}
export function proseHygiene(r) {
  const firstTool = (r.fix_this_week?.tools || []).map((t) => t.name).find((nm) => toolIdsIn(nm).size);
  const fix = (txt) => { let t = String(txt ?? ''); t = t.replace(/\b(?:your |the )?(?:login|log-in|logins)\b/gi, 'account').replace(/\bpasswords?\b/gi, 'account access'); if (firstTool) t = t.replace(/\b(?:the|your) (?:phone )?(?:app|software|platform|system)\b/gi, firstTool).replace(/\b(?:the|your|a) (?:scheduling|invoicing|accounting|booking|texting|dispatch|field[- ]service) (?:tool|software|app|platform|system)\b/gi, firstTool); return t; };
  if (r.biggest_leak) for (const k of ['where', 'why_it_costs']) if (k in r.biggest_leak) r.biggest_leak[k] = fix(r.biggest_leak[k]);
  if (r.fix_this_week) { for (const k of ['what', 'removes_step']) if (k in r.fix_this_week) r.fix_this_week[k] = fix(r.fix_this_week[k]); r.fix_this_week.manual_steps_remaining = (r.fix_this_week.manual_steps_remaining || []).map(fix); }
  if (r.breakdown) { for (const s of r.breakdown.steps || []) for (const k of ['today', 'automate']) if (s[k]) s[k] = fix(s[k]); for (const x of r.breakdown.secondary_leaks || []) if (x.sentence) x.sentence = fix(x.sentence); }
  return r;
}
export function normalizeTools(r, teamSize = '') {
  const bandKey = (ts) => (/^1/.test(String(ts || '')) ? 'band_small' : /^(3|4|5|6|7|8|9)/.test(String(ts || '')) ? 'band_mid' : 'band_large');
  const band = (c, ts) => { const b = String(c[bandKey(ts)] || '').split('-').map(Number); return b.length === 2 && !b.some(isNaN) ? { low: b[0], high: b[1] } : { low: c.monthly_low_usd, high: c.monthly_high_usd }; };
  const fix = (tools) => (tools || []).map((t) => { const id = [...toolIdsIn(t.name)][0]; const c = id && TOOL_BY_ID[id]; return c ? { ...t, name: c.name, monthly_cost_usd: band(c, teamSize) } : t; });
  if (r.fix_this_week) r.fix_this_week.tools = fix(r.fix_this_week.tools);
  if (r.breakdown) {
    for (const s of r.breakdown.steps || []) s.tools = fix(s.tools);
    const ids = new Set(); for (const s of r.breakdown.steps || []) for (const t of s.tools || []) for (const id of toolIdsIn(t.name)) ids.add(id);
    for (const t of r.fix_this_week?.tools || []) for (const id of toolIdsIn(t.name)) ids.add(id);
    let lo = 0, hi = 0; for (const id of ids) { const c = TOOL_BY_ID[id]; if (c) { const b = band(c, teamSize); lo += b.low; hi += b.high; } }
    r.breakdown.monthly_total_usd = { low: lo, high: hi };
  }
  if (!r.tier_paid && r.fix_this_week) for (const t of r.fix_this_week.tools || []) delete t.monthly_cost_usd;
  return r;
}

export async function generateResult({ task, trade, teamSize, answers, paid, key = process.env.XAI_API_KEY, fetchImpl }) {
  if (!key) throw new Error('no_key');
  const depth = paid ? 'breakdown' : 'free';
  const rows = retrieveRows(task, trade, answers, 6, teamSize);
  let failures = [], result = null, lastRaw = null; const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { system, user: user0 } = buildPrompt({ task, trade, teamSize, answers, paid, rows, priorFailures: failures });
    const user = lastRaw && failures.length ? `${user0}\n\nYOUR PREVIOUS DRAFT (edit it minimally: fix only the rejected items, keep every other field word for word, keep the same number of steps and secondary leaks):\n${lastRaw}` : user0;
    let raw = null, parsed = null, transportErr = null;
    for (let t = 0; t < 3 && parsed === null; t++) {
      try { raw = await (fetchImpl ? fetchImpl(system, user, paid) : callModel(system, user, paid, key)); parsed = parseJson(raw); }
      catch (e) { transportErr = e; parsed = null; if (t < 2) await new Promise((res) => setTimeout(res, 800 * (t + 1))); }
    }
    if (parsed === null) { failures = [`S transport/parse failure after 3 tries: ${transportErr && transportErr.message}`]; attempts.push({ attempt, failures }); continue; }
    lastRaw = raw;
    parsed.tier_paid = !!paid; parsed.version = '0.2'; normalizeTools(parsed, teamSize); structuralBasis(parsed); proseHygiene(parsed);
    failures = validateResult(parsed, depth); attempts.push({ attempt, failures, draft: parsed });
    if (!failures.length) { result = parsed; break; }
  }
  if (!result) { const e = new Error('engine_rejected'); e.failures = failures; e.attempts = attempts; throw e; }
  return { result, html: renderResultHtml(result), attempts, engine: ENGINE_VERSION };
}

// ---------- renderer: JSON -> ticket HTML (<p>/<strong> only) ----------
function sent(s) { s = String(s ?? '').trim(); return s && !/[.!?]$/.test(s) ? s + '.' : s; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function range(d, unit) { return d.low === d.high ? `${d.low} ${unit}` : `${d.low} to ${d.high} ${unit}`; }
function money(d) { return d.low === d.high ? `$${d.low}` : `$${d.low} to $${d.high}`; }
function toolLine(tools, withPrice) { return (tools || []).map((t) => `${esc(t.name)}${withPrice && t.monthly_cost_usd ? ` (about ${money(t.monthly_cost_usd)} a month)` : ''}: ${esc(sent(t.why))}`).join(' '); }
export function renderResultHtml(r) {
  const out = []; const fx = r.fix_this_week, est = r.estimates;
  out.push(`<p>${esc(sent(r.task_restated))}</p>`);
  out.push(`<p><strong>Your biggest leak:</strong> ${esc(sent(r.biggest_leak.where))} ${esc(sent(r.biggest_leak.why_it_costs))}</p>`);
  out.push(`<p><strong>Fix for this week:</strong> ${esc(sent(fx.what))} What stops being manual: ${esc(sent(fx.removes_step))} What stays yours: ${esc((fx.manual_steps_remaining || []).map(sent).join(' '))}</p>`);
  out.push(`<p><strong>The tool, and why this one:</strong> ${toolLine(fx.tools, !!r.tier_paid)}</p>`);
  out.push(`<p>Estimated ${esc(range(est.hours_per_week, 'hours a week'))} back, and about ${esc(range(est.setup_effort_hours, 'hours'))} to set up. ${esc(sent(est.basis))} Both figures are an ${esc(est.label)}.</p>`);
  out.push(`<p>What I could not see from nine answers: ${esc(r.cannot_see.join(', '))}. Correct me and the numbers move.</p>`);
  if (r.tier_paid && r.breakdown) {
    out.push(`<p><strong>Your full breakdown.</strong> The task, step by step, in the order it happens:</p>`);
    r.breakdown.steps.forEach((s, i) => {
      const how = s.keep_manual ? 'Stays manual.' : `Automate: ${esc(s.automate)} ${toolLine(s.tools, true)}${s.setup_hours ? ` Setup about ${esc(range(s.setup_hours, 'hours'))}, an estimate.` : ''}`;
      out.push(`<p><strong>Step ${i + 1}. ${esc(s.name)}.</strong> Today: ${esc(s.today)} ${how}</p>`);
    });
    out.push(`<p><strong>What the tools cost, all in:</strong> about ${money(r.breakdown.monthly_total_usd)} a month at 2026 list prices, before promotions.</p>`);
    out.push(`<p><strong>Two more things your answers showed.</strong> ${r.breakdown.secondary_leaks.map((x) => esc(x.sentence)).join(' ')}</p>`);
  }
  out.push(`<p>${esc(r.sign_off)}</p>`);
  return out.join('\n');
}
