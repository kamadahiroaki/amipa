#!/bin/bash
# 生きている backend に DB を 1 つ指定して、各機能の endpoint を順に叩く。
# verify_db.py が「材料があるか」を見るのに対し、こちらは「実際に応答が返るか」を見る。
#
#   使い方: ./verify_api.sh <db ファイル名（DB_DIR 相対）> <host:port>
#   例:     ./verify_api.sh chrY.db localhost:3001
#           PY=python3 ./verify_api.sh mc-grch38-v1.db pc058:33001
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

hit() {  # hit <ラベル> <パス+クエリ> [allow-empty]
  local label="$1" q="$2" allow="${3:-}" code v tmp
  tmp=$(mktemp)
  code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 300 "$API/$q" 2>/dev/null || echo 000)
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
LEAF=$(get "nodes?db=$DB&layer=$ML&$R&nx=fast" | "$PY" pick.py node)
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

echo "-- アノテ / その他（データが無ければ空が正常 = allow-empty）"
hit "/annot_dicts"         "annot_dicts?db=$DB" allow-empty
hit "/gene_features"       "gene_features?db=$DB&layer=$L&$R" allow-empty
hit "/databases"           "databases"
hit "/version"             "version"

echo
echo "===== PASS $PASS / FAIL $FAIL"
if [ $FAIL -gt 0 ]; then printf '  失敗: %s\n' "${FAILED[@]}"; exit 1; fi
exit 0
