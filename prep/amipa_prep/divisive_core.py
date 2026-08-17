#!/usr/bin/env python3
"""divisive_core.py — 「multilevel Infomap をクラスタ毎に掛け直す divisive(トップダウン再帰分割)」
の共有コア。UNIFIED_INFOMAP_LOD_SPEC.md §2 の実装。

App A(商グラフ=layer0 の上)と App B(各 snarl 内部=layer0 の下)の両方が、atoms/adjf/posf を
差し替えてこの 1 本の `divisive_build` を呼ぶ。どの階層でも「1 回展開の子(fan-out) <= B」を保証。

ノード表現(タプル; App A/App B/合成で共通):
  ("L", atom)          葉。atom は App A では supernode id、合成後は GFA node id。
  ("G", [children..])  Infomap-cluster 中間ノード(自然コミュニティ or 縮約 or 座標チャンク)。
  ("S", F, [children]) snarl 展開ノード(App B のみ; F=flubble id)。

コアが生成するのは ("L")/("G") のみ。App B が葉(atom=kid)を resolve して ("S")/("L") に置換する。

再現性: Infomap は OpenMP スレッド数依存の非決定(§5)。bit 再現には呼び出し側で
OMP_NUM_THREADS=1 を設定する。木の品質(fan-out<=B・完全被覆・depth)はスレッド非依存。
"""
import time
from collections import Counter, defaultdict

from infomap import Infomap


class Stats:
    """divisive_build 全体で共有する計数・計時。"""
    def __init__(self):
        self.n_infomap = 0        # infomap_natural_top の実 run 回数
        self.n_infomap_meta = 0   # うち reduce_to_B の preferred-number 再クラスタ段
        self.n_positional = 0     # 分割不能で座標チャンクに落ちた回数
        self.n_smallcut = 0       # LOD②: 小集合(n<=small)で Infomap を省き座標チャンク直行した回数
        self.n_largecut = 0       # LOD③: 巨大集合(n>=large)で Infomap を省き座標チャンク直行した回数
        self.n_chain = 0          # chain-aware: 誘導グラフが線形(chain)で Infomap を省き posf 分割した回数
        self.max_chain_n = 0      # そのうち最大集合サイズ(巨大チェーン=連続バブルを拾えたか診断)
        self.n_coalesce = 0       # coalesce_to_B に落ちた回数
        self.n_reduce = 0         # reduce_to_B に入った(>B parts)回数
        self.infomap_time = 0.0


# --------------------------------------------------------------------------
# Infomap 自然トップ分割
# --------------------------------------------------------------------------
def infomap_natural_top(atoms, adjf, stats=None, seed=1, is_meta=False,
                        preferred=None, two_level=False):
    """atoms を局所 index 化し、両端が atoms 内のエッジのみ 1 回ずつ張って Infomap を掛け、
    トップ分割(len>=2 の atom グループ列)を返す。分割不能なら None。

    - 既定は multilevel の自然トップ分割(通常の divisive 分割はこちら)。
    - preferred(=目標クラスタ数)を与えると `--two-level --preferred-number-of-modules preferred`
      で出力クラスタ数を目標近傍へ寄せる(reduce_to_B 専用)。soft penalty なので厳密 <=preferred は
      保証されず、結果 >B のときは呼び出し側が coalesce_to_B に落とす。two_level 明示でも multilevel を切れる。
    - エッジが 1 本も無い(全孤立/密でない) → None。
    - トップレベル(depth_level=1)が 1 個に潰れる → depth_level=2 を試す → それでも 1 個なら None。
    """
    atoms = list(atoms)
    n = len(atoms)
    if n <= 1:
        return None
    local = {a: i for i, a in enumerate(atoms)}
    args = f"--flow-model undirected --silent -N1 --seed {seed}"
    if two_level or preferred is not None:
        args += " --two-level"
    if preferred is not None:
        args += f" --preferred-number-of-modules {int(preferred)}"
    im = Infomap(args)
    im.add_nodes(range(n))                 # 一括: 孤立ノードも保持(per-link add_node ループ置換)
    links = []
    for a in atoms:
        ia = local[a]
        for b, w in adjf(a):
            jb = local.get(b)
            if jb is not None and jb > ia:
                links.append((ia, jb, float(w)))
    if not links:
        return None                       # エッジ皆無 → 構造無し
    im.add_links(links)                    # 一括: 同一 (i,j,w) 列なので per-link add_link と bit-identical
    nl = len(links)
    if stats is not None:
        stats.n_infomap += 1
        if is_meta:
            stats.n_infomap_meta += 1
        t = time.time()
    im.run()
    if stats is not None:
        stats.infomap_time += time.time() - t

    def groups_at(level):
        mods = im.get_modules(depth_level=level)
        g = defaultdict(list)
        for a in atoms:
            g[mods[local[a]]].append(a)
        return list(g.values())

    groups = groups_at(1)
    if len(groups) == 1:
        if im.max_depth >= 2:
            groups = groups_at(2)
        if len(groups) == 1:
            return None
    return groups                          # len >= 2


