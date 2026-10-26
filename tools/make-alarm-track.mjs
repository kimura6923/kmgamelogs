// iPhone で画面ロック中・別アプリ中でもアラームを鳴らすための音声ファイルを作る。
//
// iOS Safari はバックグラウンドでページの JavaScript を止めるが、<audio> の再生は続く。
// そこで「長い無音 → 1分前の予告音 → アラーム」というファイルを用意し、
// アプリ側で「残り時間」だけ手前の位置から再生すれば、終了時刻ぴったりにアラームが鳴る。
//
// 使い方（ffmpeg が必要）:
//   node tools/make-alarm-track.mjs | ffmpeg -f s16le -ar 16000 -ac 1 -i - -c:a libmp3lame -b:a 8k alarm-track.mp3
//
// 長さや鳴る位置を変えたら app.js の TRACK_ALARM_AT / TRACK_TAIL も合わせること。

const RATE = 16000;
const ALARM_AT = 120 * 60; // ここ（秒）で時間切れのアラームが始まる
const TAIL = 5 * 60; // アラームを鳴らし続ける長さ（秒）
const TOTAL = ALARM_AT + TAIL;

// [開始秒, 長さ秒, 周波数, 音量]
const tones = [
  // 残り1分：ポーン
  [ALARM_AT - 60, 0.25, 880, 0.5],
  [ALARM_AT - 60 + 0.3, 0.4, 660, 0.5],
];
// 時間切れ：1秒ごとにピピピッ
for (let t = ALARM_AT; t < TOTAL - 1; t += 1) {
  for (let i = 0; i < 3; i++) tones.push([t + i * 0.18, 0.12, 1760, 0.8]);
}

const out = process.stdout;
const chunk = Buffer.alloc(RATE * 2); // 1秒ぶん
let ti = 0;

function writeSecond(sec) {
  chunk.fill(0);
  while (ti < tones.length && tones[ti][0] + tones[ti][1] < sec) ti++;
  for (let j = ti; j < tones.length && tones[j][0] < sec + 1; j++) {
    const [start, dur, freq, vol] = tones[j];
    const from = Math.max(0, Math.floor((start - sec) * RATE));
    const to = Math.min(RATE, Math.floor((start + dur - sec) * RATE));
    for (let i = from; i < to; i++) {
      const t = sec + i / RATE - start;
      // プチッと鳴らないよう、出だしと終わりを 10ms で滑らかにする
      const env = Math.min(1, t / 0.01, (dur - t) / 0.01);
      const v = Math.sin(2 * Math.PI * freq * t) * vol * env * 32767;
      chunk.writeInt16LE(Math.round(v), i * 2);
    }
  }
  return out.write(Buffer.from(chunk));
}

let sec = 0;
function pump() {
  while (sec < TOTAL) {
    const ok = writeSecond(sec++);
    if (!ok) return out.once('drain', pump);
  }
  out.end();
}
pump();
