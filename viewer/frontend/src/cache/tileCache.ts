/**
 * タイルベースのブラウザキャッシュ
 *
 * タイルは 2 軸で識別する:
 *   - layer : 「どの層のノード/エッジか」= コンテンツの LOD 段（= autoLayer + 詳細オフセット）。
 *   - gz    : 「タイル格子の空間解像度」= カメラズームから決まる整数。タイル幅 = 1/2^gz。
 * この 2 つを分離するのが要点。従来は layer が両方を兼ねていたため、「詳細+N」で深い層を
 * 浅いズームのまま表示すると、格子だけが N 段細かくなりビューポート内タイル数が 4^N で爆発した。
 * gz をカメラズーム（autoLayer）由来にすることで、詳細オフセットや層移動をしても
 * ビューポート内タイル数は常に ≒K_TILES²（一定）に保たれる。
 *
 * キャッシュキーは "{layer}/{gz}/{tx}/{ty}"。層とズームの両方を含むので、
 *   - 同じズームで詳細オフセットだけ変える → gz 同一 / layer 変化 → 別エントリ（内容が違うので正しい）
 *   - 同じ層でズームを変える           → layer 同一 / gz 変化 → 別エントリ（格子が違うので正しい）
 * のいずれでもキャッシュが壊れず（幾何と内容が一意対応）、往復すれば LRU が残す限り再利用される。
 * clearLayer(layer) は "{layer}/" プレフィックス一致で当該層の全 gz を消す。
 *
 * データはテーブル単位で管理し、テーブルごとに独立した LRU 上限を持つ。
 */

import type { NodeData, EdgeData, Rect } from '../api/client'

// ── 型定義 ──────────────────────────────────────────────────────────────

type TileKey = string  // "{layer}/{gz}/{tx}/{ty}"

interface TileState {
  tables:   Set<string>                  // キャッシュ済みテーブル名
  lastUsed: number                       // Date.now() — LRU 管理用
  ids:      Map<string, Set<number>>     // table → ID集合
}

// ── 設定 ────────────────────────────────────────────────────────────────

// テーブルごとのタイル上限 (超えたら LRU 削除)
const TABLE_MAX_TILES: Record<string, number> = {
  nodes: 500,
  edges: 500,
}

// ── ストア (exported: GraphCanvas が直接参照・変更する) ──────────────────

export const nodeStore = new Map<number, NodeData>()
export const edgeStore = new Map<number, EdgeData>()

// ── 内部状態 ─────────────────────────────────────────────────────────────

// タイルごとの参照カウント: どのタイルが各 ID を保持しているか
const nodeRefs = new Map<number, number>()
const edgeRefs = new Map<number, number>()

const tileIndex = new Map<TileKey, TileState>()

// 現在 fetch 中のタイル (テーブルごと) — 重複 fetch 防止
const fetchingTiles: Record<string, Set<TileKey>> = {}

// ── タイル座標計算（幾何は gz のみに依存。layer とは独立） ──────────────────

function tileW(gz: number): number {
  return 1 / Math.pow(2, gz)
}

function mkKey(layer: number, gz: number, tx: number, ty: number): TileKey {
  return `${layer}/${gz}/${tx}/${ty}`
}

export function tileBbox(gz: number, tx: number, ty: number): Rect {
  const w = tileW(gz)
  return { x1: tx * w, x2: (tx + 1) * w, y1: ty * w, y2: (ty + 1) * w }
}

export function tilesForRect(gz: number, rect: Rect): Array<{ tx: number; ty: number }> {
  const w = tileW(gz)
  const txMin = Math.floor(rect.x1 / w)
  const txMax = Math.floor(rect.x2 / w)
  const tyMin = Math.floor(rect.y1 / w)
  const tyMax = Math.floor(rect.y2 / w)
  const out: Array<{ tx: number; ty: number }> = []
  for (let tx = txMin; tx <= txMax; tx++)
    for (let ty = tyMin; ty <= tyMax; ty++)
      out.push({ tx, ty })
  return out
}

