#!/bin/bash
# 生きている backend に DB を 1 つ指定して、各機能の endpoint を順に叩く。
# verify_db.py が「材料があるか」を見るのに対し、こちらは「実際に応答が返るか」を見る。
#
#   使い方: ./verify_api.sh <db ファイル名（DB_DIR 相対）> <host:port>
#   例:     ./verify_api.sh chrY.db localhost:3001
#           PY=python3 ./verify_api.sh graph.db localhost:3001
#
# 判定は judge.py（200 かつ error キー無し かつ 空でない）。
# ★空応答を失敗にするのが要点: 矩形の取り違えで [] が返り「速い!」と誤読した事故がある
#   (covpack/RESULTS.md の負の対照)。矩形/層/ノード名/hap 範囲は必ず DB 自身の応答から取る
#   (pick.py)。データが無いのが正常な機能だけ allow-empty を付ける。
#
# ★引数名はコードを正とする（推測すると 400 が返り「機能が壊れている」と誤読する）:
#   ビューポート = x1,x2,y1,y2（minX/maxX ではない）／検索 = name（q ではない）／
#   /ribbon = groups（gid の CSV）／/cnv = units（"lo:hi" の CSV）／
#   /node_features・/variant_track = node／/read_alignments = nodes／/goto = contig,bp
set -uo pipefail
cd "$(dirname "$0")"
DB="${1:?db ファイル名を指定}"
HP="${2:?host:port を指定（例 localhost:3001）}"
API="http://$HP/api"
PY="${PY:-python3}"
PASS=0; FAIL=0; declare -a FAILED

get() { curl -sS --max-time 300 "$API/$1" 2>/dev/null; }

hit() {  # hit <ラベル> <パス+クエリ> [allow-empty] [JSON 本文（あれば POST）]
  local label="$1" q="$2" allow="${3:-}" body="${4:-}" code v tmp
  tmp=$(mktemp)
  if [ -n "$body" ]; then
    code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 300 -X POST -H 'Content-Type: application/json' --data-binary "$body" "$API/$q" 2>/dev/null || echo 000)
  else
    code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 300 "$API/$q" 2>/dev/null || echo 000)
  fi
  v=$("$PY" judge.py "$code" "$allow" < "$tmp")
  rm -f "$tmp"
  if [[ "$v" == OK* ]]; then
    PASS=$((PASS+1)); printf "  OK   %-30s %s\n" "$label" "${v#OK }"
  else
    FAIL=$((FAIL+1)); FAILED+=("$label"); printf "  NG   %-30s %s\n" "$label" "${v#NG }"
  fi
}

echo "##### API 検査: $DB  ($API)"
read -r ML X1 Y1 X2 Y2 <<<"$(get "stats?db=$DB" | "$PY" pick.py bbox)"
if [ -z "${X1:-}" ] || [ "$X1" = "None" ]; then
  echo "  NG /stats から world が取れない → 矩形が作れないので中止"; exit 1
