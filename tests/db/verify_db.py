#!/usr/bin/env python3
"""出来たアトラス本体（`<name>.db`）に「各機能が動くための材料」が全部あるかを 1 本で確かめる。

viewer を立てて目視する前の門。ここで欠けを見つければ WG の再ビルド 6 時間を無駄にしない。
機能ごとに **その機能が実際に読む表/列/索引** を検査し、値も 1 件引いて中身が入っているか見る
（表があっても空、という失敗が実際にあった）。

`amipa check` が「サイドカーが揃っているか」を外から見るのに対し、こちらは**中身**を見る。
両方通って初めて画面で使える状態になる。

使い方:  tests/run.sh db [--fast] <db> [<db> ...]
         （直接なら python3 tests/db/verify_db.py [--fast] <db> ...）
終了コード: 全機能 OK なら 0、欠けがあれば 1（NG の一覧を最後に出す）。

★WG(200M 行 / 270GB / Lustre cold)には **--fast を付ける**。素の `COUNT(*)` は表を全走査し、
  cold random 4KB で 0.5〜2.5MB/s しか出ないので 1 表で何時間もかかる。--fast では
    ・行数は `MAX(rowid)`（rowid キーの表なので B-tree の右端 1 シークで済む）
    ・「中身が入っているか」は先頭付近の標本（LIMIT）で見る
  に落とす。数え上げの厳密さは要らない（欲しいのは「空でないか」だから）。
"""
import os
import sqlite3
import sys

OK, NG, WARN = "OK  ", "NG  ", "WARN"
FAST = False


