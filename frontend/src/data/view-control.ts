// 数据视图删除传播、回访分析视图快照、只读分享入口的控制面数据层。
// 浏览器里持久化到 localStorage；Node 测试环境没有 localStorage 时退化为进程内内存。
import type { RetentionPoint, ReviewEntry, ViewSnapshot } from './view-control-types'

const SNAPSHOT_KEY = 'behavior-event-trace-hub:view-snapshots'
const RECEIPT_KEY = 'behavior-event-trace-hub:delete-receipts'
const MIGRATION_KEY = 'behavior-event-trace-hub:migration-lists'
const REVIEW_KEY = 'behavior-event-trace-hub:review-flow'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const memory = new Map<string, unknown[]>()

function hasLocalStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function readCollection<T>(storageKey: string): T[] {
  if (!hasLocalStorage()) {
    return clone((memory.get(storageKey) as T[] | undefined) ?? [])
  }
  const raw = window.localStorage.getItem(storageKey)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as T[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeCollection<T>(storageKey: string, rows: T[]): void {
  const frozen = clone(rows)
  if (!hasLocalStorage()) {
    memory.set(storageKey, frozen)
    return
  }
  window.localStorage.setItem(storageKey, JSON.stringify(frozen))
}

// 按分析视图编号串行化所有写操作：同一视图的并发请求排队执行，任务内部再读最新状态仲裁。
const locks = new Map<number, Promise<unknown>>()

export function withViewLock<T>(viewId: number, task: () => T | Promise<T>): Promise<T> {
  const previous = locks.get(viewId) ?? Promise.resolve()
  const current = previous.then(
    () => task(),
    () => task(),
  )
  // 队列自身不能因为单个任务失败而断裂，失败结果仍由 current 原样返回给调用方。
  locks.set(
    viewId,
    current.then(
      () => undefined,
      () => undefined,
    ),
  )
  return current
}

export function listSnapshots(): ViewSnapshot[] {
  return readCollection<ViewSnapshot>(SNAPSHOT_KEY)
}

export function saveSnapshot(snapshot: ViewSnapshot): ViewSnapshot {
  const rows = readCollection<ViewSnapshot>(SNAPSHOT_KEY)
  const index = rows.findIndex((item) => item.id === snapshot.id)
  if (index >= 0) {
    rows[index] = clone(snapshot)
  } else {
    rows.push(clone(snapshot))
  }
  writeCollection(SNAPSHOT_KEY, rows)
  return clone(snapshot)
}

export function listReceipts() {
  return readCollection<import('./view-control-types').DeleteReceipt>(RECEIPT_KEY)
}

export function saveReceipt(receipt: import('./view-control-types').DeleteReceipt): void {
  const rows = readCollection<import('./view-control-types').DeleteReceipt>(RECEIPT_KEY)
  const index = rows.findIndex((item) => item.viewId === receipt.viewId)
  if (index >= 0) {
    rows[index] = clone(receipt)
  } else {
    rows.push(clone(receipt))
  }
  writeCollection(RECEIPT_KEY, rows)
}

export function listMigrations() {
  return readCollection<import('./view-control-types').MigrationList>(MIGRATION_KEY)
}

export function saveMigration(migration: import('./view-control-types').MigrationList): void {
  const rows = readCollection<import('./view-control-types').MigrationList>(MIGRATION_KEY)
  rows.push(clone(migration))
  writeCollection(MIGRATION_KEY, rows)
}

export function listReviewEntries(): ReviewEntry[] {
  return readCollection<ReviewEntry>(REVIEW_KEY)
}

export function appendReviewEntry(entry: ReviewEntry): ReviewEntry {
  const rows = readCollection<ReviewEntry>(REVIEW_KEY)
  rows.push(clone(entry))
  writeCollection(REVIEW_KEY, rows)
  return clone(entry)
}

export function updateReviewEntries(
  predicate: (entry: ReviewEntry) => boolean,
  patch: Partial<ReviewEntry>,
): number {
  const rows = readCollection<ReviewEntry>(REVIEW_KEY)
  let touched = 0
  for (const row of rows) {
    if (predicate(row)) {
      Object.assign(row, patch)
      touched += 1
    }
  }
  if (touched > 0) {
    writeCollection(REVIEW_KEY, rows)
  }
  return touched
}

let sequence = 0

export function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence}`
}

export function nowStamp(): string {
  return new Date().toISOString()
}

// 回访证据的类型重导出，页面与服务层统一从这里取类型。
export type { RetentionPoint, ReviewEntry, ViewSnapshot } from './view-control-types'

// 仅供测试：清空控制面全部数据与锁队列。
export function __resetViewControl(): void {
  memory.clear()
  locks.clear()
  sequence = 0
}
