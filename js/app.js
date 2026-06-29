// Comic Audiobook Studio — fully client-side.
// PDF (pdf.js) → GPT vision transcript (Responses API) → OpenAI TTS → stitched MP3 (Web Audio + lamejs).

import * as pdfjsLib from '../vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

// ── Constants ──────────────────────────────────────────────────────────────
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
// Gemini prebuilt voice names (single-speaker TTS).
const GEMINI_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];
const ITEM_TYPES = ['narration', 'dialogue', 'caption', 'sfx'];

// TTS model registry. provider drives endpoint/auth/voice-set; `instructions` = supports a delivery param.
const TTS_MODELS = [
  { id: 'gpt-4o-mini-tts', provider: 'openai', instructions: true },
  { id: 'tts-1', provider: 'openai', instructions: false },
  { id: 'tts-1-hd', provider: 'openai', instructions: false },
  { id: 'gemini-2.5-flash-preview-tts', provider: 'gemini', instructions: false },
  { id: 'gemini-2.5-pro-preview-tts', provider: 'gemini', instructions: false },
];
function modelInfo(id) {
  return TTS_MODELS.find((m) => m.id === id)
    || { id, provider: /gemini/i.test(id) ? 'gemini' : 'openai', instructions: id === 'gpt-4o-mini-tts' };
}
function providerOf(id) { return modelInfo(id).provider; }
function voicesFor(id) { return providerOf(id) === 'gemini' ? GEMINI_VOICES : OPENAI_VOICES; }
function defaultVoiceFor(id) { return voicesFor(id)[0]; }

const LS = {
  apiKey: 'cab_apiKey',
  geminiKey: 'cab_geminiKey',
  transcriptModel: 'cab_transcriptModel',
  ttsModel: 'cab_ttsModel',
  maxPages: 'cab_maxPages',
  maxWidth: 'cab_maxWidth',
  bitrate: 'cab_bitrate',
  script: 'cab_script',
  pdfName: 'cab_pdfName',
};

const DEFAULTS = {
  transcriptModel: 'gpt-5.5',
  ttsModel: 'gpt-4o-mini-tts',
  maxPages: 40,
  maxWidth: 1024,
  bitrate: 128,
};

