// 画面からドキュメントへ飛ぶための URL を作る。
//
// リンクは動いているビルドの git rev に固定する。自己ホスト型なので利用者ごとに版がばらけ、
// main を指すと「説明にある機能が手元には無い」が起きる。viewer は自分の rev を
// 知っている（/api/version の viewer）ので、それをそのまま参照に使う。
// rev が無い開発ビルド（dev）や SHA でない値のときだけ main に落とす。
//
// 言語はブラウザの言語で選ぶ（ja で始まれば docs/ja/、それ以外は docs/en/）。両方とも同じ構成。
const REPO = 'https://github.com/kamadahiroaki/amipa'

// リンク先はここだけに書く。docs 側のファイル名や見出しを変えたらここを直す
// （見出しを変えるとアンカーが黙って切れるため、散らかすと追えなくなる）。
// パスは docs/<言語>/ からの相対。viewer は使い方ガイドが揃うまで目次を指す。
export const DOC = {
  viewer: 'README.md',
  prep: 'setup/03-your-data.md',
  format: 'reference/db-format.md',
  trouble: 'setup/troubleshooting.md',
} as const

export function docsLang(): 'ja' | 'en' {
  const l = typeof navigator !== 'undefined' ? (navigator.language || '') : ''
  return l.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

export function docsUrl(page: keyof typeof DOC, rev?: string | null, anchor?: string): string {
  const ref = rev && /^[0-9a-f]{7,40}$/.test(rev) ? rev : 'main'
  return `${REPO}/blob/${ref}/docs/${docsLang()}/${DOC[page]}${anchor ? `#${anchor}` : ''}`
}