// ── キャッシュ状態問い合わせ ───────────────────────────────────────────────

function isTileCached(layer: number, gz: number, tx: number, ty: number, table: string): boolean {
  return tileIndex.get(mkKey(layer, gz, tx, ty))?.tables.has(table) ?? false
}

/** 指定 rect 内で未キャッシュかつ未 fetch 中のタイル一覧を返す */
export function getMissingTiles(
  layer: number, gz: number, rect: Rect, table: string
): Array<{ tx: number; ty: number }> {
  const fetching = fetchingTiles[table] ?? new Set<TileKey>()
  return tilesForRect(gz, rect).filter(({ tx, ty }) => {
    const key = mkKey(layer, gz, tx, ty)
    return !fetching.has(key) && !isTileCached(layer, gz, tx, ty, table)
  })
}

/** 指定 rect 内の全タイルが（fetch 中でなく実際に）キャッシュ済みかを返す。
 *  層切替時の「新層が揃ったか」判定に使う（getMissingTiles は fetch 中を missing 扱いしないため不可）。*/
export function areTilesCached(layer: number, gz: number, rect: Rect, table: string): boolean {
  return tilesForRect(gz, rect).every(({ tx, ty }) => isTileCached(layer, gz, tx, ty, table))
}

/** fetch 開始をマーク */
export function markFetching(layer: number, gz: number, tx: number, ty: number, table: string) {
  if (!fetchingTiles[table]) fetchingTiles[table] = new Set()
  fetchingTiles[table].add(mkKey(layer, gz, tx, ty))
}

/** fetch 完了 (成否問わず) をアンマーク */
export function unmarkFetching(layer: number, gz: number, tx: number, ty: number, table: string) {
  fetchingTiles[table]?.delete(mkKey(layer, gz, tx, ty))
}

// ── データ格納 ────────────────────────────────────────────────────────────

/** fetch 結果をタイルキャッシュに格納し、必要なら LRU 削除を行う */
export function storeTileData(
  layer: number, gz: number, tx: number, ty: number, table: string,
  items: (NodeData | EdgeData)[], srcBbox?: Rect
) {
  const key = mkKey(layer, gz, tx, ty)
  if (!tileIndex.has(key)) {
    tileIndex.set(key, { tables: new Set(), lastUsed: Date.now(), ids: new Map() })
  }
  const tile = tileIndex.get(key)!
  tile.tables.add(table)
  tile.lastUsed = Date.now()
  // 診断用: このタイルを最後に埋めたクエリの矩形（union bbox）。
  // 「タイルを覆っていない矩形の結果で確定してしまった」を後から見分けるために残す。
  if (srcBbox) (tile as any).srcBbox = ((tile as any).srcBbox ?? {}), (tile as any).srcBbox[table] = srcBbox
  if (!tile.ids.has(table)) tile.ids.set(table, new Set())
  const tileIds = tile.ids.get(table)!

  const store = (table === 'nodes' ? nodeStore : edgeStore) as Map<number, any>
  const refs  = table === 'nodes' ? nodeRefs  : edgeRefs

  for (const item of items) {
    store.set(item.id, item)
    // 同一タイルへの重複追加はカウントしない
    if (!tileIds.has(item.id)) {
      tileIds.add(item.id)
      refs.set(item.id, (refs.get(item.id) ?? 0) + 1)
    }
  }

  evictLRU(table)
}

// ── LRU 削除 ──────────────────────────────────────────────────────────────

function evictLRU(table: string) {
  const maxTiles = TABLE_MAX_TILES[table] ?? 200
  // このテーブルをキャッシュしているタイルを lastUsed 昇順でソート
  const tiles = [...tileIndex.entries()]
    .filter(([, s]) => s.tables.has(table))
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)

  while (tiles.length > maxTiles) {
    const [key, state] = tiles.shift()!
    removeTileTable(key, state, table)
  }
}