# --------------------------------------------------------------------------
# 座標フォールバック分割
# --------------------------------------------------------------------------
def positional_chunks(atoms, posf, k):
    """atoms を posf 昇順に並べ、<=k 個の連続チャンク(非空・網羅・互いに素)に等分。
    n>=2 なら必ず >=2 チャンクを返す(k>=2 のとき)。"""
    order = sorted(atoms, key=posf)
    n = len(order)
    k = max(1, min(k, n))
    out = []
    for i in range(k):
        s = i * n // k
        e = (i + 1) * n // k
        if e > s:
            out.append(order[s:e])
    return out


# --------------------------------------------------------------------------
# chain-aware 分割(連続バブル = 線形集合)
# --------------------------------------------------------------------------
def chain_partition(atoms, adjf, posf, B, stats=None, ratio=1.2):
    """atoms の誘導部分グラフが「線形(chain=連続バブル)」なら Infomap を掛けず posf(ゲノム順)で
    B 個の連続チャンクに分割して返す。線形でない(tangle=辺過多)なら None(呼び出し側が Infomap へ)。

    判定: 集合内無向辺数 <= ratio*n。パス/森は辺数<=n-1、単純閉路で=n。ratio(既定1.2)は
    稀な分岐/閉路への許容。tangle は辺数が n を大きく超えるので確実に弾かれる。
    コスト: adjf を最大 1 パス(O(n+E))。上限超過で早期 bail するので tangle は途中で止まる。

    根拠(chr22 実測): vg snarl 木の巨大 fan-out(最大 293176 直接子)は max 境界共有=2 の直列
    チェーン(連続小バブル ~21万; 98.9% が末端小バブル)。線形集合上で Infomap は degenerate な
    深い peel-chain を吐く(depth534 の主因)。チェーンは本質的に線形なので posf 順の balanced
    bracketing が正解(=速さと正確性が両立; size 閾値の LOD③ と違い tangle を誤爆しない)。
    """
    aset = set(atoms)
    n = len(atoms)
    lim = 2.0 * ratio * n          # adjf は対称なので各無向辺を2回数える(有向端点カウント)
    ecount = 0
    for a in atoms:
        for b, _w in adjf(a):
            if b in aset and b != a:
                ecount += 1
                if ecount > lim:
                    return None    # 辺が多すぎ = tangle → Infomap に回す
    if stats is not None:
        stats.n_chain += 1
        if n > stats.max_chain_n:
            stats.max_chain_n = n
    parts = positional_chunks(atoms, posf, B)
    if len(parts) < 2:             # n>=2 なら通常起きない安全弁
        mid = n // 2
        parts = [atoms[:mid], atoms[mid:]]
    return parts