class Checker:
    def __init__(self, path):
        self.path = path
        self.con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self.con.execute("PRAGMA cache_size=-262144")
        self.rows = []
        self.tabs = {r[0] for r in self.q(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
        self.idxs = {r[0] for r in self.q(
            "SELECT name FROM sqlite_master WHERE type='index'")}
        # stats.data(JSON) を 1 回だけ読み、maxlayer と world 矩形を全検査で使い回す。
        # ★これらを nodes_rtree に問い合わせてはいけない（下の rt_rows の註を参照）。
        self.stats = {}
        if "stats" in self.tabs:
            import json
            raw = self.one("SELECT data FROM stats ORDER BY id LIMIT 1")
            if raw:
                try:
                    self.stats = json.loads(raw)
                except Exception:
                    self.stats = {}
        self.maxlayer = self.stats.get("maxlayer")
        self.world = self.stats.get("world") or {}

    def rt_rows(self):
        """R-Tree の行数。

        ★`SELECT MAX(rowid) FROM nodes_rtree` を使ってはいけない。**仮想表は集約を最適化せず
          全件スキャンになる**（WG 実測: nodes/edges の MAX(rowid) が 0.09s / 0.03s で返るのに
          nodes_rtree は 2 分でも返らない）。影表 `nodes_rtree_rowid` は普通の B-tree なので
          同じ値が 1 シークで出る。MIN/MAX(min_layer) も同じ理由で不可 → maxlayer は stats から取る。
        """
        t = "nodes_rtree_rowid" if "nodes_rtree_rowid" in self.tabs else None
        if not t:
            return None
        return self.one(f"SELECT MAX(rowid) FROM {t}")

    def q(self, sql, args=()):
        try:
            return self.con.execute(sql, args).fetchall()
        except Exception as e:
            return [("!ERR", str(e))]

    def one(self, sql, args=()):
        r = self.q(sql, args)
        return r[0][0] if r and r[0] and r[0][0] != "!ERR" else None

    def cols(self, table):
        return {r[1] for r in self.q(f"PRAGMA table_info({table})")}

    def n_rows(self, table):
        """行数。--fast では MAX(rowid)（rowid キーの表なので右端 1 シーク）。
           rowid が飛んでいれば上界になるが、判定は「空でないか」なので十分。"""
        if FAST:
            v = self.one(f"SELECT MAX(rowid) FROM {table}")
            return v if v is not None else 0
        return self.one(f"SELECT COUNT(*) FROM {table}")

    def any_row(self, table, where, args=()):
        """条件を満たす行が「ある」か。全件数は要らないので LIMIT 1 で止める。
           ★NOT INDEXED を付けない: ここは索引が使えるなら使ってよい（全走査させたいのではなく
             1 行見つけたいだけ）。"""
        return bool(self.q(f"SELECT 1 FROM {table} WHERE {where} LIMIT 1", args))

    def rec(self, feature, status, detail):
        self.rows.append((feature, status, detail))

    # ---------------------------------------------------------------- 検査本体
    def need_tables(self, feature, *names):
        miss = [n for n in names if n not in self.tabs]
        if miss:
            self.rec(feature, NG, f"表が無い: {', '.join(miss)}")
            return False
        return True

    def need_cols(self, feature, table, *names):
        have = self.cols(table)
        miss = [n for n in names if n not in have]
        if miss:
            self.rec(feature, NG, f"{table} に列が無い: {', '.join(miss)}")
            return False
        return True

    def check_core(self):
        f = "① 基本(nodes/edges/層)"
        if not self.need_tables(f, "nodes", "edges", "nodes_rtree"):
            return
        n = self.n_rows("nodes")
        e = self.n_rows("edges")
        # ★層の範囲を DB に数えさせてはいけない。`MIN/MAX(layer_index) FROM nodes` は
        #   layer_index に索引が無いので 200M 行の全走査、`MIN/MAX(min_layer) FROM nodes_rtree` は
        #   仮想表の集約なのでやはり全走査（どちらも WG で実際に踏んで verify を止めた）。
        #   層は emitter が stats.data に書いているのでそれを読む。
        lo, hi = 0, self.maxlayer
        rt = self.rt_rows()
        if not n or not e:
            self.rec(f, NG, f"空: nodes={n} edges={e}")
        elif not rt:
            self.rec(f, NG, "nodes_rtree が空（hapidx 段が落ちた形。表示できない）")
        elif rt != n:
            self.rec(f, WARN, f"nodes {n:,} と nodes_rtree {rt:,} の行数が違う")
        else:
            self.rec(f, OK, f"nodes {n:,} / edges {e:,} / 層 L{lo}..L{hi} / rtree {rt:,}")

    def check_layer_zoom(self):
        """層の閾値は独立した表ではなく stats.data(JSON) に入っている。
           viewer LOD-A はこの layer_zoom で層を選ぶので、欠けると層が切り替わらない。"""
        f = "② LOD 層選択(stats.data の layer_zoom)"
        if "stats" not in self.tabs:
            self.rec(f, NG, "stats 表が無い")
            return
        d = self.stats
        if not d:
            self.rec(f, NG, "stats.data が空 or 壊れている")
            return
        z = d.get("layer_zoom") or []
        nn = d.get("layer_nodes") or []
        if not z:
            self.rec(f, NG, "stats.data に layer_zoom が無い（較正段が通っていない）")
            return
        mono = all(z[i] <= z[i + 1] for i in range(len(z) - 1))
        w = d.get("zoom_window")
        self.rec(f, OK if mono else WARN,
                 f"maxlayer={d.get('maxlayer')} / layer_zoom {len(z)} 個 "
                 f"{z[0]:.4g}..{z[-1]:.4g} / L0 {nn[0] if nn else '?'} 〜 "
                 f"L{len(nn)-1} {nn[-1]:,} / zoom_window={w}"
                 + ("" if mono else " ★単調でない"))

    def check_drawaux(self):
        f = "③ /nodes 高速経路(R-Tree 補助列, nx=fast)"
        # rad は後から足した列。無いと radius を矩形から導出することになり、深層で相対 174% 過大
        # → ノード/エッジがリボンに対してずれる（⑬ が相対誤差で検出する）。
        need = ("cx", "cy", "ang", "rad", "nm", "hb", "bnd", "gcn", "rgn",
                "rbp", "rbe", "rci", "ranc", "rmul", "rstr")
        # 補助列は仮想表 nodes_rtree の側に名前で見える（実体は影表 _rowid の a0..aN）
        t = "nodes_rtree"
        if t not in self.tabs:
            self.rec(f, NG, f"{t} が無い（hapidx が動いていない）")
            return
        have = self.cols(t)
        miss = [c for c in need if c not in have]
        if miss:
            self.rec(f, NG, f"補助列が無い: {', '.join(miss)} → nx=fast が使えない")
            return
        meta = dict(self.q("SELECT key,value FROM hapidx_meta")) if "hapidx_meta" in self.tabs else {}
        if meta.get("draw_aux") != "1":
            self.rec(f, WARN, f"列はあるが hapidx_meta.draw_aux={meta.get('draw_aux')}")
            return
        # 値が入っているか（列を足しても NULL のままという失敗を潰す）
        hiL = self.maxlayer          # 仮想表の MAX() は全走査になるので stats から取る
        v = self.q("SELECT ang, nm, hb, rbp FROM nodes_rtree WHERE min_layer=? LIMIT 3", (hiL,))
        nulls = sum(1 for row in v for x in row[:3] if x is None)
        self.rec(f, OK if nulls == 0 else WARN,
                 f"{len(need)} 列あり / ang_scale={meta.get('ang_scale')} / 標本 {v[:1]}"
                 + (f" ★NULL {nulls} 個" if nulls else ""))

    def check_hapfilter(self):
        f = "④ hap 絞り込み描画(hap マスク)"
        if not self.need_tables(f, "hapidx_meta", "hap_dict", "nodes_rtree_rowid"):
            return
        meta = dict(self.q("SELECT key,value FROM hapidx_meta"))
        # マスクは nodes_rtree では hm0..hm{W-1}、影表 nodes_rtree_rowid では a0.. に並ぶ。
        # 絞り込み SQL は影表を直接叩く（CROSS JOIN 必須の経路）ので影表側も見る。
        have = self.cols("nodes_rtree")
        W = int(meta.get("words", 0) or 0)
        miss = [c for c in (f"hm{i}" for i in range(W)) if c not in have]
        H = self.one("SELECT COUNT(*) FROM hap_dict")
        ed = "edge_hm" in self.tabs
        nz = self.any_row("nodes_rtree_rowid", "a0 <> 0") \
            if "a0" in self.cols("nodes_rtree_rowid") else False
        if miss:
            self.rec(f, NG, f"マスク列が無い: {', '.join(miss)}")
        elif not nz:
            self.rec(f, NG, "a0 が全て 0 = マスクが埋まっていない")
        else:
            self.rec(f, OK, f"H={H} / W={W} / mode={meta.get('mode')} / a0≠0 の行あり"
                            + (f" / edge_hm {self.n_rows('edge_hm'):,} 行" if ed
                               else " / ★edge_hm 無し(エッジ側の絞り込み不可)"))

    def check_ribbon(self):
        f = "⑤ リボン(sample/hap/contig 被覆)"
        if not self.need_tables(f, "contig_dict", "node_contig_cov", "contigcov_meta"):
            return
        C = self.n_rows("contig_dict")
        nn = self.n_rows("node_contig_cov")
        ee = self.n_rows("edge_contig_cov") if "edge_contig_cov" in self.tabs else 0
        blob = self.one("SELECT LENGTH(blob) FROM node_contig_cov WHERE LENGTH(blob)>4 LIMIT 1")
        fmt = self.one("SELECT value FROM db_meta WHERE key='contigcov_fmt'") if "db_meta" in self.tabs else None
        if not C or not nn:
            self.rec(f, NG, f"空: contig_dict={C} node_contig_cov={nn}")
        else:
            self.rec(f, OK, f"contig {C:,} / node 行 {nn:,} / edge 行 {ee:,} / "
                            f"blob 標本 {blob}B / fmt={fmt or 'f0(既定)'}")

    def check_hb_idx(self):
        f = "⑥ hb 被覆索引(リボン/エッジ幅の被覆読み)"
        want = {"idx_ncc_hb", "idx_ecc_hb"}
        have = want & self.idxs
        if have == want:
            self.rec(f, OK, "idx_ncc_hb / idx_ecc_hb あり")
        elif have:
            self.rec(f, WARN, f"片方だけ: {', '.join(sorted(have))}")
        else:
            hb = "hb" in self.cols("node_contig_cov") if "node_contig_cov" in self.tabs else False
            self.rec(f, NG if hb else WARN,
                     "索引が無い" + ("（hb 列はある＝emitter が索引段を通っていない）" if hb
                                     else "（hb 列自体が無い）"))

    def check_search(self):
        f = "⑦ 検索(Find>Node / Find>Position)"
        det = []
        st = OK
        if "nmdict" in self.tabs and "nmfts" in self.tabs:
            n = self.n_rows("nmdict")
            det.append(f"nametri: nmdict {n:,} 行")
            if not n:
                st = NG
        else:
            st = NG
            det.append("nametri(nmdict/nmfts) が無い → 部分一致検索が全走査")
        if "idx_nodes_refpos" in self.idxs:
            det.append("idx_nodes_refpos あり")
        else:
            st = NG
            det.append("idx_nodes_refpos が無い → Find>Position が全走査")
        if "ref_meta" in self.tabs:
            ms = self.one("SELECT max_span FROM ref_meta") if "max_span" in self.cols("ref_meta") else None
            det.append(f"ref_meta.max_span={ms}")
        else:
            st = NG
            det.append("ref_meta が無い")
        self.rec(f, st, " / ".join(det))

    def check_refbp(self):
        f = "⑧ 参照座標トラック(Ref bp, 既定 ON)"
        if not self.need_cols(f, "nodes", "ref_bp", "ref_bp_end", "ref_contig_id",
                              "is_anchor", "ref_multi", "ref_strand"):
            return
        n = self.any_row("nodes", "ref_bp IS NOT NULL")
        rk = self.one("SELECT ref_key FROM ref_meta") if "ref_meta" in self.tabs and \
            "ref_key" in self.cols("ref_meta") else None
        strand = self.any_row("nodes", "ref_strand IS NOT NULL")
        self.rec(f, OK if n else NG,
                 f"ref_key={rk} / ref_bp 付きの行 {'あり' if n else '★無し'} / ref_strand 付きの行 {'あり' if strand else '★無し'}")

    def check_leafseq(self):
        f = "⑨ 塩基配列(leaf_seq; MSA パネルの配列源)"
        if "leaf_seq" not in self.tabs:
            self.rec(f, NG, "leaf_seq が無い（distill の s_seq も --gfa も無かった）")
            return
        n = self.n_rows("leaf_seq")
        bp = self.one("SELECT SUM(LENGTH(seq)) FROM leaf_seq WHERE leaf_id < "
                      "(SELECT MIN(leaf_id)+100000 FROM leaf_seq)")
        self.rec(f, OK if n else NG, f"{n:,} 行 / 先頭 10 万 id の Σbp={bp:,}" if n else "空")

    def check_msa_sidecar(self):
        f = "⑩ bubble MSA サイドカー(<db>.distill)"
        link = self.path + ".distill"
        real = os.path.realpath(link) if os.path.exists(link) else None
        if not real:
            self.rec(f, NG, f"{os.path.basename(link)} が無い → MSA パネルが出ない")
            return
        need = ("p_tok.npy", "p_ori.npy", "p_off.npy", "p_names.txt", "id_map.npy")
        miss = [x for x in need if not os.path.exists(os.path.join(real, x))]
        if miss:
            self.rec(f, NG, f"{real} に {', '.join(miss)} が無い")
        else:
            sz = sum(os.path.getsize(os.path.join(real, x)) for x in need)
            self.rec(f, OK, f"→ {os.path.basename(real)} (5 ファイル計 {sz/1e9:.2f} GB)")

    def check_invmult(self):
        """逆位 = node_contig_inv、多重度 = node_hap_mult / edge_hap_mult
           （rowid キーの blob。--emit-inversion / --emit-multiplicity が作る）。

        ★edge_contig_inv は **作られるが書かれない**（emitter に INSERT が無い）。backend も
          node_contig_inv しか読まない（paths.ts）。空でも異常ではないので判定に入れない。
        """
        f = "⑪ 逆位 / 多重度(per-hap CNV)"
        det, st = [], OK
        for label, need, also in (("逆位", "node_contig_inv", None),
                                  ("多重度", "node_hap_mult", "edge_hap_mult")):
            if need not in self.tabs:
                st = NG
                det.append(f"{label}: 表が無い {need}")
                continue
            n = self.n_rows(need)
            nz = self.any_row(need, "LENGTH(blob) > 4")
            if not n:
                st = NG
                det.append(f"{label}: {need} が空")
                continue
            if not nz:
                st = WARN
            extra = f" / {also} {self.n_rows(also):,}" if also and also in self.tabs else ""
            det.append(f"{label}: {need} {n:,} 行{extra}, 中身{'あり' if nz else '★空'}")
        self.rec(f, st, " / ".join(det))

    def check_meta(self):
        f = "⑫ db_meta(features / 入力の記録)"
        if "db_meta" not in self.tabs:
            self.rec(f, NG, "db_meta が無い")
            return
        m = dict(self.q("SELECT key,value FROM db_meta"))
        feats = m.get("features", "")
        self.rec(f, OK if feats else WARN,
                 f"built_at={m.get('built_at')} / features={feats or '(空)'}")

    def check_fast_vs_legacy(self):
        """高速経路(R-Tree だけ)と従来経路(nodes を読む)が同じ集合・同じ幾何を返すか。
           viewer のどの機能より先に、ここがずれていたら全部ずれる。

        ★この検査だけは **nodes の任意 rowid 引き**を避けられない（比較相手がそれだから）。
          WG cold では 1 行 ≒ 3 ページのランダム読みなので標本を 800 に落とす
          （5000 だと 15,000 回の 4KB ランダム読み＝分オーダー）。"""
        f = "⑬ 高速経路 == 従来経路(件数/幾何)"
        if "nodes_rtree" not in self.tabs or "ang" not in self.cols("nodes_rtree"):
            self.rec(f, WARN, "補助列が無いので比較しない")
            return
        meta = dict(self.q("SELECT key,value FROM hapidx_meta")) if "hapidx_meta" in self.tabs else {}
        ascale = float(meta.get("ang_scale") or 1000000)
        L = self.maxlayer
        if L is None:
            self.rec(f, WARN, "stats に maxlayer が無いので比較しない")
            return
        # ★矩形は要らない。欲しいのは「同じ行を両経路で引いて一致するか」だけなので、
        #   **全域を覆う矩形 + LIMIT** にする。rtree のカーソルは木を降りながら行を逐次返すので
        #   LIMIT で早く止まり、bbox を求めるための集約(MIN/MAX(min_x) = 全走査)が要らなくなる。
        #   world は stats.data に**入っていない**（backend が計算している）ので、そこには頼れない。
        #   ORDER BY も付けない: 付けると全件そろえてから並べ替えるので LIMIT が効かなくなる。
        BIG = 1e30
        # ★radius も必ず比べる。ここを抜いていたせいで「矩形から導出した radius が
        #   相対 174% 過大」を 13/13 緑のまますり抜けさせた（ノード/エッジがリボンに対して
        #   ずれる形で実際に見えていた）。rad 補助列があればそれ、無ければ矩形からの導出値。
        rc = self.cols("nodes_rtree")
        radsel = "r.rad" if "rad" in rc else "(r.max_x-r.min_x)/2"
        xsel = "r.cx" if "cx" in rc else "(r.min_x+r.max_x)/2"
        ysel = "r.cy" if "cy" in rc else "(r.min_y+r.max_y)/2"
        fast = self.q(
            f"SELECT r.rowid, r.nm, {xsel}, {ysel}, "
            f"CAST(r.ang AS REAL)/{ascale}, {radsel} FROM nodes_rtree r "
            "WHERE r.min_layer=? AND r.min_x<=? AND r.max_x>=? AND r.min_y<=? AND r.max_y>=? "
            f"LIMIT {800 if FAST else 5000}", (L, BIG, -BIG, BIG, -BIG))
        if not fast or fast[0][0] == "!ERR":
            self.rec(f, NG, f"高速経路のクエリが失敗: {fast[:1]}")
            return
        ids = [r[0] for r in fast]
        ph = ",".join("?" * len(ids))
        leg = {r[0]: r[1:] for r in self.q(
            f"SELECT rowid, node_name, xCoord, yCoord, angle, radius "
            f"FROM nodes WHERE rowid IN ({ph})", ids)}
        if len(leg) != len(ids):
            self.rec(f, NG, f"rowid の対応が取れない: fast {len(ids)} / nodes {len(leg)}")
            return
        dn = sum(1 for r in fast if leg[r[0]][0] != r[1])
        dx = max(abs(leg[r[0]][1] - r[2]) for r in fast)
        dy = max(abs(leg[r[0]][2] - r[3]) for r in fast)
        da = max(abs((leg[r[0]][3] or 0) - r[4]) for r in fast)
        # ★幾何は全部 **そのノード自身の radius に対する比** で見る。絶対誤差は world 比で
        #   小さくても、viewer はノードが見える大きさまでズームするので、radius と同じ
        #   オーダーの位置ずれは画面上で「自分の大きさぶん」ずれて見える。
        #   実例 mcgrch38 n23316007: radius 4.37e-08 に対し Δy 4.5e-08（約 5px 相当）。
        #   絶対値で見て「1 ulp だから無害」と流し、radius と位置で 2 回同じ誤りをした。
        relr = max([abs((leg[r[0]][4] or 0) - r[5]) / leg[r[0]][4]
                    for r in fast if leg[r[0]][4]] or [0.0])
        relp = max([max(abs(leg[r[0]][1] - r[2]), abs(leg[r[0]][2] - r[3])) / leg[r[0]][4]
                    for r in fast if leg[r[0]][4]] or [0.0])
        bad = dn or relr > 0.01 or relp > 0.01
        st = NG if bad else (OK if da < 1e-5 else WARN)
        self.rec(f, st, f"L{L} {len(ids)} 行比較(全域+LIMIT) / node_name 不一致 {dn} / "
                        f"|Δx|max {dx:.3g} |Δy|max {dy:.3g} |Δangle|max {da:.3g} / "
                        f"**Δradius/r {relr*100:.2f}% / Δ位置/r {relp*100:.2f}%**"
                        + ("  ★自分の大きさに対して大きい=リボンに対してずれて見える" if bad else ""))

    def run(self):
        for m in (self.check_core, self.check_layer_zoom, self.check_drawaux,
                  self.check_hapfilter, self.check_ribbon, self.check_hb_idx,
                  self.check_search, self.check_refbp, self.check_leafseq,
                  self.check_msa_sidecar, self.check_invmult, self.check_meta,
                  self.check_fast_vs_legacy):
            try:
                m()
            except Exception as e:
                self.rec(m.__name__, NG, f"検査自体が例外: {type(e).__name__}: {e}")
        self.con.close()
        return self.rows


def main(paths):
    bad = 0
    for p in paths:
        if not os.path.exists(p):
            print(f"\n##### {p}\n  NG   ファイルが無い")
            bad += 1
            continue
        sz = os.path.getsize(os.path.realpath(p))
        print(f"\n##### {p}  ({sz/1e9:.2f} GB)")
        for feat, st, det in Checker(p).run():
            print(f"  {st} {feat}: {det}")
            if st == NG:
                bad += 1
    print(f"\n===== NG {bad} 件 =====")
    return 1 if bad else 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--fast" in args:
        FAST = True
        args = [a for a in args if a != "--fast"]
    if not args:
        print(__doc__)
        sys.exit(2)
    print("(--fast: 行数は MAX(rowid)、中身は存在確認のみ)" if FAST else "(全件走査モード。WG には --fast を)")
    sys.exit(main(args))
