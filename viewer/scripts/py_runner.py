#!/usr/bin/env python3
"""常駐の Python 実行器（backend の pyRunner.ts が 1〜数本を抱える）。

backend は stdin に 1 行 JSON  {"id", "script", "argv": [...], "stdin": "..."}  を書く。
この実行器はそのスクリプトを runpy で __main__ として走らせ、標準出力・標準エラーを捕まえて
  {"id", "ok", "out", "err", "ms"}  を 1 行で返す（out = スクリプトが print した JSON そのもの）。

なぜ常駐か: bubble_msa.py は要求ごとに spawn していたが、計算ノードでは Lustre 上の miniconda の
`import numpy` だけで 6〜43 秒かかり（2026-10-15 pc060 実測、読み込みのたびにばらつく）、計算本体の 1 秒を
桁で上回っていた。import を 1 回で済ませるため、プロセスを生かしておく。

・要求は逐次。スクリプトが sys.exit しても（bubble_msa.py の die() は exit 0）この実行器は止まらない
・numpy 等は起動時に読み込む（サーバ起動直後に温める。無い環境でも実行器自体は動く）
・{"op": "quit"} で終了
"""
import io
import json
import os
import runpy
import sys
import time
import traceback

for _m in ("numpy", "sqlite3"):
    try:
        __import__(_m)
    except Exception:
        pass

REAL_OUT, REAL_ERR, REAL_IN = sys.stdout, sys.stderr, sys.stdin


def send(obj):
    REAL_OUT.write(json.dumps(obj) + "\n")
    REAL_OUT.flush()


send({"ev": "hello", "pid": os.getpid(), "numpy": "numpy" in sys.modules})

for line in REAL_IN:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception as e:  # noqa: BLE001
        send({"ok": False, "error": "bad json: %s" % e})
        continue
    if req.get("op") == "quit":
        break
    rid = req.get("id")
    script = req.get("script") or ""
    argv = [str(a) for a in (req.get("argv") or [])]
    t0 = time.time()
    cap, errcap = io.StringIO(), io.StringIO()
    ok, err = True, ""
    saved_argv = sys.argv
    sys.argv = [script] + argv
    sys.stdin = io.StringIO(req.get("stdin") or "")
    sys.stdout, sys.stderr = cap, errcap
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit as e:
        if e.code not in (None, 0):
            ok, err = False, "exit %s" % e.code
    except BaseException:  # noqa: BLE001  スクリプトの例外はこの要求の失敗にして実行器は生かす
        ok, err = False, traceback.format_exc()[-2000:]
    finally:
        sys.stdout, sys.stderr, sys.stdin, sys.argv = REAL_OUT, REAL_ERR, REAL_IN, saved_argv
    send({"id": rid, "ok": ok, "out": cap.getvalue(), "err": (errcap.getvalue()[-2000:] + err),
          "ms": int((time.time() - t0) * 1000)})
