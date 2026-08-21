# 開発の約束ごと

このリポジトリで作業するときの決まり。全体像は [README.md](README.md)、
使い方は [docs/](docs/README.md)、まず通す例は [examples/chrY/](examples/chrY/)。

## 直したら通すもの

```bash
# 型（viewer を触ったら必ず。backend と frontend は別々）
( cd viewer/backend && npx tsc --noEmit ) && ( cd viewer/frontend && npx tsc --noEmit && npx vite build )

# 回帰試験。直した範囲に応じて（詳細 tests/README.md）
tests/run.sh format                          # 数秒。外部データ不要
tests/run.sh db --fast <db ファイル>          # 出来たアトラスの中身の点検
tests/run.sh e2e --gfa /path/chrY.gfa        # 2-4 分。GFA → アトラス → amipa check
tests/run.sh api  <db ファイル名> <host:port> # 起動中の backend に問い合わせ
```

前処理か容器を触ったら `format`、emitter を触ったら `db`、段の構成や再開の判定を触ったら
`e2e`、backend のルートを触ったら `api`。UI だけなら型チェックとビルドで足りる。

## 置き場の判断

「他のクラスタへ持って行って、書き換えずに動くか」で決める。

- 動く → このリポジトリ。`tests/` も `examples/hpc/` の雛形もそう
- 動かない（ジョブスケジューラの書式、特定のホスト名、サイトの運用） → 入れない。
  `amipa prep plan` のように「資源の目安は出すが、ジョブスクリプトは利用者が書く」で分ける

同じ理由で、測定値や試行錯誤の記録もここには置かない。docs には結論だけを書き、
「なぜそう決めたか」の根拠は開発側の記録に残す。

## 気をつけていること

- サイドカーは本体と 1 対 1（`<db>.annot` `<db>.reads` …）。別のビルドのものを混ぜると
  索引が別の場所を指して黙って壊れる。付け替えるなら、付け替えてよいことを実際に照合する
- 空の応答を成功にしない。矩形の取り違えで `[]` が返り「速い」と誤読した事故がある。
  `tests/api` の判定はそれを失敗として扱う
- 機能の有無は features とファイルの実在で判定し、無ければその機能だけ無効にする。
  例外で全体を落とさない（`amipa check` が「何が使えて何が使えないか」を出す）
- 重い経路はコールドの I/O で決まる。全走査を足すときは、共有ファイルシステム上の
  数百 GB でも終わるかを考える（終わらないものは実際にいくつもあった）

## リリース前に

`amipa licenses` で同梱物の表示が出ること、`docs/citation.md` と `CITATION.cff` の版が
合っていること、`manifest.json` に必要なサイドカーが載ること。