function removeTileTable(key: TileKey, state: TileState, table: string) {
  const ids   = state.ids.get(table) ?? new Set<number>()
  const store = (table === 'nodes' ? nodeStore : edgeStore) as Map<number, any>
  const refs  = table === 'nodes' ? nodeRefs  : edgeRefs

  for (const id of ids) {
    const c = (refs.get(id) ?? 1) - 1
    if (c <= 0) { store.delete(id); refs.delete(id) }
    else refs.set(id, c)
  }
  state.ids.delete(table)
  state.tables.delete(table)
  if (state.tables.size === 0) tileIndex.delete(key)
}

// ── 描画用 ID 収集 ────────────────────────────────────────────────────────

/** 指定 rect に含まれるタイルから全 ID を収集して返す。lastUsed も更新する */
export function getVisibleIds(
  layer: number, gz: number, rect: Rect
): { nodeIds: Set<number>; edgeIds: Set<number> } {
  const nodeIds = new Set<number>()
  const edgeIds = new Set<number>()
  const now = Date.now()
  for (const { tx, ty } of tilesForRect(gz, rect)) {
    const tile = tileIndex.get(mkKey(layer, gz, tx, ty))
    if (!tile) continue
    tile.lastUsed = now
    tile.ids.get('nodes')?.forEach(id => nodeIds.add(id))
    tile.ids.get('edges')?.forEach(id => edgeIds.add(id))
  }
  return { nodeIds, edgeIds }
}

// ── レイヤ単位クリア (編集後レイヤ変更時) ────────────────────────────────────

/** 指定レイヤ（全 gz）の全タイルをすべてのテーブルについて削除する */
export function clearLayer(layer: number) {
  const prefix = `${layer}/`
  for (const [key, state] of [...tileIndex.entries()]) {
    if (key.startsWith(prefix)) {
      for (const table of [...state.tables]) {
        removeTileTable(key, state, table)
      }
    }
  }
}

// ── キャッシュ全体クリア (DB 切替時など) ────────────────────────────────────

// キャッシュの世代。clearCache() のたびに進む。
//
// このモジュールは **GraphCanvas の再マウントをまたいで生き残るシングルトン**なので、
// 「DB-A の fetch 実行中 → DB-B へ切替（unmount で clearCache）→ 遅れて届いた DB-A の応答が
// storeTileData で DB-B のキャッシュに入り、そのタイルが『取得済み』扱いになって
// DB-B の実データが二度と読まれない」という取り違えが起こりうる。
// 発行時の世代を控えておき、届いた時に変わっていたら捨てる（isCurrentGeneration）。
// ※ GraphCanvas には mapq/sel の陳腐化ガードが既にあるが、DB 切替では mapq/sel が変わらないので
//   あれでは防げない。
let generation = 0
export function currentGeneration(): number { return generation }
export function isCurrentGeneration(gen: number): boolean { return gen === generation }

export function clearCache() {
  generation++
  tileIndex.clear()
  nodeStore.clear()
  edgeStore.clear()
  nodeRefs.clear()
  edgeRefs.clear()
  for (const table of Object.keys(fetchingTiles)) {
    fetchingTiles[table].clear()
  }
}


/** 診断用: そのタイル **単体** が持つ id 数（境界共有の隣接を含めない正確な値）。 */
export function tileItemCount(layer: number, gz: number, tx: number, ty: number, table: string): number {
  return tileIndex.get(mkKey(layer, gz, tx, ty))?.ids.get(table)?.size ?? -1
}
/** 診断用: そのタイルを最後に埋めたクエリ矩形。 */
export function tileSrcBbox(layer: number, gz: number, tx: number, ty: number, table: string): Rect | null {
  return (tileIndex.get(mkKey(layer, gz, tx, ty)) as any)?.srcBbox?.[table] ?? null
}
