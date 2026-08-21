// 画面からドキュメントへ飛ぶための URL を作る。
//
// ★動いているビルドの git rev に固定する。自己ホスト型なので利用者ごとに版がばらけ、
//   main を指すと「説明にある機能が手元には無い」が起きる。viewer は自分の rev を
//   知っている（/api/version の viewer）ので、それをそのまま参照に使う。
//   rev が無い開発ビルド（dev）や SHA でない値のときだけ main に落とす。
const REPO = 'https://github.com/kamadahiroaki/amipa'

// ★リンク先はここだけに書く。docs 側のファイル名や見出しを変えたらここを直す
//   （見出しを変えるとアンカーが黙って切れるため、散らかすと追えなくなる）。
export const DOC = {
  viewer: 'docs/usage-viewer.md',
  prep: 'docs/usage-prep.md',
  atlas: 'docs/atlas-format.md',
  trouble: 'docs/troubleshooting.md',
} as const

export function docsUrl(page: keyof typeof DOC, rev?: string | null, anchor?: string): string {
  const ref = rev && /^[0-9a-f]{7,40}$/.test(rev) ? rev : 'main'
  return `${REPO}/blob/${ref}/${DOC[page]}${anchor ? `#${anchor}` : ''}`
}
