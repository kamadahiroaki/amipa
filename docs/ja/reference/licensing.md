# ライセンス

[English](../../en/reference/licensing.md)

| 対象 | ライセンス | 理由 |
|---|---|---|
| `prep/`（前処理） | GPL-3.0-or-later | Infomap（GPL-3.0-or-later）を同じプロセスで読み込むため |
| `prep/amipa_prep/cs_ops.py` と `prep/amipa_prep/zstd_seek.py` | MIT | 閲覧側が同じ形式を読むために複製して使うファイルで、Infomap とは無関係なため（下記） |
| `viewer/`（閲覧） | MIT | コピーレフトの依存が無く、他のソフトに組み込みやすくするため |
| ドキュメント | CC BY 4.0 | |

リポジトリ直下の [LICENSE](../../../LICENSE) は GPL-3.0（全体としての条件）、[viewer/LICENSE](../../../viewer/LICENSE) が MIT。同梱物の一覧と入手元は [NOTICE](../../../NOTICE) にある。

## 前処理と閲覧で共有している 2 つのファイル

リードの整列の容器（seekable zstd）と `cs:Z` の切り出しは、書く側（前処理）と読む側（閲覧）で一致していなければならないので、実装を 1 か所に置いて共有している。置き場は前処理の側だが、閲覧イメージのビルドのときに閲覧側へ複製される。

この 2 つは Infomap を使わないので GPL にする理由がなく、MIT で提供する（ファイルの冒頭に `SPDX-License-Identifier: MIT` がある）。これにより、配布する閲覧イメージに含まれる AMIPA のコードはすべて MIT になる。

## コンテナイメージを再配布するとき

イメージには AMIPA 以外のソフトウェアも入っている。

| イメージ | AMIPA のコード | 同梱している他のソフトウェア |
|---|---|---|
| `amipa-prep` | GPL-3.0-or-later | Infomap（GPL-3.0-or-later）、BubbleFinder（GPL-3.0）、Python の各種パッケージ、Debian のシステムパッケージ |
| `amipa-viewer` | MIT | Node.js、Debian のシステムパッケージ |

どちらのイメージも Debian をもとにしているので、GPL・LGPL のシステムパッケージを含む。そのまま再配布するなら、次の 2 つを満たせば足りる。

1. `NOTICE` を一緒に配る（イメージの中の `/opt/amipa/NOTICE` にも入っている）
2. GPL のコンポーネントの、対応するソースの入手方法を示す。同梱しているのは改変していない公開版なので、`NOTICE` に書いた入手元と版を示せば足りる

自分で改変した Infomap を含めて配布する場合は、その改変したソースを提供する義務が生じる。

ライセンスの全文もイメージの中にある（`/opt/amipa/LICENSE`。prep は GPL-3.0、viewer は MIT）。`amipa licenses` は `NOTICE` と全文の両方を出すので、イメージだけを受け取った人も条件を確かめられる。

## AMIPA を組み込みたいとき

- 閲覧側だけを使う（DB を表示する機能を自分のソフトに組み込む）→ MIT なので自由。共有している 2 つのファイルも MIT なので、閲覧側一式をそのまま取り込める
- 前処理を含めて使う → GPL-3.0-or-later に従う（派生物も GPL で公開する）

前処理を permissive なライセンスにしたい場合は、Infomap を別のプロセスとして呼ぶ形に変えれば分離できる（今は Python の API を同じプロセスで使っている）。必要なら issue で相談してほしい。