// JSON schema for structured output (Responses API, strict).
// `voices` is an array of {speaker,voice} pairs so it stays strict-schema-friendly.
const SCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'voices', 'items'],
  properties: {
    title: { type: 'string' },
    voices: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['speaker', 'voice'],
        properties: { speaker: { type: 'string' }, voice: { type: 'string', enum: OPENAI_VOICES } },
      },
    },
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'page', 'panel', 'type', 'speaker', 'voice', 'emotion', 'instructions', 'text', 'pause_after_ms'],
        properties: {
          id: { type: 'string' },
          page: { type: 'integer' },
          panel: { type: 'integer' },
          type: { type: 'string', enum: ITEM_TYPES },
          speaker: { type: 'string' },
          voice: { type: 'string', enum: OPENAI_VOICES },
          emotion: { type: 'string' },
          instructions: { type: 'string' },
          text: { type: 'string' },
          pause_after_ms: { type: 'integer' },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are an audiobook director adapting a comic/graphic story into a script for OpenAI text-to-speech.
You receive the pages of a PDF in order, as images (and any embedded text). Produce a single narratable script.

Rules:
- Read every panel in natural reading order (left-to-right, top-to-bottom).
- One "item" per spoken/narrated/captioned beat. Keep beats short enough to voice naturally.
- "type" is one of: narration, dialogue, caption, sfx.
- Assign each distinct speaker a consistent voice from this exact list: ${OPENAI_VOICES.join(', ')}.
  Reuse the same voice for the same speaker across the whole book. Pick a calm voice for the narrator.
- "instructions" is a short TTS delivery note (tone, pace, accent) — it steers the voice, it is NOT spoken.
- "text" is exactly what should be spoken. For sfx, render it as a vocalizable word (e.g. "Crash!").
- "emotion" is one or two words.
- "pause_after_ms" is silence to insert after the line (150–400 for beats, 600–1000 between pages/scenes).
- "id" is a stable identifier like "p01_001".
- Populate the "voices" array with every speaker→voice pairing you used.
Return ONLY the structured JSON.`;

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  script: null,        // { title, voices:[{speaker,voice}], items:[...] }
  pdfPages: null,      // [{ page, dataUrl, text }]
  pdfName: null,
  generating: false,
  cancel: false,
  audioUrl: null,
};

// ── DOM ──────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = {
  settingsToggle: $('settingsToggle'), settings: $('settings'),
  apiKey: $('apiKey'), geminiKey: $('geminiKey'), transcriptModel: $('transcriptModel'), ttsModel: $('ttsModel'),
  maxPages: $('maxPages'), maxWidth: $('maxWidth'), bitrate: $('bitrate'),
  dropZone: $('dropZone'), fileInput: $('fileInput'), pdfInfo: $('pdfInfo'),
  genTranscriptBtn: $('genTranscriptBtn'), transcriptStatus: $('transcriptStatus'),
  stepEdit: $('step-edit'), stepAudio: $('step-audio'),
  metaTitle: $('metaTitle'), downloadJsonBtn: $('downloadJsonBtn'), importJsonInput: $('importJsonInput'),
  voicesEditor: $('voicesEditor'), addVoiceBtn: $('addVoiceBtn'), autoVoiceBtn: $('autoVoiceBtn'), providerNote: $('providerNote'),
  itemsBody: $('itemsBody'), addLineBtn: $('addLineBtn'), saveStatus: $('saveStatus'),
  rawJson: $('rawJson'), applyRawBtn: $('applyRawBtn'), rawStatus: $('rawStatus'),
  genAudioBtn: $('genAudioBtn'), cancelAudioBtn: $('cancelAudioBtn'), downloadAudioBtn: $('downloadAudioBtn'),
  progressBar: $('progressBar'), progressLabel: $('progressLabel'), console: $('console'),
};

// ── Console logger ─────────────────────────────────────────────────────────
function log(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  const ts = new Date().toTimeString().slice(0, 8);
  line.textContent = `[${ts}] ${msg}`;
  el.console.appendChild(line);
  el.console.scrollTop = el.console.scrollHeight;
}
const logOk = (m) => log(m, 'c-ok');
const logErr = (m) => log(m, 'c-err');
const logWarn = (m) => log(m, 'c-warn');
const logDim = (m) => log(m, 'c-dim');

function setProgress(done, total, label) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  el.progressBar.style.width = `${pct}%`;
  el.progressLabel.textContent = label ?? (total ? `${done}/${total}` : '');
}

// ── Settings persistence ─────────────────────────────────────────────────
function loadSettings() {
  el.apiKey.value = localStorage.getItem(LS.apiKey) || '';
  el.geminiKey.value = localStorage.getItem(LS.geminiKey) || '';
  el.transcriptModel.value = localStorage.getItem(LS.transcriptModel) || DEFAULTS.transcriptModel;
  el.ttsModel.value = localStorage.getItem(LS.ttsModel) || DEFAULTS.ttsModel;
  el.maxPages.value = localStorage.getItem(LS.maxPages) || DEFAULTS.maxPages;
  el.maxWidth.value = localStorage.getItem(LS.maxWidth) || DEFAULTS.maxWidth;
  el.bitrate.value = localStorage.getItem(LS.bitrate) || DEFAULTS.bitrate;
}
function bindSetting(input, key) {
  input.addEventListener('change', () => localStorage.setItem(key, input.value.trim()));
}
function settings() {
  return {
    apiKey: el.apiKey.value.trim(),
    geminiKey: el.geminiKey.value.trim(),
    transcriptModel: el.transcriptModel.value.trim() || DEFAULTS.transcriptModel,
    ttsModel: el.ttsModel.value.trim() || DEFAULTS.ttsModel,
    maxPages: Math.max(1, parseInt(el.maxPages.value, 10) || DEFAULTS.maxPages),
    maxWidth: Math.max(384, parseInt(el.maxWidth.value, 10) || DEFAULTS.maxWidth),
    bitrate: Math.min(320, Math.max(64, parseInt(el.bitrate.value, 10) || DEFAULTS.bitrate)),
  };
}

el.settingsToggle.addEventListener('click', () => {
  const open = el.settings.classList.toggle('hidden') === false;
  el.settingsToggle.setAttribute('aria-expanded', String(open));
});

// ── PDF handling ───────────────────────────────────────────────────────────
function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
['dragenter', 'dragover', 'dragleave', 'drop'].forEach((evt) =>
  el.dropZone.addEventListener(evt, preventDefaults));
['dragenter', 'dragover'].forEach((evt) =>
  el.dropZone.addEventListener(evt, () => el.dropZone.classList.add('dragover')));
['dragleave', 'drop'].forEach((evt) =>
  el.dropZone.addEventListener(evt, () => el.dropZone.classList.remove('dragover')));

el.dropZone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
el.dropZone.addEventListener('click', () => el.fileInput.click());
el.dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') el.fileInput.click(); });
el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files[0]));

async function handleFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    el.pdfInfo.textContent = 'That is not a PDF.';
    return;
  }
  state.pdfName = file.name;
  state.pdfPages = null;
  el.pdfInfo.textContent = `Loading "${file.name}"…`;
  el.genTranscriptBtn.disabled = true;
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    el.pdfInfo.textContent = `"${file.name}" — ${pdf.numPages} page(s). Ready to render on transcript.`;
    state.pdf = pdf;
    state.pdfName = file.name;
    el.genTranscriptBtn.disabled = false;
  } catch (err) {
    el.pdfInfo.textContent = `Failed to read PDF: ${err.message}`;
  }
}

async function renderPdfPages() {
  const { maxPages, maxWidth } = settings();
  const pdf = state.pdf;
  const count = Math.min(pdf.numPages, maxPages);
  if (pdf.numPages > maxPages) logWarn(`PDF has ${pdf.numPages} pages; reading only the first ${maxPages} (raise "Max pages" in settings).`);
  const pages = [];
  for (let n = 1; n <= count; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(maxWidth / base.width, 2.5);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    let text = '';
    try {
      const tc = await page.getTextContent();
      text = tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
    } catch { /* image-only page */ }
    pages.push({ page: n, dataUrl, text });
    logDim(`rendered page ${n}/${count}`);
  }
  state.pdfPages = pages;
  return pages;
}

// ── Transcript generation (Responses API) ────────────────────────────────
el.genTranscriptBtn.addEventListener('click', generateTranscript);

async function generateTranscript() {
  const cfg = settings();
  if (!cfg.apiKey) { setStatus(el.transcriptStatus, 'Add your API key in Settings.', 'err'); el.settings.classList.remove('hidden'); return; }
  if (!state.pdf) { setStatus(el.transcriptStatus, 'Load a PDF first.', 'err'); return; }

  el.genTranscriptBtn.disabled = true;
  el.stepAudio.classList.remove('hidden');
  el.console.textContent = '';
  setStatus(el.transcriptStatus, 'Rendering pages…', '');
  setProgress(0, 0, 'Rendering PDF…');

  try {
    const pages = await renderPdfPages();
    setStatus(el.transcriptStatus, `Sending ${pages.length} page(s) to ${cfg.transcriptModel}…`, '');
    log(`Requesting transcript from ${cfg.transcriptModel} (${pages.length} pages)…`);

    const content = [{ type: 'input_text', text: `This PDF has ${pages.length} page(s). Build the audiobook script.` }];
    for (const p of pages) {
      content.push({ type: 'input_text', text: `--- Page ${p.page} ---${p.text ? `\nEmbedded text: ${p.text}` : ''}` });
      content.push({ type: 'input_image', image_url: p.dataUrl, detail: 'auto' });
    }

    const body = {
      model: cfg.transcriptModel,
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content }],
      text: { format: { type: 'json_schema', name: 'tts_script', strict: true, schema: SCRIPT_SCHEMA } },
    };

    const resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(await describeHttpError(resp));
    const data = await resp.json();

    const jsonText = extractResponseText(data);
    if (!jsonText) throw new Error('Model returned no text output. Check the model ID supports vision + structured output.');
    const parsed = JSON.parse(jsonText);

    state.script = normalizeScript(parsed);
    persistScript();
    renderEditor();
    el.stepEdit.classList.remove('hidden');
    el.stepEdit.scrollIntoView({ behavior: 'smooth' });
    setStatus(el.transcriptStatus, `Done — ${state.script.items.length} line(s).`, 'ok');
    logOk(`Transcript ready: ${state.script.items.length} lines.`);
  } catch (err) {
    setStatus(el.transcriptStatus, err.message, 'err');
    logErr(`Transcript failed: ${err.message}`);
  } finally {
    el.genTranscriptBtn.disabled = false;
    setProgress(0, 0, '');
  }
}

// Walk the Responses API output for the first text payload.
function extractResponseText(data) {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      const parts = item?.content;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') return part.text;
      }
    }
  }
  // Fallback: some deployments return chat-completions shape.
  if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
  return null;
}

async function describeHttpError(resp) {
  let detail = '';
  try { const j = await resp.json(); detail = j.error?.message || JSON.stringify(j); }
  catch { detail = await resp.text().catch(() => ''); }
  return `OpenAI ${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ''}`;
}

// ── Script normalization ─────────────────────────────────────────────────
function normalizeScript(raw) {
  const script = { title: raw.title || state.pdfName || 'Audiobook', voices: [], items: [] };
  // voices may be an array of pairs or an object map
  if (Array.isArray(raw.voices)) {
    script.voices = raw.voices.map((v) => ({ speaker: String(v.speaker || ''), voice: pickVoice(v.voice) }));
  } else if (raw.voices && typeof raw.voices === 'object') {
    script.voices = Object.entries(raw.voices).map(([speaker, voice]) => ({ speaker, voice: pickVoice(voice) }));
  }
  const items = Array.isArray(raw.items) ? raw.items : Array.isArray(raw) ? raw : [];
  script.items = items.map((it, i) => ({
    id: String(it.id || `line_${String(i + 1).padStart(3, '0')}`),
    page: Number.isFinite(it.page) ? it.page : 0,
    panel: Number.isFinite(it.panel) ? it.panel : 0,
    type: ITEM_TYPES.includes(it.type) ? it.type : 'narration',
    speaker: String(it.speaker || 'narrator'),
    voice: pickVoice(it.voice),
    emotion: String(it.emotion || ''),
    instructions: String(it.instructions || ''),
    text: String(it.text || ''),
    pause_after_ms: Number.isFinite(it.pause_after_ms) ? it.pause_after_ms : 300,
  }));
  return script;
}
// Keep any recognized voice (either provider); otherwise fall back to the current provider's default.
function pickVoice(v) { return OPENAI_VOICES.includes(v) || GEMINI_VOICES.includes(v) ? v : defaultVoiceFor(el.ttsModel.value); }

// ── Persistence of script ──────────────────────────────────────────────────
let saveTimer = null;
function persistScript() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS.script, JSON.stringify(state.script));
      if (state.pdfName) localStorage.setItem(LS.pdfName, state.pdfName);
      el.saveStatus.textContent = 'Saved locally';
      el.saveStatus.className = 'status muted';
    } catch (e) {
      el.saveStatus.textContent = 'Save failed (storage full?)';
      el.saveStatus.className = 'status err';
    }
  }, 300);
}

function loadSavedScript() {
  const raw = localStorage.getItem(LS.script);
  if (!raw) return;
  try {
    state.script = normalizeScript(JSON.parse(raw));
    state.pdfName = localStorage.getItem(LS.pdfName);
    renderEditor();
    el.stepEdit.classList.remove('hidden');
    el.stepAudio.classList.remove('hidden');
    if (state.pdfName) el.pdfInfo.textContent = `Restored transcript for "${state.pdfName}". Drop a new PDF to start over.`;
  } catch { /* ignore corrupt */ }
}

// ── Transcript editor rendering ────────────────────────────────────────────
function renderEditor() {
  el.metaTitle.value = state.script.title || '';
  reconcileVoices();
  renderVoices();
  renderItems();
  syncRaw();
  updateProviderNote();
}

// Ensure every speaker used in items appears in the voice map (so all are auditionable).
function reconcileVoices() {
  const have = new Set(state.script.voices.map((v) => v.speaker));
  for (const it of state.script.items) {
    if (it.speaker && !have.has(it.speaker)) {
      state.script.voices.push({ speaker: it.speaker, voice: it.voice });
      have.add(it.speaker);
    }
  }
}

el.metaTitle.addEventListener('input', () => { state.script.title = el.metaTitle.value; persistScript(); syncRaw(); });

function voiceSelect(value, onChange) {
  const sel = document.createElement('select');
  const list = voicesFor(el.ttsModel.value);
  const options = list.includes(value) || !value ? list : [value, ...list]; // keep out-of-set value visible
  for (const v of options) {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = list.includes(v) ? v : `${v} (not in current provider)`;
    if (v === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function renderVoices() {
  el.voicesEditor.innerHTML = '';
  state.script.voices.forEach((pair, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'voice-pair';
    const speaker = document.createElement('input');
    speaker.type = 'text'; speaker.value = pair.speaker; speaker.placeholder = 'speaker';
    speaker.addEventListener('input', () => { pair.speaker = speaker.value; persistScript(); syncRaw(); });
    const sel = voiceSelect(pair.voice, (v) => { pair.voice = v; persistScript(); syncRaw(); });
    const preview = document.createElement('button');
    preview.className = 'btn ghost small preview-btn'; preview.type = 'button';
    preview.textContent = '▶'; preview.title = 'Audition this voice with one of the character’s lines';
    preview.addEventListener('click', () => {
      const sample = sampleForSpeaker(pair.speaker);
      previewVoice({ voice: pair.voice, instructions: sample.instructions, text: sample.text }, preview);
    });
    const del = document.createElement('button');
    del.className = 'del-row'; del.textContent = '✕'; del.title = 'Remove';
    del.addEventListener('click', () => { stopPreview(); state.script.voices.splice(idx, 1); renderVoices(); persistScript(); syncRaw(); });
    wrap.append(speaker, sel, preview, del);
    el.voicesEditor.appendChild(wrap);
  });
}
el.addVoiceBtn.addEventListener('click', () => {
  state.script.voices.push({ speaker: '', voice: defaultVoiceFor(el.ttsModel.value) });
  renderVoices(); persistScript(); syncRaw();
});

// Give each distinct speaker a distinct voice from the current provider's set (cycling if needed).
function autoAssignVoices() {
  const list = voicesFor(el.ttsModel.value);
  const speakers = [...new Set(state.script.items.map((i) => i.speaker).filter(Boolean))];
  const map = new Map(speakers.map((sp, i) => [sp, list[i % list.length]]));
  for (const it of state.script.items) if (map.has(it.speaker)) it.voice = map.get(it.speaker);
  for (const v of state.script.voices) if (map.has(v.speaker)) v.voice = map.get(v.speaker);
}

// Are all assigned voices valid for the current provider?
function voicesValidForProvider() {
  const list = voicesFor(el.ttsModel.value);
  return state.script.items.every((it) => list.includes(it.voice));
}

function updateProviderNote() {
  if (!el.providerNote) return;
  const prov = providerOf(el.ttsModel.value);
  el.providerNote.textContent = prov === 'gemini' ? 'Gemini voices' : 'OpenAI voices';
}

el.autoVoiceBtn?.addEventListener('click', () => {
  if (!state.script) return;
  autoAssignVoices();
  renderVoices(); renderItems(); persistScript(); syncRaw();
});

// Model change: persist, and re-map voices if the new provider uses a different voice set.
el.ttsModel.addEventListener('change', () => {
  localStorage.setItem(LS.ttsModel, el.ttsModel.value);
  if (state.script && !voicesValidForProvider()) {
    autoAssignVoices();
    setStatus(el.saveStatus, `Re-mapped voices to ${providerOf(el.ttsModel.value)} set`, 'muted');
  }
  if (state.script) { renderVoices(); renderItems(); persistScript(); syncRaw(); }
  updateProviderNote();
});

// ── Voice audition ─────────────────────────────────────────────────────────
const previewCache = new Map(); // key -> AudioBuffer
let previewCtx = null;          // shared AudioContext for decoding + playback
let currentPreview = null;      // { source, btn }

function getPreviewCtx() {
  if (!previewCtx) previewCtx = new (window.AudioContext || window.webkitAudioContext)();
  return previewCtx;
}

function sampleForSpeaker(speaker) {
  const it = state.script.items.find((i) => i.speaker === speaker && i.text.trim());
  if (it) return { text: truncateSentence(it.text, 220), instructions: it.instructions };
  return { text: `Hello, I'm ${speaker || 'this character'}. This is how my voice sounds in the audiobook.`, instructions: '' };
}

