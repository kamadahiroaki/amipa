#!/bin/bash
# 塩基 MSA の列の順と並列アレルの検算（ヒト chr20-22 アトラス）。使い方: AMIPA_HOSTPORT=hc025:33001 AMIPA_ATLAS_DIR=<serve dir> tests/msa/order_chr202122.sh
# 期待: 全行 OK、HG01978#2 に - が無い（2026-10-18 の不具合: 573/574 が直列、843/847 が別列、582 が 578 の後ろ、HG01978#2 の偽の欠失）
S=${AMIPA_ATLAS_DIR:?serve dir}; export OPENBLAS_NUM_THREADS=1
for rg in "1794950 1795010" "1794500 1795500" "1792978 1795977" "1794000 1796999" "1793900 1796899" "1832500 1834499"; do set -- $rg; curl -s -m 300 "http://${AMIPA_HOSTPORT:?host:port}/api/blocks/tokranges?db=chr202122.db&c0=$1&c1=$2" | python3 -c "import sys,json; t=json.load(sys.stdin); print(json.dumps({'ranges':[x for x in t['ranges'] if x[2]>x[1]],'label':'x'}))" > /tmp/claude-14779/req.json; python3 ~/pangenome/amipa/viewer/scripts/bubble_msa.py --db $S/chr202122.db --distill $S/chr202122.db.distill --ranges-stdin --flank 0 --cap 0 --max-leaves 12000 --synteny $S/chr202122.db.synteny < /tmp/claude-14779/req.json > /tmp/claude-14779/m.json 2>/tmp/claude-14779/e.txt; python3 - $1 $2 <<'EOF'
import json, sys, collections
M = json.load(open('/tmp/claude-14779/m.json'))
if 'error' in M: print(M['error']); raise SystemExit
cols = M['cols']; gi = {}
for i, c in enumerate(cols): gi.setdefault(tuple(c['nodes']), []).append(i)
def ids(prefix, lo, hi): return {f'{prefix}{i}' for i in range(lo, hi)}
for name, T in (('576-588', ids('n73207', 576, 589)), ('572-575', ids('n73207', 572, 576)), ('843-848', ids('n75194', 843, 849))):
    ks = sorted([k for k in gi if set(k) & T], key=lambda k: gi[k][0])
    if not ks: continue
    lab = [ '|'.join(x[-3:] for x in k) for k in ks ]
    nums = [min(int(x[-3:]) for x in k) for k in ks]; mono = all(a < b for a, b in zip(nums, nums[1:])) or all(a > b for a, b in zip(nums, nums[1:]))
    r = next((r for r in M['rows'] if r['label'].startswith('HG01978#2')), None)
    hg = ' '.join(r['seq'][gi[k][0]] for k in ks) if r and name == '576-588' else ''
    print(f'{sys.argv[1]}-{sys.argv[2]} {name}: {"OK " if mono else "NG "}{lab} {("HG01978#2: " + hg) if hg else ""}')
EOF
done
