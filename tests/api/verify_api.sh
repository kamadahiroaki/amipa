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
RC=$(get "ref_contigs?db=$DB" | "$PY" pick.py refctg)
echo "  sel=$GID / groups=$GCSV / node=$NAME / leaf=$LEAF / ref contig(id)=$RC"

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
if [ -n "$LEAF" ]; then
  hit "/node_sequence (葉)" "node_sequence?db=$DB&name=$LEAF"
  hit "/leaf_bases (葉)"    "leaf_bases?db=$DB&layer=$ML&$R"
fi


echo "-- Traversals（.trav がある DB だけ。無ければ SKIP）"
#   範囲は /trav/root の座標の数 R から取る（中央の狭い窓と広い窓）。塩基の段の要求は /trav/cols の行（pid・tw0・tw1・dir）から画面と同じ形で組む
TR=$(get "trav/root?db=$DB")
TRR=$("$PY" -c 'import sys,json; j=json.load(sys.stdin); print(int(j.get("R") or 0), 1 if j.get("hasReads") else 0, 1 if j.get("hasAnn") else 0)' <<<"$TR" 2>/dev/null || echo "0 0 0")
read -r TRN THR THA <<<"$TRR"
if [ "${TRN:-0}" -gt 0 ]; then
  TX0=$((TRN / 2)); TX1=$((TRN / 2 + 400)); WX0=$((TRN / 2)); WX1=$((TRN / 2 + TRN / 20))
  hit "/trav/root"               "trav/root?db=$DB"
  hit "/trav/atoms"              "trav/atoms?db=$DB&minanch=50"
  hit "/trav/range (広い窓)"     "trav/range?db=$DB&x0=$WX0&x1=$WX1&minanch=50"
  hit "/trav/cols (広い窓)"      "trav/cols?db=$DB&x0=$WX0&x1=$WX1&ncol=1000&minanch=50"
  hit "/trav/cols (狭い窓)"      "trav/cols?db=$DB&x0=$TX0&x1=$TX1&ncol=400&minanch=50"
  hit "/trav/nleaf"              "trav/nleaf?db=$DB&x0=$TX0&x1=$TX1"
  hit "/trav/nodeset"            "trav/nodeset?db=$DB&x0=$TX0&x1=$TX1&minanch=50"
  hit "/trav/nodes (寄せる先)"   "trav/nodes?db=$DB&x0=$WX0&x1=$WX1&max=500"
  TNM=$(get "trav/nodeset?db=$DB&x0=$TX0&x1=$TX1&minanch=50" | "$PY" -c 'import sys,json; print(",".join(json.load(sys.stdin).get("names", [])[:20]))' 2>/dev/null)
  [ -n "$TNM" ] && hit "/trav/locate"  "trav/locate?db=$DB&names=$TNM"
  if get "trav/genes?db=$DB&x0=$TX0&x1=$TX1&minanch=50" | grep -q '.genes サイドカーが無い'; then echo "  SKIP /trav/genes, genedensity, findgene（.genes 無し）"
  else
    hit "/trav/genes"            "trav/genes?db=$DB&x0=$WX0&x1=$WX1&minanch=50" allow-empty
    hit "/trav/genedensity"      "trav/genedensity?db=$DB&x0=0&x1=$TRN&nbin=200" allow-empty
    hit "/trav/findgene"         "trav/findgene?db=$DB&q=a" allow-empty
  fi
  if [ "$THR" = 1 ]; then
    hit "/trav/reads (広い窓・深さ)" "trav/reads?db=$DB&x0=$WX0&x1=$WX1"
    hit "/trav/reads (狭い窓)"       "trav/reads?db=$DB&x0=$TX0&x1=$TX1"
  else echo "  SKIP /trav/reads（リードのサイドカー無し）"; fi
  TBM=$(get "trav/cols?db=$DB&x0=$TX0&x1=$TX1&ncol=400&minanch=50" | "$PY" -c 'import sys,json; j=json.load(sys.stdin); r=[[x["pid"], x["tw0"], x["tw1"] + 1, 1 if x["dir"] >= 0 else -1] for x in j.get("rows", []) if x["tw0"] >= 0]; print(json.dumps({"db": sys.argv[1], "ranges": r, "flank": 0, "cap": 0, "maxLeaves": 3000, "label": "api", "reads": {"max": 10}}) if r else "")' "$DB" 2>/dev/null)
  if [ -n "$TBM" ]; then hit "/bubble_msa/ranges (Traversals の塩基の段)" "bubble_msa/ranges" "" "$TBM"
  else FAIL=$((FAIL+1)); FAILED+=("/trav/cols の行"); echo "  NG   /trav/cols の行             狭い窓に通過が無い"; fi
  if [ "$THA" = 1 ]; then
    ACT=$(get "ref_contigs?db=$DB" | "$PY" -c 'import sys,json; j=json.load(sys.stdin); c=(j.get("contigs") or j) if isinstance(j, (dict, list)) else []; c=c[0] if isinstance(c, list) and c else {}; print(c.get("name") or c.get("contig") or "")' 2>/dev/null)
    ACN=$(echo "$ACT" | sed 's/.*#//')
    [ -n "$ACN" ] && hit "/trav/ann"  "trav/ann?db=$DB&contig=$ACN&s=1000000&e=1100000"
  fi
else
  echo "  SKIP Traversals（.trav 無し）"
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
