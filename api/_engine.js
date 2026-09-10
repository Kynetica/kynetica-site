// Engine v1 for the Office Leak Finder result (free) and the Full Breakdown ($7).
// Contract: kynetica-marketing/engine/result.schema.json. Validator: mirror of engine/validate.py (kept in sync by
// tools/test_engine_v1.py, which runs both on the same fixtures). Library: api/_fix_library.js (generated).
//
// Flow: retrieve candidate library rows from the task + trade + answers -> structured JSON from the model ->
// validate -> on REJECT, one retry with the failure list in the prompt -> on second REJECT, throw (caller sends the
// honest fallback, never a bad result). Then render JSON -> ticket HTML (<p>/<strong> only).
import { FIX_LIBRARY } from './_fix_library.js';
import { QUESTIONS } from './_questions.js';

export const ENGINE_VERSION = 'v1.0';
const LEAK_CATEGORIES = ['double_entry','capture_at_source','after_hours_response','scheduling_mixup','no_show','quote_follow_up','invoice_creation_delay','parts_capture','photo_handoff','change_order','payment_chasing','payment_collection_method','deposit_tracking','reconciliation','review_request','renewal_recurring','paperwork_prefill','overflow_intake','after_hours_triage','permit_tracking','materials_takeoff','lead_surge','claim_paperwork','milestone_payment','route_building','recurring_billing','timesheet_to_payroll','survey_capture','eta_communication','unknown'];