# --------------------------------------------------------------------------
# >B のときだけの縮約
# --------------------------------------------------------------------------
def coalesce_to_B(groups, posf, B, stats=None):
    """>B グループを <=B に確定的に束ねる。構造ある片(size>1)は温存し、孤立タイル(size1)のみ
    posf 座標で束ねる。返り値は 2..B 個の atom 列(atoms の分割)。"""
    if stats is not None:
        stats.n_coalesce += 1
    groups = [list(g) for g in groups]
    substantial = [g for g in groups if len(g) > 1]
    tiny = sorted([a for g in groups if len(g) == 1 for a in g], key=posf)
    if len(substantial) >= B:
        substantial.sort(key=len, reverse=True)
        keep = [list(g) for g in substantial[:B - 1]]
        rest = [a for g in substantial[B - 1:] for a in g] + tiny
        out = keep + ([rest] if rest else [])
    else:
        slots = B - len(substantial)                     # >= 1
        tiny_chunks = (positional_chunks(tiny, posf, min(slots, len(tiny)))
                       if tiny else [])
        out = [list(g) for g in substantial] + tiny_chunks
    # 安全弁: 必ず 2 分割以上(単一片への潰れを防ぎ再帰の停止を保証)
    if len(out) < 2:
        allatoms = [a for g in out for a in g]
        out = positional_chunks(allatoms, posf, min(B, len(allatoms)))
    return out


def reduce_to_B(atoms, parts, adjf, posf, B, stats=None, seed=1, use_meta=True):
    """自然な top cut が len(parts) > B のときだけ呼ぶ。返り値は 2..B 個(atoms の分割)。

    段1(use_meta=True): 元の atoms を `--two-level --preferred-number-of-modules B` で
        Infomap し直し、出力クラスタ数を B 近傍へ寄せる。自然 multilevel の top cut を part 単位で
        束ねるのでなく atoms を再分割するので境界を引き直せる。preferred は soft penalty のため
        <=B は保証されない。段1不発(None/1 個潰れ)なら自然 top cut(parts)をそのまま段2 へ渡す。
    段2: それでも >B なら coalesce_to_B で確定的に <=B へ束ねる。
    use_meta=False なら段1 を飛ばし parts をそのまま coalesce する。"""
    if stats is not None:
        stats.n_reduce += 1
    groups = None
    if use_meta:
        groups = infomap_natural_top(atoms, adjf, stats=stats, seed=seed,
                                     is_meta=True, preferred=B, two_level=True)
    if not groups or len(groups) < 2:                     # 段1不発 → 自然 top cut を採用
        groups = [list(p) for p in parts]
    if len(groups) > B:
        groups = coalesce_to_B(groups, posf, B, stats=stats)
    return groups


