// 実行中の Traversals の要求を途中で止める（11-12）。以前は worker で走り出した要求は、画面が取り消しても最後まで計算された
//   （グラフを動かすたびの locate が初回 35〜120 秒、その後ろに検索などが並んで 90〜125 秒待った）。
//   メインと worker で 4 バイトの SharedArrayBuffer を共有し、メインは取り消された要求の番号を書く。worker の重い繰り返しは
//   checkCancel() を数千回に 1 回呼び、自分の番号が書かれていたら例外で抜ける（同期の計算は外から割り込めないので、協調して止める）
let flag: Int32Array | null = null
let cur = 0
export class TravCancelled extends Error { constructor() { super('cancelled') } }
export function setCancelBuffer(buf: SharedArrayBuffer): void { flag = new Int32Array(buf) }
export function beginJob(id: number): void { cur = id }
export function endJob(): void { cur = 0 }
export function checkCancel(): void { if (flag && cur && Atomics.load(flag, 0) === cur) throw new TravCancelled() }