// ---------- retrieval ----------
const STOP = new Set('the a an and or of to in on at for with your you it is are be this that from into by as we i my our their his her its up out then than every each one all any some me him them'.split(' '));
function toks(s) { return String(s || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []; }
function nouns(s) { return new Set(toks(s).filter((w) => !STOP.has(w))); }

export function retrieveRows(task, trade, answers, k = 5) {
  const t = String(task || '').toLowerCase();
  const scored = FIX_LIBRARY.map((r) => {
    let s = 0;
    for (const w of r.signal_words) if (t.includes(w.toLowerCase())) s += 3;
    const pn = nouns(r.leak_pattern); for (const w of nouns(t)) if (pn.has(w)) s += 1;
    if (r.trade === trade) s += 1.5; else if (r.trade !== 'all') s -= 1;
    // answer signals: Q4 (index 3) double typing, Q6 chasing payment, Q8 9pm quote, Q5 mix-ups
    if (Array.isArray(answers)) {
      if (answers[3] === 0 && r.automation_category === 'record_once_sync') s += 1;
      if (answers[5] === 0 && r.stage === 'invoice_to_money') s += 0.5;
      if (answers[7] === 0 && r.automation_category === 'auto_reply_with_intake') s += 1;
      if (answers[4] === 0 && r.automation_category === 'shared_calendar_with_confirmations') s += 0.5;
    }
    return [s, r];
  }).sort((a, b) => b[0] - a[0]);
  return scored.slice(0, k).filter(([s]) => s > 0).map(([, r]) => r);
}

export function answersNarrative(answers) {
  if (!Array.isArray(answers) || answers.length !== QUESTIONS.length) return '';
  return QUESTIONS.map((q, i) => {
    const o = q.options.find((x) => x.score === answers[i]);
    return `Q${i + 1} "${q.text}" -> "${o ? o.label : 'no answer'}"`;
  }).join('\n');
}

// ---------- validator (mirror of engine/validate.py) ----------
const MANUAL_WORKAROUND = [
  /\bphotograph\b.*\b(text|send|email)\b.*\b(office|wife|owner|spouse|bookkeeper)\b/i, /\btext (the|a) (photo|picture|image)s?\b/i,
  /\bwrite (it )?(more )?(clearly|bigger|neater)\b/i, /\bkeep a (notebook|notepad|binder|shoebox)\b/i, /\bhire (a|an|someone|your)\b/i,
  /\bblock out\b/i, /\bprint (the|a|it)\b/i, /\bremind (the owner|yourself|techs?|the team)\b/i, /\bset (a|an) (alarm|reminder) (for yourself|to)\b/i,
  /\bhave (your|the) (wife|spouse|husband|partner|kid|nephew|cousin) (do|handle|enter|type)\b/i, /\bcopy[- ]paste\b/i,
  /\bevery (night|evening|morning) (you|the owner) (go|goes|sit|sits) through\b/i, /\bwrite (it|them) down (twice|again)\b/i,
  /\bdouble[- ]check by hand\b/i, /\bmanually\b.*\b(each|every)\b/i, /\bonce a week (go|sit|do)\b/i, /\bcall (every|each) customer\b/i,
  /\bmake (a|one) (new )?folder\b/i, /\bmove the last \w+ /i,
];
const BANNED = [
  [/\b(ServiceTitan|Jobber|Housecall Pro|HouseCall|Zapier|Make\.com|Salesforce|HubSpot|Monday\.com|Notion|Airtable|Twilio)\b/i, 'vendor/product named'],
  [/\$\s?\d/, 'dollar figure'], [/\b(guarantee|refund|audit|\$7|\$249|Full Breakdown|upgrade|unlock)\b/i, 'sells or references the ladder'],
  [/\b(clients? (like you|of ours)|other (owners|shops) (saw|got)|customers? (have|has) (saved|seen))\b/i, 'implied testimonial'],
  [/\u2014/, 'em dash'], [/\bI(?:'ll| will) [a-z ]{0,30}by hand\b/i, "Daniel doing something 'by hand'"], [/\b(will|we'll|you'll) (save|recover|get back) \d/i, 'promised result'],
  [/\b(ChatGPT|GPT|Grok|Claude|OpenAI|xAI|Anthropic|LLM)\b/, 'AI provider named'],
];
const GENERIC = [/\bmap (out )?your (workflow|process)\b/i, /\bwrite down your process\b/i, /\bdocument everything\b/i, /\bconsider (using|adopting) (a|an|some) (software|tool|system)\b/i];
function textOf(v, out = []) { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => textOf(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => textOf(x, out)); return out.join('\n'); }
function inter(a, b) { const o = new Set(); for (const x of a) if (b.has(x)) o.add(x); return o; }

export function validateResult(r) {
  const f = [];
  if (!r || typeof r !== 'object') return ['S not an object'];
  for (const k of ['version', 'tier_paid', 'task_restated', 'biggest_leak', 'fix_this_week', 'estimates', 'cannot_see', 'sign_off']) if (!(k in r)) f.push(`S missing required '${k}'`);
  if (f.length) return f;
  if (r.version !== '0.1') f.push("S version must be '0.1'");
  if (r.sign_off !== 'Daniel Kane, Kynetica (AI)') f.push('S sign_off must be exactly "Daniel Kane, Kynetica (AI)"');
  if (r.leak_category != null && !LEAK_CATEGORIES.includes(r.leak_category)) f.push(`S leak_category '${r.leak_category}' not in enum`);
  if (r.tier_paid === true && !r.breakdown) f.push('S tier_paid=true requires breakdown');
  if (!Array.isArray(r.cannot_see) || !r.cannot_see.length) f.push('S cannot_see must list at least one input');
  const fx = r.fix_this_week || {}, bl = r.biggest_leak || {}, est = r.estimates || {};
  const fixText = `${fx.what || ''} ${fx.removes_step || ''}`;
  for (const p of MANUAL_WORKAROUND) { const m = fixText.match(p); if (m) f.push(`A manual workaround in fix: '${m[0].slice(0, 60)}'`); }
  if (!fx.automation_category || ['none', 'manual'].includes(fx.automation_category)) f.push('A fix has no automation_category');
  const rs0 = String(fx.removes_step || '');
  if (rs0 && rs0.split(/\s+/).length < 4) f.push('A removes_step too short to name a step');
  if (rs0 && /\b(reminder|remind|notebook|folder|hire|print|by hand)\b/i.test(rs0) && !/\b(no longer|stops|disappears|removed|gone)\b/i.test(rs0)) f.push('A removes_step describes a workaround, not a removed step');
  for (const [name, d] of [['hours_per_week', est.hours_per_week], ['setup_effort_hours', est.setup_effort_hours]]) {
    if (!d || typeof d.low !== 'number' || typeof d.high !== 'number') { f.push(`B estimates.${name} missing low/high`); continue; }
    if (d.high < d.low) f.push(`B estimates.${name} high < low`);
    if (d.high <= 0) f.push(`B estimates.${name} is zero`);
    if (name === 'hours_per_week' && d.high > 40) f.push('C hours_per_week exceeds a working week');
    if (name === 'setup_effort_hours' && d.high > 40) f.push("C setup_effort_hours is not 'this week'");
  }
  if (est.label !== 'estimate until you correct it') f.push("B estimates.label must be exactly 'estimate until you correct it'");
  if (!/\b(needs?|until|replace|correct|your (real )?(number|count|volume|rate))\b/i.test(String(est.basis || ''))) f.push('B estimates.basis does not name the owner number that would replace the guess');
  const remaining = (fx.manual_steps_remaining || []).join(' ');
  if (fx.removes_step && remaining) { const o = inter(nouns(fx.removes_step), nouns(remaining)); ['tech', 'owner', 'customer', 'job', 'jobs'].forEach((x) => o.delete(x)); if (o.size >= 2) f.push(`C fix removes and keeps the same step (${[...o].slice(0, 4).join(', ')})`); }
  const tn = nouns(r.task_restated), ln = nouns(bl.where), fn = nouns(fixText);
  if (tn.size && ln.size && !inter(tn, ln).size) f.push("C biggest_leak.where shares no nouns with the owner's task");
  if (ln.size && fn.size && !inter(ln, fn).size) f.push('C fix shares no nouns with the leak');
  if (r.tier_paid === true && r.breakdown) {
    for (const s of r.breakdown.steps || []) {
      if (s.keep_manual === true && s.automate) f.push(`C step '${s.name}' both keep_manual and automate`);
      if (s.keep_manual === false && !s.automate) f.push(`C step '${s.name}' not manual yet no automation`);
    }
    const cats = (r.breakdown.secondary_leaks || []).map((x) => x.leak_category);
    if (cats.includes(r.leak_category)) f.push('C secondary leak repeats the main leak_category');
    if (cats.length === 2 && cats[0] === cats[1]) f.push('C both secondary leaks are the same category');
    if ((r.breakdown.steps || []).length < 3) f.push('C breakdown needs at least 3 steps');
    if (cats.length !== 2) f.push('C breakdown needs exactly 2 secondary leaks');
  }
  if (r.tier_paid === false && r.breakdown) f.push('C free result carries a breakdown');
  const t = textOf(r);
  for (const [p, why] of BANNED) { const m = t.match(p); if (m) f.push(`D banned: ${why}: '${m[0]}'`); }
  for (const p of GENERIC) { const m = t.match(p); if (m) f.push(`D generic advice: '${m[0]}'`); }
  if (/\b(\d+)\s*(hours?|hrs?)\b/i.test(fx.what || '') && !/estimate/i.test(fx.what || '')) f.push("D hours figure in fix text without 'estimate'");
  if (!String(r.task_restated || '').startsWith('You told me the task eating your week is')) f.push("E task_restated must open 'You told me the task eating your week is'");
  if (/\b(we|us|our)\b/i.test(`${bl.where || ''} ${fixText}`)) f.push("E first person plural in the result; Daniel writes as 'I'");
  return f;
}

// ---------- prompt ----------
function libraryBlock(rows) {
  return rows.map((r) => `- ${r.id} [${r.leak_category || r.stage}] pattern: ${r.leak_pattern}. automation_category: ${r.automation_category}. tools the owner likely has: ${r.tools_owner_likely_has.join('; ')}. stays manual: ${r.manual_step_that_stays}. hours/week ${r.hours_week_low}-${r.hours_week_high}, setup ${r.setup_hours_low}-${r.setup_hours_high}h. basis: ${r.estimate_basis}. NEVER suggest: ${r.anti_pattern_to_reject}.`).join('\n');
}

export function buildPrompt({ task, trade, teamSize, answers, paid, rows, priorFailures }) {
  const system = `You are Daniel Kane, the AI that runs Kynetica. A small trade-business owner answered nine questions and named, in one sentence, the task that eats their week. You return ONE JSON object and nothing else (no prose, no code fence) matching this contract exactly:

{"version":"0.1","tier_paid":${paid},"trade":"<one of HVAC|Plumbing|Electrical|Roofing|Solar|Landscaping|Pest|Window_Door|Dental|Agency|Other>","team_size":"<1-2|3-9|10-25|25+|>",
"task_restated":"You told me the task eating your week is <their task, their nouns, one sentence>.",
"leak_category":"<one of ${LEAK_CATEGORIES.join('|')}>",
"fix_library_ids":["FL-xxx"],
"biggest_leak":{"where":"<the exact step(s) in THEIR process where the time leaks, using their nouns, 1-3 sentences>","why_it_costs":"<why that step costs hours, 1-2 sentences>"},
"fix_this_week":{"what":"<ONE concrete fix they can set up this week that REMOVES or automates the step. Name the category of tool they likely already own. 2-4 sentences.>","automation_category":"<from the library row>","tool_category":"<category, never a brand>","removes_step":"<which step disappears or runs itself>","manual_steps_remaining":["<what stays human, plainly>"]},
"estimates":{"hours_per_week":{"low":n,"high":n},"setup_effort_hours":{"low":n,"high":n},"basis":"<how you got the number and which of THEIR numbers would replace it, e.g. 'needs your jobs per day'>","label":"estimate until you correct it"},
"cannot_see":["<inputs you did not have: call volume, no-show rate, software they pay for...>"]${paid ? `,
"breakdown":{"steps":[{"name":"<step>","today":"<how it happens now>","automate":"<how, with tool category>" or null,"keep_manual":true|false,"tool_category":"<category>","setup_hours":{"low":n,"high":n}} x 3 to 8, in the order the steps actually happen],
"secondary_leaks":[{"leak_category":"<different from the main one>","sentence":"<one sentence traceable to a specific answer among the nine>"} x exactly 2]}` : ''},
"sign_off":"Daniel Kane, Kynetica (AI)"}

Rules that never bend:
- Use THEIR nouns. "paper tickets" and "QuickBooks" stay "paper tickets" and "QuickBooks".
- The fix must remove work, not move it. Photographing a ticket and texting it to someone, making a folder, hiring, reminders, printing, "write clearer", or doing it on a different day are NOT fixes. If a library row's NEVER line describes your fix, pick a different fix.
- leak_category comes from the library row you pick ([category] in brackets below). Pick fix_library_ids only from the candidate rows. If the owner's task is vague ("everything feels like admin", "I don't know") or no row fits, use [] and leak_category "unknown", say plainly that you are inferring the task from their nine answers, and make the fix the closest honest step from those answers.
- removes_step names the step that stops happening ("the nightly re-typing into QuickBooks no longer happens"). Never a reminder, folder, printout or person.
- Write as I. Never we, us, our.
- Every number is an estimate inside the library row's range unless their task gives a real count. basis names the number of theirs that would replace yours.
- Never name a software brand, an AI model, a price, a product, an audit, a guarantee. Never sell. Never use "we", "us", "our". No em dashes. No exclamation points.
- Do not describe their score or tier. Do not give generic advice.
- Plain language a plumber reads on a phone at 7pm.${priorFailures && priorFailures.length ? `

Your previous attempt was REJECTED by the validator for these reasons. Fix every one:
${priorFailures.map((x) => '- ' + x).join('\n')}` : ''}`;

  const user = `Trade: ${trade || 'not given'}. Team size: ${teamSize || 'not given'}.
Their task, in their words: "${task}"

Their nine answers:
${answersNarrative(answers)}

Candidate fix-library rows (use these; respect every NEVER):
${libraryBlock(rows)}

Return the JSON object only.`;
  return { system, user };
}

// ---------- model call ----------
async function callModel(system, user, paid, key) {
  const models = ['grok-4-fast', 'grok-3-mini'];
  let lastErr;
  for (const model of models) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), paid ? 45000 : 22000);
      const resp = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.4, max_tokens: paid ? 2200 : 1100, response_format: { type: 'json_object' } }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) { lastErr = new Error(`xai_${resp.status}`); continue; }
      const data = await resp.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) return text.trim();
      lastErr = new Error('xai_empty');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('xai_failed');
}