function stopPreview() {
  if (!currentPreview) return;
  try { currentPreview.source.stop(); } catch { /* already stopped */ }
  currentPreview.btn.textContent = '▶';
  currentPreview = null;
}

async function previewVoice({ voice, instructions, text }, btn) {
  const cfg = settings();
  const provider = providerOf(cfg.ttsModel);
  const keyMissing = provider === 'gemini' ? !cfg.geminiKey : !cfg.apiKey;
  if (keyMissing) {
    el.settings.classList.remove('hidden');
    setStatus(el.transcriptStatus, `Add your ${provider === 'gemini' ? 'Gemini' : 'OpenAI'} API key in Settings to preview voices.`, 'err');
    return;
  }
  // Clicking the button that's currently playing stops it.
  if (currentPreview && currentPreview.btn === btn) { stopPreview(); return; }
  stopPreview();

  btn.disabled = true; btn.textContent = '…';
  try {
    const ctx = getPreviewCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    const key = `${cfg.ttsModel}|${voice}|${instructions || ''}|${text}`;
    let buffer = previewCache.get(key);
    if (!buffer) {
      buffer = await synthesize(cfg, { voice, text, instructions }, ctx);
      previewCache.set(key, buffer);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => { if (currentPreview && currentPreview.source === source) stopPreview(); };
    btn.disabled = false; btn.textContent = '⏹';
    currentPreview = { source, btn };
    source.start();
  } catch (err) {
    btn.disabled = false; btn.textContent = '⚠';
    setStatus(el.transcriptStatus, `Preview failed: ${err.message}`, 'err');
    setTimeout(() => { if (btn.textContent === '⚠') btn.textContent = '▶'; }, 2200);
  }
}

function textInput(value, onChange, cls) {
  const inp = document.createElement('input');
  inp.type = 'text'; inp.value = value; if (cls) inp.className = cls;
  inp.addEventListener('input', () => { onChange(inp.value); persistScript(); syncRaw(); });
  return inp;
}
function numInput(value, onChange) {
  const inp = document.createElement('input');
  inp.type = 'number'; inp.value = value;
  inp.addEventListener('input', () => { onChange(parseInt(inp.value, 10) || 0); persistScript(); syncRaw(); });
  return inp;
}
function textArea(value, onChange) {
  const ta = document.createElement('textarea');
  ta.rows = 2; ta.value = value;
  ta.addEventListener('input', () => { onChange(ta.value); persistScript(); syncRaw(); });
  return ta;
}

function renderItems() {
  el.itemsBody.innerHTML = '';
  state.script.items.forEach((it, idx) => {
    const tr = document.createElement('tr');

    const cId = document.createElement('td'); cId.className = 'col-id'; cId.textContent = it.id;
    const cPg = document.createElement('td'); cPg.className = 'col-pg';
    cPg.appendChild(numInput(it.page, (v) => it.page = v));

    const cType = document.createElement('td');
    const typeSel = document.createElement('select');
    for (const t of ITEM_TYPES) { const o = document.createElement('option'); o.value = t; o.textContent = t; if (t === it.type) o.selected = true; typeSel.appendChild(o); }
    typeSel.addEventListener('change', () => { it.type = typeSel.value; persistScript(); syncRaw(); });
    cType.appendChild(typeSel);

    const cSpeaker = document.createElement('td'); cSpeaker.appendChild(textInput(it.speaker, (v) => it.speaker = v));
    const cVoice = document.createElement('td'); cVoice.appendChild(voiceSelect(it.voice, (v) => { it.voice = v; persistScript(); syncRaw(); }));
    const cEmotion = document.createElement('td'); cEmotion.appendChild(textInput(it.emotion, (v) => it.emotion = v));
    const cInstr = document.createElement('td'); cInstr.className = 'col-instr'; cInstr.appendChild(textArea(it.instructions, (v) => it.instructions = v));
    const cText = document.createElement('td'); cText.appendChild(textArea(it.text, (v) => it.text = v));
    const cPause = document.createElement('td'); cPause.className = 'col-pause'; cPause.appendChild(numInput(it.pause_after_ms, (v) => it.pause_after_ms = v));

    const cDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'del-row'; del.textContent = '✕'; del.title = 'Delete line';
    del.addEventListener('click', () => { state.script.items.splice(idx, 1); renderItems(); persistScript(); syncRaw(); });
    cDel.appendChild(del);

    tr.append(cId, cPg, cType, cSpeaker, cVoice, cEmotion, cInstr, cText, cPause, cDel);
    el.itemsBody.appendChild(tr);
  });
}

el.addLineBtn.addEventListener('click', () => {
  const n = state.script.items.length + 1;
  state.script.items.push({
    id: `line_${String(n).padStart(3, '0')}`, page: 0, panel: 0, type: 'narration',
    speaker: 'narrator', voice: defaultVoiceFor(el.ttsModel.value), emotion: '', instructions: '', text: '', pause_after_ms: 300,
  });
  renderItems(); persistScript(); syncRaw();
});

// ── Raw JSON sync ──────────────────────────────────────────────────────────
function syncRaw() { el.rawJson.value = JSON.stringify(state.script, null, 2); }
el.applyRawBtn.addEventListener('click', () => {
  try {
    const parsed = JSON.parse(el.rawJson.value);
    state.script = normalizeScript(parsed);
    renderEditor();
    persistScript();
    setStatus(el.rawStatus, 'Applied.', 'ok');
  } catch (e) {
    setStatus(el.rawStatus, `Invalid JSON: ${e.message}`, 'err');
  }
});

// ── Export / import JSON ─────────────────────────────────────────────────
el.downloadJsonBtn.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.script, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${slug(state.script.title)}.json`);
});
el.importJsonInput.addEventListener('change', async () => {
  const file = el.importJsonInput.files[0];
  if (!file) return;
  try {
    state.script = normalizeScript(JSON.parse(await file.text()));
    renderEditor(); persistScript();
    el.stepEdit.classList.remove('hidden'); el.stepAudio.classList.remove('hidden');
  } catch (e) { setStatus(el.rawStatus, `Import failed: ${e.message}`, 'err'); }
});

// ── Audiobook generation ─────────────────────────────────────────────────
el.genAudioBtn.addEventListener('click', generateAudiobook);
el.cancelAudioBtn.addEventListener('click', () => { state.cancel = true; logWarn('Cancelling after current line…'); });

async function generateAudiobook() {
  if (state.generating) return;
  stopPreview();
  const cfg = settings();
  const info = modelInfo(cfg.ttsModel);
  const needGemini = info.provider === 'gemini';
  if (needGemini ? !cfg.geminiKey : !cfg.apiKey) {
    el.settings.classList.remove('hidden');
    logErr(`Add your ${needGemini ? 'Gemini' : 'OpenAI'} API key in Settings.`);
    return;
  }
  if (!state.script?.items?.length) { logErr('No transcript to voice.'); return; }

  state.generating = true; state.cancel = false;
  el.genAudioBtn.disabled = true;
  el.cancelAudioBtn.classList.remove('hidden');
  el.downloadAudioBtn.classList.add('hidden');
  if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = null; }
  el.console.textContent = '';

  const items = state.script.items;
  log(`Starting audiobook: ${items.length} line(s), model ${cfg.ttsModel} (${info.provider}).`);
  if (!info.instructions && items.some((it) => it.instructions?.trim())) {
    logWarn(needGemini
      ? 'Gemini has no instructions field — delivery notes are folded into the spoken prompt text.'
      : `${cfg.ttsModel} ignores the "instructions" field (only gpt-4o-mini-tts is steerable).`);
  }
  const badVoices = items.filter((it) => !voicesFor(cfg.ttsModel).includes(it.voice));
  if (badVoices.length) logWarn(`${badVoices.length} line(s) have a voice not valid for ${info.provider} — click "Auto-assign distinct voices" to fix.`);
  setProgress(0, items.length, `0/${items.length}`);

  const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
  const segments = []; // { buffer, pauseMs }

  try {
    for (let i = 0; i < items.length; i++) {
      if (state.cancel) { logWarn('Cancelled.'); return; }
      const it = items[i];
      const label = `${it.id} · ${it.speaker}`;
      log(`▶ [${i + 1}/${items.length}] ${label} — "${truncate(it.text, 48)}"`);
      const t0 = performance.now();

      const audioBuf = await ttsWithRetry(cfg, it, decodeCtx);
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      logOk(`  ✓ ${label} (${audioBuf.duration.toFixed(1)}s audio, ${secs}s)`);

      segments.push({ buffer: audioBuf, pauseMs: Math.max(0, it.pause_after_ms | 0) });
      setProgress(i + 1, items.length, `${i + 1}/${items.length}`);
    }

    if (state.cancel) return;
    log('Stitching segments with pauses…');
    const mixed = await stitch(segments);
    log(`Encoding MP3 @ ${cfg.bitrate}kbps (${mixed.duration.toFixed(1)}s)…`);
    const blob = encodeMp3(mixed, cfg.bitrate);
    logOk(`MP3 ready: ${(blob.size / 1048576).toFixed(2)} MB.`);

    const filename = `${slug(state.script.title)}.mp3`;
    state.audioUrl = URL.createObjectURL(blob);
    el.downloadAudioBtn.href = state.audioUrl;
    el.downloadAudioBtn.download = filename;
    el.downloadAudioBtn.classList.remove('hidden');
    triggerDownload(blob, filename); // auto-download
    logOk(`Downloaded "${filename}". Done.`);
    setProgress(items.length, items.length, 'Complete');
  } catch (err) {
    logErr(`Failed: ${err.message}`);
    setStatus(el.progressLabel, '', '');
  } finally {
    decodeCtx.close();
    state.generating = false;
    el.genAudioBtn.disabled = false;
    el.cancelAudioBtn.classList.add('hidden');
  }
}

async function ttsWithRetry(cfg, item, decodeCtx, attempts = 3) {
  let lastErr;
  for (let a = 1; a <= attempts; a++) {
    try {
      return await synthesize(cfg, item, decodeCtx);
    } catch (err) {
      lastErr = err;
      if (a < attempts) { logWarn(`  retry ${a}/${attempts - 1}: ${err.message}`); await sleep(800 * a); }
    }
  }
  throw lastErr;
}

// Provider-agnostic: returns a decoded AudioBuffer for one line.
async function synthesize(cfg, item, ctx) {
  return providerOf(cfg.ttsModel) === 'gemini'
    ? synthGemini(cfg, item, ctx)
    : synthOpenAI(cfg, item, ctx);
}

async function synthOpenAI(cfg, { voice, text, instructions }, ctx) {
  const body = { model: cfg.ttsModel, voice, input: text, response_format: 'mp3' };
  if (instructions && modelInfo(cfg.ttsModel).instructions) body.instructions = instructions;
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(await describeHttpError(resp));
  const arr = await resp.arrayBuffer();
  return ctx.decodeAudioData(arr.slice(0)); // slice: decodeAudioData detaches the buffer
}

async function synthGemini(cfg, { voice, text, instructions }, ctx) {
  if (!cfg.geminiKey) throw new Error('Add your Gemini API key in Settings.');
  // Gemini has no separate instructions field — style is steered via the prompt text.
  const prompt = instructions ? `${instructions.trim()}:\n${text}` : text;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.ttsModel)}:generateContent?key=${encodeURIComponent(cfg.geminiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(await describeHttpError(resp));
  const data = await resp.json();
  const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new Error(`Gemini returned no audio${reason ? ` (${reason})` : ''}.`);
  }
  const rate = parseInt((part.inlineData.mimeType || '').match(/rate=(\d+)/)?.[1] || '24000', 10);
  return pcm16ToAudioBuffer(base64ToBytes(part.inlineData.data), rate, ctx);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Raw signed-16-bit little-endian PCM (mono) → AudioBuffer at the given sample rate.
function pcm16ToAudioBuffer(bytes, sampleRate, ctx) {
  const samples = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
  const buffer = ctx.createBuffer(1, samples || 1, sampleRate);
  const ch = buffer.getChannelData(0);
  for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
  return buffer;
}

// Concatenate decoded buffers with silence gaps into one mono 44.1k buffer.
async function stitch(segments) {
  const SR = 44100;
  let totalSec = 0;
  for (const s of segments) totalSec += s.buffer.duration + s.pauseMs / 1000;
  const length = Math.max(1, Math.ceil(totalSec * SR));
  const offline = new OfflineAudioContext(1, length, SR);
  let offset = 0;
  for (const s of segments) {
    const src = offline.createBufferSource();
    src.buffer = s.buffer; // auto-downmixed to mono + resampled to SR on render
    src.connect(offline.destination);
    src.start(offset);
    offset += s.buffer.duration + s.pauseMs / 1000;
  }
  return offline.startRendering();
}

function encodeMp3(buffer, kbps) {
  const SR = buffer.sampleRate;
  const samples = floatToInt16(buffer.getChannelData(0));
  const encoder = new lamejs.Mp3Encoder(1, SR, kbps);
  const block = 1152;
  const chunks = [];
  for (let i = 0; i < samples.length; i += block) {
    const buf = encoder.encodeBuffer(samples.subarray(i, i + block));
    if (buf.length) chunks.push(new Uint8Array(buf));
  }
  const end = encoder.flush();
  if (end.length) chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: 'audio/mpeg' });
}

function floatToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// ── Small helpers ──────────────────────────────────────────────────────────
function setStatus(node, msg, cls) { node.textContent = msg; node.className = `status ${cls || ''}`.trim(); }
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
function truncateSentence(s, max) {
  s = s.trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (stop > 40 ? cut.slice(0, stop + 1) : cut).trim() + '…';
}
function slug(s) { return (s || 'audiobook').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'audiobook'; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ── Init ─────────────────────────────────────────────────────────────────
loadSettings();
// ttsModel has its own change handler (provider switching), so it's not in this list.
[['apiKey', LS.apiKey], ['geminiKey', LS.geminiKey], ['transcriptModel', LS.transcriptModel],
 ['maxPages', LS.maxPages], ['maxWidth', LS.maxWidth], ['bitrate', LS.bitrate]]
  .forEach(([k, key]) => bindSetting(el[k], key));
updateProviderNote();
loadSavedScript();
