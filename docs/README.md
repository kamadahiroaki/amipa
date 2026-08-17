# AMIPA ドキュメント

| 読むもの | 内容 |
|---|---|
| [install.md](install.md) | 導入（Docker / Apptainer / ソースから） |
| [usage-prep.md](usage-prep.md) | GFA からアトラスを作る |
| [usage-viewer.md](usage-viewer.md) | アトラスを見る（機能と操作） |
| [atlas-format.md](atlas-format.md) | アトラスの中身（何が入っていて、何が任意か） |
| [pipeline.md](pipeline.md) | 前処理の各段が何をしているか |
| [deploy.md](deploy.md) | クラウドで公開する |
| [troubleshooting.md](troubleshooting.md) | うまくいかないとき |
| [third-party.md](third-party.md) | 依存している外部ソフトウェアと出典 |

## 全体像

```
  GFA ──▶  amipa prep  ──▶  アトラス(ディレクトリ)  ──▶  amipa serve  ──▶ ブラウザ
          重い・一度だけ      多層 SQLite ＋ サイドカー     読むだけ・軽い
          （大きいグラフは                （可搬。丸ごとコピーできる）
            計算機が要る）
```

- **前処理と閲覧は別のイメージ**なので、片方だけ導入して使える。
- アトラスは**単一ディレクトリ**にまとまっており、別のマシンへコピーしてそのまま開ける。
- 大きいグラフ（全ゲノム規模）でも、閲覧側は同じ手順で動く。