export function parseJson(text) {
  let t = String(text).trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  return JSON.parse(t);
}

// Returns { result, html, attempts, failures } or throws Error('engine_rejected') with .failures / .attempts.
export async function generateResult({ task, trade, teamSize, answers, paid, key = process.env.XAI_API_KEY, fetchImpl }) {
  if (!key) throw new Error('no_key');
  const rows = retrieveRows(task, trade, answers, 5);
  let failures = [], result = null;
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { system, user } = buildPrompt({ task, trade, teamSize, answers, paid, rows, priorFailures: failures });
    const raw = await (fetchImpl ? fetchImpl(system, user, paid) : callModel(system, user, paid, key));
    let parsed;
    try { parsed = parseJson(raw); } catch (e) { failures = ['S output was not valid JSON']; attempts.push({ attempt, failures }); continue; }
    parsed.tier_paid = !!paid; // never trust the model on this
    failures = validateResult(parsed);
    attempts.push({ attempt, failures });
    if (!failures.length) { result = parsed; break; }
  }
  if (!result) { const e = new Error('engine_rejected'); e.failures = failures; e.attempts = attempts; throw e; }
  return { result, html: renderResultHtml(result), attempts, engine: ENGINE_VERSION };
}

// ---------- renderer: JSON -> ticket HTML (<p>/<strong> only; control section 3/4 copy lives in assess.html, not here) ----------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function range(d, unit) { return d.low === d.high ? `${d.low} ${unit}` : `${d.low} to ${d.high} ${unit}`; }
export function renderResultHtml(r) {
  const out = [];
  out.push(`<p>${esc(r.task_restated)}</p>`);
  out.push(`<p><strong>Your biggest leak:</strong> ${esc(r.biggest_leak.where)} ${esc(r.biggest_leak.why_it_costs)}</p>`);
  const fx = r.fix_this_week, est = r.estimates;
  out.push(`<p><strong>Fix for this week:</strong> ${esc(fx.what)} What stops being manual: ${esc(fx.removes_step)} What stays yours: ${esc((fx.manual_steps_remaining || []).join(' '))}</p>`);
  out.push(`<p>Estimated ${esc(range(est.hours_per_week, 'hours a week'))} back, and about ${esc(range(est.setup_effort_hours, 'hours'))} to set up. ${esc(est.basis)} Both figures are an ${esc(est.label)}.</p>`);
  out.push(`<p>What I could not see from nine answers: ${esc(r.cannot_see.join(', '))}. Correct me and the numbers move.</p>`);
  if (r.tier_paid && r.breakdown) {
    out.push(`<p><strong>Your full breakdown.</strong> The task, step by step, in the order it happens:</p>`);
    r.breakdown.steps.forEach((s, i) => {
      const how = s.keep_manual ? 'Stays manual.' : `Automate: ${esc(s.automate)}${s.tool_category ? ` (${esc(s.tool_category)})` : ''}${s.setup_hours ? `. Setup about ${esc(range(s.setup_hours, 'hours'))}, an estimate.` : ''}`;
      out.push(`<p><strong>Step ${i + 1}. ${esc(s.name)}.</strong> Today: ${esc(s.today)} ${how}</p>`);
    });
    out.push(`<p><strong>Two more things your answers showed.</strong> ${r.breakdown.secondary_leaks.map((x) => esc(x.sentence)).join(' ')}</p>`);
  }
  out.push(`<p>${esc(r.sign_off)}</p>`);
  return out.join('\n');
}
