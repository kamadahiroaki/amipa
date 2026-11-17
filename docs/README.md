# AMIPA ドキュメント

| 読むもの | 内容 |
|---|---|
| [../examples/chrY/](../examples/chrY/) | まずこれ。chrY（数分）で GFA → DB → 表示 を一通り通す |
| [install.md](install.md) | 導入（Docker / Apptainer / ソースから） |
| [usage-prep.md](usage-prep.md) | GFA から DB を作る |
| [usage-viewer.md](usage-viewer.md) | DB を見る（機能と操作） |
| [db-format.md](db-format.md) | DB の中身（何が入っていて、何が任意か） |
| [pipeline.md](pipeline.md) | 前処理の各段が何をしているか |
| [deploy.md](deploy.md) | クラウドで公開する |
| [troubleshooting.md](troubleshooting.md) | うまくいかないとき |
| [third-party.md](third-party.md) | 依存している外部ソフトウェアと出典 |
| [licensing.md](licensing.md) / [citation.md](citation.md) | ライセンスの考え方と、引用のしかた |
| [../examples/hpc/](../examples/hpc/) | ジョブスケジューラで回すときの雛形と資源の見積り |

## 全体像

```
  GFA ──▶  amipa prep  ──▶  DB(ディレクトリ)  ──▶  amipa serve  ──▶ ブラウザ
          重い・一度だけ      多層 SQLite ＋ サイドカー     読むだけ・軽い
          （大きいグラフは                （可搬。丸ごとコピーできる）
            計算機が要る）
```

- 前処理と閲覧は別のイメージなので、片方だけ導入して使える。
- DB は単一ディレクトリにまとまっており、別のマシンへコピーしてそのまま開ける。
- 大きいグラフ（全ゲノム規模）でも、閲覧側は同じ手順で動く。