# --------------------------------------------------------------------------
# コア: divisive_build
# --------------------------------------------------------------------------
def divisive_build(atoms, adjf, posf, B, stats=None, seed=1, use_meta=True, small=0, large=0,
                   chain_ratio=0.0):
    """UNIFIED_INFOMAP_LOD_SPEC.md §2。fan-out<=B を保証する再帰分割。
    返り値は ("L", atom) / ("G", [children])。

    atoms: このノード配下の atom-id リスト。
    adjf(a) -> iterable[(b, w)]: 同 universe 内の無向・重み付き隣接。
    posf(a) -> comparable      : 座標フォールバック用キー(ゲノム順の代理)。
    small: LOD② small-n cutoff。n<=small の小集合は Infomap を省き posf の座標チャンクで
        直接 B 分割する(既定 0=無効=bit-identical)。tiny-Infomap 呼び出しの連鎖(1〜2 atom ずつ
        剥がす trivial cut = 深さ~n の peel-chain)を balanced な深さ~log_B(n) に潰し、
        呼び出し回数を削る。bit-identical でない(品質/速度トレードオフ; 不変条件で検証)。
    large: LOD③ large-n cutoff。n>=large の巨大集合(mega-snarl 等)も Infomap を省き座標チャンクで
        B 分割する(既定 0=無効)。巨大 snarl 上の高価な Infomap 実行と、その unbalanced cut による
        深い peel-chain を balanced な深さ~log_B(n) に潰す。App B の律速(巨大 Infomap)対策。
    chain_ratio: chain-aware 分割の発火(既定 0.0=無効=bit-identical)。>0 なら Infomap の前に
        chain_partition を試し、誘導グラフが線形(辺数<=chain_ratio*n=連続バブル)なら Infomap を
        省き posf 順に B 分割する。size でなく「線形か」で発火するので tangle を誤爆しない
        (LOD③ の速さで正確性妥協ゼロ)。推奨 1.2。
    """
    atoms = list(atoms)
    n = len(atoms)
    if n <= 1:
        return ("L", atoms[0])
    if small and n <= small:
        if stats is not None:
            stats.n_smallcut += 1
        parts = positional_chunks(atoms, posf, B)         # Infomap を掛けず座標で B 分割
        if len(parts) < 2:                                # n>=2 なら通常起きない安全弁
            mid = n // 2
            parts = [atoms[:mid], atoms[mid:]]
    elif large and n >= large:
        if stats is not None:
            stats.n_largecut += 1
        parts = positional_chunks(atoms, posf, B)         # 巨大集合も Infomap を省き座標で B 分割
        if len(parts) < 2:
            mid = n // 2
            parts = [atoms[:mid], atoms[mid:]]
    else:
        parts = None
        if chain_ratio:                                   # chain(連続バブル) なら Infomap を省く
            parts = chain_partition(atoms, adjf, posf, B, stats=stats, ratio=chain_ratio)
        if parts is None:
            parts = infomap_natural_top(atoms, adjf, stats=stats, seed=seed)
        if parts is None:
            if stats is not None:
                stats.n_positional += 1
            parts = positional_chunks(atoms, posf, B)
            if len(parts) < 2:                            # n>=2 なら通常起きない安全弁
                mid = n // 2
                parts = [atoms[:mid], atoms[mid:]]
        elif len(parts) > B:
            parts = reduce_to_B(atoms, parts, adjf, posf, B, stats=stats, seed=seed,
                                use_meta=use_meta)
    # 不変条件: 2 <= len(parts) <= B かつ atoms の分割(互いに素・非空・網羅)
    return ("G", [divisive_build(p, adjf, posf, B, stats=stats, seed=seed,
                                 use_meta=use_meta, small=small, large=large,
                                 chain_ratio=chain_ratio) for p in parts])


# --------------------------------------------------------------------------
# 木の走査・統計(App A/App B/合成 共通)
# --------------------------------------------------------------------------
def tree_stats(root):
    """("L"/"G"/"S") 木を DFS で走査し統計と葉(path, atom)行を返す。
    path は 1-based の子番号列を ':' 連結(root は '0')。"""
    max_fanout = 0
    max_depth = 0
    n_internal = 0
    n_leaf = 0
    level_nodes = defaultdict(int)
    fanout_hist = Counter()
    lines = []
    stack = [(root, [], 0)]
    while stack:
        node, path, d = stack.pop()
        level_nodes[d] += 1
        if node[0] == "L":
            n_leaf += 1
            max_depth = max(max_depth, d)
            lines.append((":".join(map(str, path)) if path else "0", node[1]))
        else:
            children = node[1] if node[0] == "G" else node[2]
            n_internal += 1
            max_fanout = max(max_fanout, len(children))
            fanout_hist[len(children)] += 1
            for i, c in enumerate(children, 1):
                stack.append((c, path + [i], d + 1))
    return {
        "max_fanout": max_fanout, "depth": max_depth, "n_internal": n_internal,
        "n_leaf": n_leaf, "level_nodes": dict(level_nodes),
        "fanout_hist": dict(fanout_hist), "lines": lines,
    }
