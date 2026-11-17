#!/usr/bin/env python3
"""整数 id の GFA を、整数でないセグメント名の GFA に書き換える（名前モードの試験用、11-17）。
使い方: named_gfa.py <in.gfa> <out.gfa> [--fmt 'utg{:06d}l']
S/L/J/P/W のセグメント id をすべて fmt で置き換える（P の名前の区切り ',' と向き '+/-'、W の '<>' は保つ）。"""
import re, sys
a = sys.argv[1:]; fmt = 'utg{:06d}l'
if '--fmt' in a: i = a.index('--fmt'); fmt = a[i + 1]; del a[i:i + 2]
src, dst = a
nm = lambda x: fmt.format(int(x))
W = re.compile(r'([<>])(\d+)')
with open(src) as f, open(dst, 'w') as o:
    for ln in f:
        c = ln[0]
        if c == 'S': p = ln.split('\t'); p[1] = nm(p[1]); o.write('\t'.join(p))
        elif c in 'LJ': p = ln.split('\t'); p[1] = nm(p[1]); p[3] = nm(p[3]); o.write('\t'.join(p))
        elif c == 'P':
            p = ln.rstrip('\n').split('\t'); p[2] = ','.join(nm(t[:-1]) + t[-1] for t in p[2].split(',') if t); o.write('\t'.join(p) + '\n')
        elif c == 'W':
            p = ln.rstrip('\n').split('\t'); p[6] = W.sub(lambda m: m.group(1) + nm(m.group(2)), p[6]); o.write('\t'.join(p) + '\n')
        else: o.write(ln)
