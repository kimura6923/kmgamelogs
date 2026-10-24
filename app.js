'use strict';

const STORAGE_KEY = 'gamelogs.v1';
const EXTEND_MIN = 5;
const WARN_BEFORE_MS = 60 * 1000;
const MAX_NAME_CHIPS = 8;
const MINUTE_CHOICES = [10, 15, 30, 45, 60];
const MINUTE_COLORS = ['#caffbf', '#fdffb6', '#ffd6a5', '#ffadad', '#bdb2ff'];
const NAME_COLORS = ['#ff4d6d', '#3a86ff', '#8338ec', '#06a77d', '#ff8500', '#118ab2', '#d63384'];
const KINDS = [
  { id: 'switch2', cat: 'play', label: 'Switch 2', say: 'スイッチツー', icon: '🎮', verb: 'あそぶ', color: '#e63946', dark: '#a4161a' },
  { id: 'switch', cat: 'play', label: 'Switch', say: 'スイッチ', icon: '🕹️', verb: 'あそぶ', color: '#3a86ff', dark: '#1f5fcc' },
  { id: 'video', cat: 'play', label: '動画', say: 'どうが', icon: '📺', verb: 'みる', color: '#ff9e00', dark: '#c76d00' },
  { id: 'study', cat: 'study', label: '勉強', say: 'べんきょう', icon: '📚', verb: 'する', color: '#06a77d', dark: '#047857' },
];
// きょうの合計は「あそび」と「べんきょう」を分けて出す
const CATS = [
  { id: 'play', label: 'あそび', icon: '🎮', color: '#ff8500' },
  { id: 'study', label: 'べんきょう', icon: '📚', color: '#06a77d' },
];
const STEP_PROMPTS = {
  kind: 'なにをする？',
  name: 'だれがやるの？',
  minutes: 'なんぷんやる？',
};
const ALARM_REPEAT_MS = 20 * 1000;
const RING_C = 2 * Math.PI * 52;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ---------- 保存 ----------

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (data && Array.isArray(data.sessions)) return data;
  } catch (e) {
    console.warn('記録の読み込みに失敗しました', e);
  }
  return { sessions: [] };
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('記録の保存に失敗しました', e);
  }
}

let state = load();

// 別タブで変更されたら取り込む
window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    state = load();
    render();
  }
});

// ---------- 音 ----------

let audioCtx = null;

// iPhone はマナーモード（消音スイッチ）だと Web Audio の音が消えるので、
// 「音楽再生」扱いにしてマナーモードでも鳴るようにする（iOS 16.4 以降）
function setAudioSession(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch (e) {
    // 非対応なら何もしない
  }
}
setAudioSession('playback');

// iOS/Safari などはユーザー操作の中で AudioContext を作らないと音が出ないため、
// 最初のタップで準備しておく。iOS では touchstart/pointerdown は「ユーザー操作」と
// みなされないので、touchend と click で行う
function unlockAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state !== 'running') audioCtx.resume();
  unlockSpeech();
}
document.addEventListener('touchend', unlockAudio);
document.addEventListener('click', unlockAudio);
document.addEventListener('keydown', unlockAudio);

function beep(freq, startOffset, duration, volume, type = 'square') {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + startOffset;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.setValueAtTime(volume, t + duration - 0.02);
  gain.gain.linearRampToValueAtTime(0, t + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

// 時間切れ：ピピピッ
function playAlarm() {
  for (let i = 0; i < 3; i++) beep(1760, i * 0.18, 0.12, 0.25);
}

// 残り1分：ポーン
function playWarning() {
  beep(880, 0, 0.25, 0.15);
  beep(660, 0.3, 0.4, 0.15);
}

// えらんだとき：ポッ
function playPop() {
  beep(1046, 0, 0.07, 0.12, 'triangle');
  beep(1568, 0.06, 0.08, 0.1, 'triangle');
}

// スタート：ドミソド
function playJingle() {
  [523, 659, 784].forEach((f, i) => beep(f, i * 0.11, 0.1, 0.15, 'triangle'));
  beep(1046, 0.33, 0.3, 0.15, 'triangle');
}

// ---------- 読み上げ ----------

const SPEAK_KEY = 'gamelogs.speak';
const canSpeak = 'speechSynthesis' in window;
let speakEnabled = (() => {
  try {
    return localStorage.getItem(SPEAK_KEY) !== 'off';
  } catch (e) {
    return true;
  }
})();
let jaVoice = null;

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith('ja'));
  jaVoice = voices.find((v) => /Kyoko|O-ren|Google/.test(v.name)) || voices[0] || null;
}
if (canSpeak) {
  pickVoice();
  // 古い iOS の speechSynthesis は addEventListener を持たないのでプロパティで登録する
  speechSynthesis.onvoiceschanged = pickVoice;
}