fi
# 全域の中央 1/4 を見る矩形（空にならず、かつ全件でもない）。層は中間層。
R=$("$PY" -c "
x1,y1,x2,y2=map(float,'$X1 $Y1 $X2 $Y2'.split())
cx,cy=(x1+x2)/2,(y1+y2)/2; w,h=(x2-x1)/4,(y2-y1)/4
print(f'x1={cx-w}&x2={cx+w}&y1={cy-h}&y2={cy+h}')")
L=$(( ML > 4 ? 4 : ML ))
echo "  stats: maxlayer=$ML world=[$X1,$Y1]..[$X2,$Y2] → 層 L=$L / 矩形=中央 1/4"

# 以降のリクエストに使う値を DB 自身から取る
GID=$(get "path_groups?db=$DB" | "$PY" pick.py gid)          # 1 サンプル分の gid 範囲 "lo-hi"
GCSV=$(get "path_groups?db=$DB" | "$PY" pick.py gidcsv)      # /ribbon 用の gid CSV
NAME=$(get "nodes?db=$DB&layer=$L&$R&nx=fast" | "$PY" pick.py node)
# 配列/MSA は **葉**でないと成立しない（cluster ノードは node_sequence が 404）。最下層から取る。
RS=$("$PY" -c "
x1,y1,x2,y2=map(float,'$X1 $Y1 $X2 $Y2'.split())
cx,cy=(x1+x2)/2,(y1+y2)/2; w,h=(x2-x1)/80,(y2-y1)/80
print(f'x1={cx-w}&x2={cx+w}&y1={cy-h}&y2={cy+h}')")   # 葉の層は中央の小さな矩形で（R だと ecoli50 で 317 MB になり、配信中の主スレッドを 9 秒塞ぐ）
LEAF=$(get "nodes?db=$DB&layer=$ML&$RS&nx=fast" | "$PY" pick.py node)
# ★/nodes_by_name は SQL に `AND n.layer_index = 1` が固定で入っている（用途が L1 限定）。
#   他の層の名前を渡すと必ず空が返るので、L1 の名前で試す。
N1=$(get "nodes?db=$DB&layer=1&x1=-1e9&x2=1e9&y1=-1e9&y2=1e9&nx=fast" | "$PY" pick.py node)
# MSA の対象は **葉の親**（＝葉数の小さいバブル）。
#   中層の cluster を渡すと WG では配下の葉が 400 を超え、backend が正しく拒否する
#   （「選択が大きすぎます」）。chr22 では偶然通っていたので気付けなかった。
BUB=$(get "node_info?db=$DB&name=$LEAF" | "$PY" pick.py parent)
RC=$(get "ref_contigs?db=$DB" | "$PY" pick.py refctg)
echo "  sel=$GID / groups=$GCSV / node=$NAME / leaf=$LEAF / bubble=$BUB / ref contig(id)=$RC"

echo "-- 表示の中核"
hit "/stats"               "stats?db=$DB"
hit "/pick_layer"          "pick_layer?db=$DB&layer=$L&$R"
hit "/nodes 従来経路"      "nodes?db=$DB&layer=$L&$R"
hit "/nodes nx=fast"       "nodes?db=$DB&layer=$L&$R&nx=fast"
hit "/edges"               "edges?db=$DB&layer=$L&$R"
hit "/nodes_grid"          "nodes_grid?db=$DB&layer=$L&$R"
hit "/node_count"          "node_count?db=$DB&layer=$L&$R"

echo "-- リボン / hap 絞り込み / 深さ・多重度"
hit "/path_groups"         "path_groups?db=$DB"
[ -n "$GCSV" ] && hit "/ribbon"            "ribbon?db=$DB&layer=$L&$R&groups=$GCSV"
if [ -n "$GID" ]; then
  hit "/nodes hap 絞り込み" "nodes?db=$DB&layer=$L&$R&nx=fast&sel=$GID"
  hit "/edges hap 絞り込み" "edges?db=$DB&layer=$L&$R&sel=$GID"
  hit "/pick_layer 絞り込み" "pick_layer?db=$DB&layer=$L&$R&sel=$GID"
  hit "/cnv (多重度)"        "cnv?db=$DB&layer=$L&$R&units=${GID/-/:}"
fi
hit "/max_coverage"        "max_coverage?db=$DB"
hit "/max_hb"              "max_hb?db=$DB"
hit "/max_mult"            "max_mult?db=$DB"
hit "/leaf_bases"          "leaf_bases?db=$DB&layer=$L&$R" allow-empty

echo "-- 参照座標 / 検索 / 配列 / MSA"
hit "/ref_contigs"         "ref_contigs?db=$DB"
[ -n "$RC" ] && hit "/goto 参照座標"   "goto?db=$DB&contig=$RC&bp=1000000"
if [ -n "$NAME" ]; then
  hit "/node_info"         "node_info?db=$DB&name=$NAME"
  hit "/nodes_by_name (L1)" "nodes_by_name?db=$DB&names=$N1"
  hit "/search 完全一致"   "search?db=$DB&name=$NAME"
  hit "/search 部分一致"   "search?db=$DB&name=${NAME:1:5}"
  hit "/expand_node"       "expand_node?db=$DB&node=$NAME"
  hit "/node_features"     "node_features?db=$DB&node=$NAME" allow-empty
  hit "/variant_track"     "variant_track?db=$DB&node=$NAME" allow-empty
  hit "/read_alignments"   "read_alignments?db=$DB&nodes=$NAME" allow-empty
fi
if [ -n "${BUB:-}" ]; then
  hit "/bubble_msa (葉の親)" "bubble_msa?db=$DB&nodes=$BUB&flank=1"
elif [ -n "$LEAF" ]; then
  hit "/bubble_msa (葉)"     "bubble_msa?db=$DB&nodes=$LEAF&flank=1"
fi
if [ -n "$LEAF" ]; then
  hit "/node_sequence (葉)" "node_sequence?db=$DB&name=$LEAF"
  hit "/leaf_bases (葉)"    "leaf_bases?db=$DB&layer=$ML&$R"
fi

echo "-- Blocks（木のサイドカー .synteny がある DB だけ。無ければ SKIP）"
# ★2026-10-07 の事故: 配信ジョブのローカル複製で distill ディレクトリが空になり、sites / tokranges / bubble_msa が
#   HTTP 200 の {error:...} で全滅したのに気づけなかった。ここでは木の窓・変異サイト・寄せ先・部分グラフ・トークン範囲・塩基 MSA を
#   一通り往復し、error キーを失敗にする（judge.py）。範囲は /blocks の応答（total_x）から取る。
BLK=$(get "blocks?db=$DB")
BTREE=$("$PY" -c 'import sys,json; j=json.load(sys.stdin); m=j.get("meta",{}); print("1" if m.get("tree") else "0", "1" if m.get("distill") else "0", int(m.get("total_x") or 0), int(m.get("maxlayer") or 0))' <<<"$BLK" 2>/dev/null || echo "0 0 0 0")
read -r BT BD BX BML <<<"$BTREE"
if [ "$BT" = 1 ] && [ "$BX" -gt 0 ]; then
  BX0=$((BX / 2)); BX1=$((BX / 2 + BX / 200))          # 全体の 0.5% 幅の範囲（ecoli50 で ~90 kb）
  SX0=$((BX / 2)); SX1=$((BX / 2 + BX / 1000))         # 全体の 0.1% 幅（ecoli50 で ~18 kb。大きなノード 1 個に収まらない広さ）
  hit "/blocks (木)"            "blocks?db=$DB"
  hit "/blocks/range"           "blocks/range?db=$DB&x0=$BX0&x1=$BX1"
  hit "/blocks/sites (x0/x1)"   "blocks/sites?db=$DB&x0=$SX0&x1=$SX1" allow-empty   # 変異サイト 0 は全株同一で正常。error は NG
  hit "/blocks/bbox"            "blocks/bbox?db=$DB&x0=$SX0&x1=$SX1"
  hit "/blocks/subgraph (葉)"   "blocks/subgraph?db=$DB&layer=$BML&x0=$SX0&x1=$SX1"
  hit "/blocks/nodemap (POST)"  "blocks/nodemap" "" '{"db":"'"$DB"'","layer":'"$BML"',"names":["n1","n2"]}'
  # 葉の名前の集合（塩基の窓・接合の塩基）で寄せる／絞る: POST 版の bbox と subgraph（names→atoms は上の層）
  NB=$(get "blocks/subgraph?db=$DB&layer=$BML&a0=1&a1=1&names=1" | "$PY" -c 'import sys,json; j=json.load(sys.stdin); n=j.get("names",[])[:200]; print(json.dumps({"db": sys.argv[1], "names": n, "layer": int(sys.argv[2]), "target": 800}) if n else "")' "$DB" "$BML" 2>/dev/null)
  [ -n "$NB" ] && hit "/blocks/bbox (POST names)"     "blocks/bbox" "" "$NB"
  [ -n "$NB" ] && hit "/blocks/subgraph (POST names)" "blocks/subgraph" "" "$NB"
  BG=$("$PY" -c 'import sys,json; j=json.load(sys.stdin); print("1" if j.get("meta",{}).get("genes") else "0")' <<<"$BLK" 2>/dev/null || echo 0)
  if [ "$BG" = 1 ]; then
    GP=$(get "blocks/range?db=$DB&x0=$BX0&x1=$BX1" | "$PY" -c 'import sys,json; j=json.load(sys.stdin); L=j["window"]["levels"][0]; c=L["haps"][0]["contigs"][0]; it=c["inst"][0]; print(json.dumps({"db": sys.argv[1], "ranges": [[c["path"], it[6], it[6]+it[2]]]}))' "$DB" 2>/dev/null)
    [ -n "$GP" ] && hit "/blocks/genes (POST)" "blocks/genes" "" "$GP"
    hit "/blocks/gene (name)"     "blocks/gene?db=$DB&name=dna" allow-empty
    GC=$("$PY" -c 'import sys,json; print(json.dumps({"db": sys.argv[1], "c0": int(sys.argv[2]), "c1": int(sys.argv[2]) + 3000}))' "$DB" "$(get "blocks/sites?db=$DB&x0=$SX0&x1=$SX1" | "$PY" -c 'import sys,json; print(json.load(sys.stdin).get("c0", 0))')" 2>/dev/null)
    [ -n "$GC" ] && hit "/blocks/genes_cols (POST)" "blocks/genes_cols" allow-empty "$GC"
    # GFF の 1 行の全項目と、1 株の GFF の書き出し（サイドカー format 2。2026-10-16）
    FEAT=$(get "blocks/feature?db=$DB&gid=1")
    if "$PY" -c 'import sys,json; j=json.load(sys.stdin); sys.exit(0 if j.get("feature") else 1)' <<<"$FEAT" 2>/dev/null; then
      hit "/blocks/feature"          "blocks/feature?db=$DB&gid=1"
      ACC=$("$PY" -c 'import sys,json; print(json.load(sys.stdin)["feature"]["acc"])' <<<"$FEAT")
      GFF1=$(get "blocks/gff?db=$DB&acc=$ACC" | head -1)
      if [ "$GFF1" = "##gff-version 3" ]; then PASS=$((PASS+1)); printf "  OK   %-30s %s\n" "/blocks/gff" "$ACC の 1 行目が ##gff-version 3"; else FAIL=$((FAIL+1)); FAILED+=("/blocks/gff"); echo "  NG   /blocks/gff                    1 行目: $GFF1"; fi
    else
      echo "  SKIP /blocks/feature, /blocks/gff（遺伝子サイドカーが format 1）"
    fi
    hit "/blocks/junctions"       "blocks/junctions?db=$DB"
    JID=$(get "blocks/junctions?db=$DB" | "$PY" -c 'import sys,json; r=json.load(sys.stdin).get("rows",[]); print(r[0][0] if r else "")' 2>/dev/null)
    if [ -n "$JID" ]; then hit "/blocks/junction"        "blocks/junction?db=$DB&jid=$JID"; hit "/blocks/junction_base"   "blocks/junction_base?db=$DB&jid=$JID&k=40"; fi
    SC0=$(get "blocks/sites?db=$DB&x0=$SX0&x1=$SX1" | "$PY" -c 'import sys,json; print(json.load(sys.stdin).get("c0", 0))' 2>/dev/null); SC0=${SC0:-0}
    [ -n "$JID" ] && hit "/blocks/junction_genes"  "blocks/junction_genes?db=$DB&jid=$JID&n=4"
    # オルソログ群（見出しの遺伝子トラック）: 列範囲の群・行の差分・運命の表・名前検索
    hit "/blocks/orth (density)"   "blocks/orth?db=$DB&c0=0&c1=$((SX1+1000000))&max=300" allow-empty
    hit "/blocks/orth"             "blocks/orth?db=$DB&c0=$SC0&c1=$((SC0+15000))" allow-empty
    hit "/blocks/orth_rows (POST)" "blocks/orth_rows" allow-empty '{"db":"'"$DB"'","c0":'"$SC0"',"c1":'"$((SC0+15000))"'}'
    OG=$(get "blocks/orth?db=$DB&c0=$SC0&c1=$((SC0+15000))" | "$PY" -c 'import sys,json; g=json.load(sys.stdin).get("groups") or []; print(g[0][0] if g else "")' 2>/dev/null)
    [ -n "$OG" ] && hit "/blocks/orth_group"       "blocks/orth_group?db=$DB&og=$OG"
    hit "/blocks/orth_find"        "blocks/orth_find?db=$DB&q=dna" allow-empty
    if [ -n "$JID" ]; then   # 接合の塩基の窓の遺伝子（トークン範囲）
      GT=$(get "blocks/junction_base?db=$DB&jid=$JID&k=40" | "$PY" -c 'import sys,json; j=json.load(sys.stdin); r=j.get("ranges",[])[:10]; print(json.dumps({"db": sys.argv[1], "ranges": r}) if r else "")' "$DB" 2>/dev/null)
      [ -n "$GT" ] && hit "/blocks/genes_tok (POST)" "blocks/genes_tok" allow-empty "$GT"
    fi
  else
    echo "  SKIP /blocks/genes（遺伝子サイドカー無し）"
  fi
  if [ "$BD" = 1 ]; then
    TK=$(get "blocks/sites?db=$DB&x0=$SX0&x1=$SX1" | "$PY" -c 'import sys,json; j=json.load(sys.stdin); print(j.get("c0",""), j.get("c1",""))' 2>/dev/null)
    read -r TC0 TC1 <<<"$TK"
    if [ -n "$TC0" ] && [ -n "$TC1" ]; then
      hit "/blocks/tokranges"     "blocks/tokranges?db=$DB&c0=$TC0&c1=$TC1"
      BMB=$(get "blocks/tokranges?db=$DB&c0=$TC0&c1=$TC1" | "$PY" -c 'import sys,json; j=json.load(sys.stdin); print(json.dumps({"db": sys.argv[1], "ranges": j.get("ranges") or [], "flank": 0, "cap": 0, "maxLeaves": 2000}))' "$DB" 2>/dev/null)
      [ -n "$BMB" ] && hit "/bubble_msa/ranges (POST)" "bubble_msa/ranges" "" "$BMB"
      # 1,200 列（画面が塩基へ降りる上限。葉の上限 12,000 を渡す。2026-10-15 から 1 遺伝子分〜を一度に計算する）
      BMB2=$(get "blocks/tokranges?db=$DB&c0=$TC0&c1=$((TC0+1199))" | "$PY" -c 'import sys,json; j=json.load(sys.stdin); print(json.dumps({"db": sys.argv[1], "ranges": j.get("ranges") or [], "flank": 0, "cap": 0, "maxLeaves": 12000}) if j.get("ranges") else "")' "$DB" 2>/dev/null)
      [ -n "$BMB2" ] && hit "/bubble_msa/ranges (POST, 1,200 列)" "bubble_msa/ranges" "" "$BMB2"
    else
      FAIL=$((FAIL+1)); FAILED+=("/blocks/sites c0/c1"); echo "  NG   /blocks/sites c0/c1               応答に c0/c1 が無い"
    fi
  else
    echo "  SKIP /blocks/tokranges, /bubble_msa/ranges（distill サイドカー無し）"
  fi
else
  echo "  SKIP Blocks の木（.synteny 無し）"
fi

echo "-- アノテ / その他（データが無ければ空が正常 = allow-empty）"
hit "/annot_dicts"         "annot_dicts?db=$DB" allow-empty
hit "/gene_features"       "gene_features?db=$DB&layer=$L&$R" allow-empty
hit "/databases"           "databases"
hit "/version"             "version"

echo
echo "===== PASS $PASS / FAIL $FAIL"
if [ $FAIL -gt 0 ]; then printf '  失敗: %s\n' "${FAILED[@]}"; exit 1; fi
exit 0