const isSpeaking = () => canSpeak && speechSynthesis.speaking;
let speechUnlocked = false;

// iOS はタップの中で一度しゃべらせないと、その後タイマーなどからしゃべれないので、
// 最初のタップで無音の読み上げをしておく
function unlockSpeech() {
  if (!canSpeak || speechUnlocked) return;
  speechUnlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

function speak(text) {
  // 音声入力中にしゃべると自分の声を聞き取ってしまうのでしゃべらない
  if (!canSpeak || !speakEnabled || recognition) return;
  // Safari は cancel() の直後の speak() を落とすことがあるので、しゃべっているときだけ止める
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
  speechSynthesis.resume();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  if (jaVoice) u.voice = jaVoice;
  u.rate = 1.05;
  u.pitch = 1.3;
  speechSynthesis.speak(u);
}

// ---------- 画面スリープ防止 ----------

let wakeLock = null;

async function updateWakeLock(needed) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (needed && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!needed && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (e) {
    // 非対応・拒否された場合は何もしない
  }
}

// ---------- ユーティリティ ----------

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

// replaceChildren は iOS 14 未満にないので自前で入れ替える
function setChildren(node, ...children) {
  node.textContent = '';
  node.append(...children);
}

const pad = (n) => String(n).padStart(2, '0');

function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDate(ms) {
  const d = new Date(ms);
  const w = '日月火水木金土'[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${w})`;
}

function fmtRemain(ms) {
  const s = Math.floor(Math.abs(ms) / 1000);
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

function isSameDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

const findKind = (id) => KINDS.find((k) => k.id === id);

// 古い iOS は ?. や ?? を読めないので使わない
function isStudy(s) {
  const k = findKind(s.kind);
  return !!k && k.cat === 'study';
}

function kindText(id) {
  const k = findKind(id);
  return k ? `${k.icon} ${k.label}` : '-';
}

function kindIcon(id) {
  const k = findKind(id);
  return k ? k.icon : '⏱️';
}

// 名前ごとにいつも同じ色
function nameColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

const elapsedMin = (s, now) => Math.round(((s.stoppedAt != null ? s.stoppedAt : now) - s.startAt) / 60000);
const isRunning = (s) => s.stoppedAt == null;
const isOver = (s, now) => isRunning(s) && now >= s.endAt;

function recentNames() {
  const names = [];
  for (let i = state.sessions.length - 1; i >= 0 && names.length < MAX_NAME_CHIPS; i--) {
    const n = state.sessions[i].name;
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

function bounce(node) {
  node.classList.remove('boing');
  void node.offsetWidth; // アニメーションをやり直すため
  node.classList.add('boing');
}

function celebrate(origin) {
  if (reduceMotion.matches) return;
  const r = origin.getBoundingClientRect();
  const items = ['⭐', '🎉', '✨', '🎈', '💫', '🌟'];
  for (let i = 0; i < 26; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 90 + Math.random() * 140;
    const piece = el('span', { class: 'confetti', text: items[i % items.length] });
    piece.style.left = `${r.left + r.width / 2}px`;
    piece.style.top = `${r.top + r.height / 2}px`;
    piece.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    piece.style.setProperty('--dy', `${Math.sin(angle) * dist - 60}px`);
    piece.style.setProperty('--r', `${Math.random() * 360 - 180}deg`);
    piece.addEventListener('animationend', () => piece.remove());
    document.body.append(piece);
  }
}

// ---------- 操作 ----------

function startSession(name, kind, minutes) {
  const now = Date.now();
  state.sessions.push({
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    kind,
    minutes,
    extended: 0,
    startAt: now,
    endAt: now + minutes * 60000,
    stoppedAt: null,
    warned: false,
  });
  save();
  render();
}

function findSession(id) {
  return state.sessions.find((s) => s.id === id);
}

function stopSession(id) {
  const s = findSession(id);
  if (!s || !isRunning(s)) return;
  s.stoppedAt = Date.now();
  save();
  render();
  speak(`${s.name}さん、おつかれさま！`);
}

function extendSession(id) {
  const s = findSession(id);
  if (!s || !isRunning(s)) return;
  // 時間切れ後に延長した場合は「今から5分」
  s.endAt = Math.max(s.endAt, Date.now()) + EXTEND_MIN * 60000;
  s.extended += EXTEND_MIN;
  s.warned = false;
  save();
  render();
  speak(`${s.name}さん、あと${EXTEND_MIN}分ね。`);
}

function deleteSession(id) {
  const s = findSession(id);
  if (!s) return;
  if (!confirm(`${fmtDate(s.startAt)} ${s.name} の記録を消しますか？`)) return;
  state.sessions = state.sessions.filter((x) => x.id !== id);
  save();
  render();
}

// ---------- 入力ステップ（なにをする → だれ → なんぷん → スタート） ----------

const form = $('#start-form');
const nameInput = $('#name');
const minutesInput = $('#minutes');
const STEPS = ['kind', 'name', 'minutes', 'ready'];
let selectedKind = null;
let step = 'kind';

const formName = () => nameInput.value.trim();
const formMinutes = () => {
  const m = parseInt(minutesInput.value, 10);
  return m > 0 && m <= 600 ? m : null;
};

function nextMissing() {
  if (!selectedKind) return 'kind';
  if (!formName()) return 'name';
  if (!formMinutes()) return 'minutes';
  return 'ready';
}

function goStep(s, { silent = false } = {}) {
  step = s;
  renderSteps();
  if (!silent) speak(s === 'ready' ? readySentence() : STEP_PROMPTS[s]);
  // 名前の候補がないときだけキーボードを出す
  if (s === 'name' && !document.querySelector('#name-chips button')) nameInput.focus();
}

function advance(delay = 0) {
  setTimeout(() => goStep(nextMissing()), reduceMotion.matches ? 0 : delay);
}

function renderSteps() {
  const answers = {
    kind: selectedKind ? kindText(selectedKind) : '',
    name: formName(),
    minutes: formMinutes() ? `${formMinutes()}分` : '',
  };
  for (const node of document.querySelectorAll('.step')) {
    const s = node.dataset.step;
    node.classList.toggle('active', s === step);
    node.classList.toggle('done', s !== step && !!answers[s]);
    const ans = node.querySelector('.ans');
    if (ans) ans.textContent = answers[s] || '';
  }

  for (const b of document.querySelectorAll('#kind-chips button')) {
    b.classList.toggle('selected', b.dataset.kind === selectedKind);
  }
  for (const b of document.querySelectorAll('#name-chips button')) {
    b.classList.toggle('selected', b.dataset.name === formName());
  }
  for (const b of document.querySelectorAll('#minute-chips button')) {
    b.classList.toggle('selected', Number(b.dataset.min) === formMinutes());
  }

  if (step === 'ready') renderReadyText();
}

function readySentence() {
  const kind = findKind(selectedKind);
  return `${formName()}が、${kind.say}を、${formMinutes()}分${kind.verb}！ よければスタートをおしてね`;
}

function renderReadyText() {
  const kind = findKind(selectedKind);
  const pill = (text, color) => {
    const p = el('span', { class: 'pill', text });
    p.style.background = color;
    return p;
  };
  setChildren($('#ready-text'),
    pill(formName(), nameColor(formName())), ' が', el('br'),
    pill(`${kind.icon} ${kind.label}`, kind.color), ' を ',
    pill(`${formMinutes()}分`, '#2b2d42'), ` ${kind.verb}！`,
  );
}

function resetForm({ silent = false } = {}) {
  selectedKind = null;
  nameInput.value = '';
  minutesInput.value = '';
  voiceStatus.hidden = true;
  goStep('kind', { silent });
}

setChildren($('#kind-chips'), ...KINDS.map((k, i) => {
  const b = el('button', { type: 'button', 'data-kind': k.id }, [
    el('span', { class: 'icon', text: k.icon }),
    el('span', { text: k.label }),
  ]);
  b.style.setProperty('--kc', k.color);
  b.style.setProperty('--kd', k.dark);
  b.style.setProperty('--i', i);
  return b;
}));

setChildren($('#minute-chips'), ...MINUTE_CHOICES.map((m, i) => {
  const b = el('button', { type: 'button', 'data-min': m }, [String(m), el('small', { text: '分' })]);
  b.style.setProperty('--mc', MINUTE_COLORS[i % MINUTE_COLORS.length]);
  b.style.setProperty('--i', i);
  return b;
}));

for (const head of document.querySelectorAll('.step-head')) {
  head.addEventListener('click', () => {
    const s = head.closest('.step').dataset.step;
    if (s !== step) goStep(s);
  });
}

$('#kind-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  selectedKind = b.dataset.kind;
  playPop();
  bounce(b);
  renderSteps();
  advance(450);
});

$('#name-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  nameInput.value = b.dataset.name;
  playPop();
  bounce(b);
  renderSteps();
  advance(450);
});

$('#minute-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  minutesInput.value = b.dataset.min;
  playPop();
  bounce(b);
  renderSteps();
  advance(450);
});

nameInput.addEventListener('input', renderSteps);
minutesInput.addEventListener('input', renderSteps);

function confirmStep(s) {
  if (s === 'name' && !formName()) return nameInput.focus();
  if (s === 'minutes' && !formMinutes()) return minutesInput.focus();
  playPop();
  nameInput.blur();
  minutesInput.blur();
  advance();
}

for (const b of document.querySelectorAll('[data-next]')) {
  b.addEventListener('click', () => confirmStep(b.dataset.next));
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  // 入力欄で Enter を押したときは「けってい」と同じ
  if (step !== 'ready') {
    if (step === 'name' || step === 'minutes') confirmStep(step);
    return;
  }
  const missing = nextMissing();
  if (missing !== 'ready') return goStep(missing);

  const name = formName();
  if (state.sessions.some((s) => isRunning(s) && s.name === name)) {
    alert(`${name} さんはもうタイマーが動いています`);
    return;
  }
  unlockAudio();
  playJingle();
  celebrate(form.querySelector('.start-btn'));
  const cheer = findKind(selectedKind).cat === 'study' ? 'がんばってね！' : 'たのしんでね！';
  speak(`スタート！ ${formMinutes()}分たったら、おしらせするね。${cheer}`);
  startSession(name, selectedKind, formMinutes());
  resetForm({ silent: true });
});

$('#reset-form').addEventListener('click', () => resetForm());

$('#clear-history').addEventListener('click', () => {
  if (!state.sessions.some((s) => !isRunning(s))) return;
  if (!confirm('終わった記録をすべて消しますか？（動いているタイマーは残ります）')) return;
  state.sessions = state.sessions.filter(isRunning);
  save();
  render();
});

// ---------- 音声入力 ----------

const KIND_PATTERNS = [
  ['study', /勉強|べんきょう|宿題|しゅくだい|ドリル|読書|どくしょ|音読|おんどく/],
  ['switch2', /(スイッチ|すいっち|switch)\s*(2|二|ツー|つー|two)/i],
  ['switch', /スイッチ|すいっち|switch/i],
  ['video', /動画|どうが|ユーチューブ|youtube|ようつべ|ビデオ|テレビ/i],
];
const TIME_PATTERNS = [
  /(\d+)\s*時間\s*(半)?/,
  /(\d+)\s*(分|ふん|ぷん)/,
];
const KANJI_DIGITS = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function kanjiToNumber(str) {
  let total = 0;
  let cur = 0;
  for (const ch of str) {
    if (ch in KANJI_DIGITS) cur = KANJI_DIGITS[ch];
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
  }
  return total + cur;
}

// 全角数字と「三十分」のような漢数字を半角数字にそろえる
function normalizeNumbers(text) {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[〇零一二三四五六七八九十百]+(?=\s*(分|ふん|ぷん|時間))/g, kanjiToNumber);
}

const stripNameEdge = (s) => s
  .replace(/^[\s、。,.]+/, '')
  .replace(/(さん|くん|ちゃん)?[\s、。,.]*(が|は)?[\s、。,.!！]*(やります|やる|みます|見ます|します)?[\s、。,.!！]*$/, '')
  .trim();

// 例：「たろうがスイッチ2を30分やります」→ { name: 'たろう', kind: 'switch2', minutes: 30 }
function parseVoice(raw) {
  const text = normalizeNumbers(raw.trim());
  const spans = [];

  let kind = null;
  for (const [id, re] of KIND_PATTERNS) {
    const m = text.match(re);
    if (m) {
      kind = id;
      spans.push([m.index, m.index + m[0].length]);
      break;
    }
  }

  let minutes = 0;
  for (const re of TIME_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    minutes += re === TIME_PATTERNS[0] ? parseInt(m[1], 10) * 60 + (m[2] ? 30 : 0) : parseInt(m[1], 10);
    spans.push([m.index, m.index + m[0].length]);
  }
  if (!minutes) {
    // 「30」だけ言った場合（スイッチ2 の 2 は除く）
    const masked = spans.reduce((t, [a, b]) => t.slice(0, a) + ' '.repeat(b - a) + t.slice(b), text);
    const m = masked.match(/\d+/);
    if (m) {
      minutes = parseInt(m[0], 10);
      spans.push([m.index, m.index + m[0].length]);
    }
  }

  // 名前：これまでに使った名前が入っていればそれを優先、なければ最初（または最後）の部分
  const known = [...new Set(state.sessions.map((s) => s.name))].sort((a, b) => b.length - a.length);
  let name = known.find((n) => text.includes(n)) || '';
  if (!name) {
    const first = spans.length ? Math.min(...spans.map((s) => s[0])) : text.length;
    const last = spans.length ? Math.max(...spans.map((s) => s[1])) : text.length;
    name = stripNameEdge(text.slice(0, first)) || stripNameEdge(text.slice(last));
  }

  return { name: name.slice(0, 20), kind, minutes: minutes > 0 && minutes <= 600 ? minutes : null };
}

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const voiceBtn = $('#voice-btn');
const voiceStatus = $('#voice-status');
const VOICE_LABEL = '🎤 こえでいう';
let recognition = null;

function setVoiceStatus(text, isError = false) {
  voiceStatus.hidden = false;
  voiceStatus.textContent = text;
  voiceStatus.classList.toggle('error', isError);
}

function applyVoice(transcript) {
  const r = parseVoice(transcript);
  if (r.name) nameInput.value = r.name;
  if (r.kind) selectedKind = r.kind;
  if (r.minutes) minutesInput.value = String(r.minutes);
  playPop();

  // 先にタップで選んであった項目は「わからなかった」に入れない
  const missing = [!selectedKind && 'なに', !formName() && 'だれ', !formMinutes() && 'なんぷん'].filter(Boolean);
  const tail = missing.length
    ? `　→ ${missing.join('・')} がわからなかったよ。えらんでね`
    : '　→ OK！';
  setVoiceStatus(`「${transcript}」${tail}`, missing.length > 0);
  goStep(nextMissing());
}

const VOICE_ERRORS = {
  'not-allowed': 'マイクが使えません。マイクと音声認識の許可を確認してください（iPhone：設定 → アプリ → Safari → マイク）',
  'service-not-allowed': '音声入力が使えません。iPhone の場合は 設定 → 一般 → キーボード →「音声入力」をオンにしてください',
  'no-speech': 'きこえなかったよ。もう一度どうぞ',
  'audio-capture': 'マイクが見つかりません',
  network: '音声入力にはインターネット接続が必要です',
};

if (SpeechRecognition) {
  voiceBtn.hidden = false;

  voiceBtn.addEventListener('click', () => {
    if (recognition) {
      recognition.stop();
      return;
    }
    if (canSpeak) speechSynthesis.cancel();
    // マイクを使う間は録音もできる設定に切り替える
    setAudioSession('play-and-record');
    recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.interimResults = true;
    recognition.continuous = false;
    let heard = '';

    recognition.onresult = (e) => {
      heard = [...e.results].map((r) => r[0].transcript).join('');
      setVoiceStatus(`「${heard}」`);
    };
    recognition.onerror = (e) => {
      if (e.error !== 'aborted') setVoiceStatus(VOICE_ERRORS[e.error] || `音声入力でエラーが起きました（${e.error}）`, true);
    };
    // iPhone では isFinal が来ないまま終わることがあるので、終わったときに最後に聞こえた文を使う。
    // 聞き取り中は読み上げしないので、ここで反映すると次の問いかけもしゃべれる
    recognition.onend = () => {
      recognition = null;
      setAudioSession('playback');
      voiceBtn.classList.remove('listening');
      voiceBtn.textContent = VOICE_LABEL;
      if (heard.trim()) applyVoice(heard.trim());
    };

    recognition.start();
    voiceBtn.classList.add('listening');
    voiceBtn.textContent = '👂 きいてるよ…';
    setVoiceStatus('「たろう、スイッチ2、30分」みたいに話してね');
  });
}

// ---------- アラーム ----------

const alarmEl = $('#alarm');
let alarmTargetId = null;

$('#alarm-stop').addEventListener('click', () => alarmTargetId && stopSession(alarmTargetId));
$('#alarm-extend').addEventListener('click', () => alarmTargetId && extendSession(alarmTargetId));

function renderAlarm(now) {
  const target = state.sessions.find((s) => isOver(s, now));
  alarmTargetId = target ? target.id : null;
  alarmEl.hidden = !target;
  if (target) {
    const kind = findKind(target.kind);
    const what = kind ? `${kind.label}の` : '';
    const praise = isStudy(target) ? 'よくがんばったね！🎉' : '';
    $('#alarm-text').textContent = `${target.name} さん、${what}${target.minutes + target.extended}分がたちました！${praise}`;
    $('#alarm-extend').textContent = isStudy(target) ? 'もうちょっとやる！💪' : 'あと5分だけ…🙏';
    $('.alarm-emoji').textContent = isStudy(target) ? '🎉' : '⏰';
  }
}

// ---------- 描画 ----------

function renderNameChips() {
  setChildren($('#name-chips'), ...recentNames().map((n, i) => {
    const b = el('button', { type: 'button', 'data-name': n, text: n });
    b.style.setProperty('--nc', nameColor(n));
    b.style.setProperty('--i', i);
    return b;
  }));
}

// 毎秒作り直すとアニメーションが最初からになるので、カードは使い回して中身だけ更新する
const runningItems = new Map();

function createRunningItem(s) {
  const li = el('li');
  li.innerHTML = `
    <div class="ring-wrap">
      <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
        <circle class="track" cx="60" cy="60" r="52"></circle>
        <circle class="prog" cx="60" cy="60" r="52" stroke-dasharray="${RING_C}"></circle>
      </svg>
      <div class="ring-center"><span class="emoji"></span><span class="remain"></span></div>
    </div>
    <div class="info">
      <div class="who"></div>
      <div class="what"></div>
      <div class="meta"></div>
      <div class="actions">
        <button type="button" data-act="stop">おわる</button>
        <button type="button" data-act="extend">+${EXTEND_MIN}分</button>
      </div>
    </div>`;
  const kind = findKind(s.kind);
  li.style.setProperty('--kc', kind ? kind.color : '#8d99ae');
  li.style.setProperty('--kd', kind ? kind.dark : '#5c677d');
  li.querySelector('.emoji').textContent = kind ? kind.icon : '⏱️';
  li.querySelector('.who').textContent = `${s.name} さん`;
  li.querySelector('.what').textContent = kind ? `${kind.label}を${kind.verb}` : '';
  li.querySelector('[data-act="stop"]').addEventListener('click', () => stopSession(s.id));
  li.querySelector('[data-act="extend"]').addEventListener('click', () => extendSession(s.id));
  return li;
}

function renderRunning(now) {
  const list = $('#running-list');
  const running = state.sessions.filter(isRunning);
  $('#no-running').hidden = running.length > 0;

  for (const [id, li] of runningItems) {
    if (!running.some((s) => s.id === id)) {
      li.remove();
      runningItems.delete(id);
    }
  }

  for (const s of running) {
    let li = runningItems.get(s.id);
    if (!li) {
      li = createRunningItem(s);
      runningItems.set(s.id, li);
      list.append(li);
    }
    const remain = s.endAt - now;
    const frac = Math.min(1, Math.max(0, remain / (s.endAt - s.startAt)));
    const cls = remain <= 0 ? 'over' : remain <= WARN_BEFORE_MS ? 'soon' : '';
    if (li.dataset.state !== cls) {
      li.className = cls;
      li.dataset.state = cls;
    }
    li.querySelector('.remain').textContent = remain <= 0 ? 'じかん！' : fmtRemain(remain);
    li.querySelector('.prog').style.strokeDashoffset = remain <= 0 ? 0 : RING_C * (1 - frac);
    const declared = s.extended ? `${s.minutes}分 (+${s.extended}分)` : `${s.minutes}分`;
    li.querySelector('.meta').textContent = `${declared}　${fmtTime(s.startAt)}〜${fmtTime(s.endAt)}`;
  }
}

function renderTodayTotals(now) {
  // name → cat → { min, byKind }
  const totals = new Map();
  for (const s of state.sessions) {
    if (!isSameDay(s.startAt, now)) continue;
    const cat = isStudy(s) ? 'study' : 'play';
    if (!totals.has(s.name)) totals.set(s.name, new Map());
    const byCat = totals.get(s.name);
    const t = byCat.get(cat) || { min: 0, byKind: new Map() };
    const m = elapsedMin(s, now);
    t.min += m;
    t.byKind.set(s.kind, (t.byKind.get(s.kind) || 0) + m);
    byCat.set(cat, t);
  }
  $('#no-today').hidden = totals.size > 0;
  const max = Math.max(30, ...[...totals.values()].flatMap((byCat) => [...byCat.values()].map((t) => t.min)));

  setChildren($('#today-totals'), ...[...totals].map(([name, byCat]) => {
    const rows = CATS.filter((c) => byCat.has(c.id)).flatMap((c) => {
      const t = byCat.get(c.id);
      const fill = el('span');
      fill.style.width = `${(t.min / max) * 100}%`;
      fill.style.background = c.color;
      const row = [
        el('span', { class: 'label', text: `${c.icon} ${c.label}` }),
        el('div', { class: 'bar' }, [fill]),
        el('span', { class: 'min', text: `${t.min}分` }),
      ];
      // あそびは何に使ったかの内訳も出す
      if (c.id === 'play') {
        row.push(el('span', {
          class: 'breakdown',
          text: [...t.byKind].map(([k, m]) => `${kindIcon(k)}${m}分`).join('　'),
        }));
      }
      return row;
    });
    const li = el('li', {}, [el('span', { class: 'name', text: name }), ...rows]);
    li.style.setProperty('--nc', nameColor(name));
    return li;
  }));
}

function renderHistory(now) {
  const done = state.sessions.filter((s) => !isRunning(s)).reverse();
  $('#no-history').hidden = done.length > 0;
  $('#history').hidden = done.length === 0;

  setChildren($('#history tbody'), ...done.map((s) => {
    const actual = elapsedMin(s, now);
    const planned = s.minutes + s.extended;
    const diffCls = actual > planned ? 'num over' : actual < planned ? 'num under' : 'num';
    return el('tr', {}, [
      el('td', { text: fmtDate(s.startAt) }),
      el('td', { text: s.name }),
      el('td', { text: kindText(s.kind) }),
      el('td', { class: 'num', text: s.extended ? `${s.minutes}+${s.extended}分` : `${s.minutes}分` }),
      el('td', { text: fmtTime(s.startAt) }),
      el('td', { text: fmtTime(s.stoppedAt) }),
      el('td', { class: diffCls, text: `${actual}分` }),
      el('td', {}, [el('button', { type: 'button', text: '×', title: '消す', onclick: () => deleteSession(s.id) })]),
    ]);
  }));
}

let lastStructure = '';

function render() {
  const now = Date.now();
  // 記録の中身が変わったときだけ重い部分を描き直す
  const structure = JSON.stringify(state.sessions.map((s) => [s.id, s.endAt, s.stoppedAt]));
  if (structure !== lastStructure) {
    lastStructure = structure;
    renderNameChips();
    renderSteps();
    renderHistory(now);
  }
  renderRunning(now);
  renderTodayTotals(now);
  renderAlarm(now);
  updateWakeLock(state.sessions.some(isRunning));
}

// ---------- 1秒ごとの処理 ----------

function tick() {
  const now = Date.now();
  let changed = false;

  for (const s of state.sessions) {
    if (isRunning(s) && !s.warned && s.endAt - now <= WARN_BEFORE_MS && s.endAt > now) {
      s.warned = true;
      changed = true;
      playWarning();
      speak(`${s.name}さん、あと1分だよ。`);
    }
  }
  if (changed) save();

  const over = state.sessions.find((s) => isOver(s, now));
  if (over) {
    // 時間切れになったときと、その後20秒ごとに声でも知らせる
    if (lastAlarmSpeech.id !== over.id || now - lastAlarmSpeech.at >= ALARM_REPEAT_MS) {
      lastAlarmSpeech = { id: over.id, at: now };
      const kind = findKind(over.kind);
      speak(isStudy(over)
        ? `${over.name}さん、べんきょう${over.minutes + over.extended}分、よくがんばったね！ おつかれさま！`
        : `${over.name}さん、${kind ? kind.say + 'の' : ''}じかんが、おわったよ！ おしまいにしよう！`);
    }
    // しゃべっている間はピピピを止めて声を聞こえやすくする
    if (!isSpeaking()) playAlarm();
  }
  render();
}

let lastAlarmSpeech = { id: null, at: 0 };

// 読み上げのオン・オフ（お試し用）
const speakBtn = $('#speak-btn');

function renderSpeakBtn() {
  speakBtn.textContent = speakEnabled ? '🔊' : '🔇';
  speakBtn.title = speakEnabled ? 'よみあげ：オン' : 'よみあげ：オフ';
  speakBtn.classList.toggle('off', !speakEnabled);
}

if (canSpeak) {
  speakBtn.hidden = false;
  renderSpeakBtn();
  speakBtn.addEventListener('click', () => {
    speakEnabled = !speakEnabled;
    try {
      localStorage.setItem(SPEAK_KEY, speakEnabled ? 'on' : 'off');
    } catch (e) {
      // 保存できなくてもこの画面では切り替わる
    }
    renderSpeakBtn();
    if (speakEnabled) speak(`よみあげオン！ ${step === 'ready' ? readySentence() : STEP_PROMPTS[step]}`);
    else speechSynthesis.cancel();
  });
}

// タブが裏から戻ってきたときにすぐ反映（裏に回ると wakeLock は解除されるので取り直す）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') tick();
});

render();
setInterval(tick, 1000);
