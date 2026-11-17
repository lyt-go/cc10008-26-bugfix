// 数据视图专用服务：删除传播、并发终态仲裁、回访分析视图快照单写、只读分享入口。
// 所有写操作都经过 withViewLock 串行化，同一视图同一时刻只有一个终态能生效。
import { listRows, saveRows } from '@/data/local-store'
import {
  buildRetentionEvidenceBatch,
  diffRetentionEvidence,
} from '@/data/retention-evidence'
import type { EntryRow } from '@/data/types'
import {
  appendReviewEntry,
  listMigrations,
  listReceipts,
  listReviewEntries,
  listSnapshots,
  nextId,
  nowStamp,
  saveMigration,
  saveReceipt,
  saveSnapshot,
  updateReviewEntries,
  withViewLock,
} from '@/data/view-control'
import type {
  DeleteReceipt,
  MigrationList,
  ReviewEntry,
  ViewSnapshot,
} from '@/data/view-control-types'

const DATAVIEW_KEY = 'dataview'
const RETENTION_KEY = 'retention'
const DELETED_STATUS = '已删除'
const SAVED_STATUS = '已保存'
const REVIEWING_STATUS = '视图评审中'

export type ControlResult = {
  ok: boolean
  message: string
  snapshot?: ViewSnapshot
  receipt?: DeleteReceipt
  migration?: MigrationList
  review?: ReviewEntry
}

export type SharedViewResult =
  | { ok: true; readonly: true; snapshot: ViewSnapshot; view: EntryRow }
  | {
      ok: false
      reason: string
      receipt?: DeleteReceipt
      migration?: MigrationList
      snapshot?: ViewSnapshot
    }

function readVersion(row: EntryRow): number {
  const version = Number(row._version ?? 1)
  return Number.isFinite(version) && version > 0 ? version : 1
}

function findView(viewId: number): { rows: EntryRow[]; index: number; view: EntryRow } | null {
  const rows = listRows(DATAVIEW_KEY)
  const index = rows.findIndex((row) => Number(row.id) === viewId)
  if (index < 0) {
    return null
  }
  return { rows, index, view: rows[index] }
}

function persistView(rows: EntryRow[], index: number, patch: Partial<EntryRow>): EntryRow {
  const current = rows[index]
  const updated: EntryRow = {
    ...current,
    ...patch,
    _version: readVersion(current) + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(DATAVIEW_KEY, next)
  return updated
}

function shareTokenOf(view: EntryRow): string {
  return String(view.分享链接 ?? '')
}

function snapshotForVersion(viewId: number, version: number): ViewSnapshot | undefined {
  return listSnapshots().find(
    (snapshot) => Number(snapshot.viewId) === viewId && snapshot.sourceVersion === version,
  )
}

// 固化一份回访分析视图数据快照：回访曲线、回访模式、视图快照来自同一份证据，
// 同一视图同一版本只允许存在一份 active 快照（并发提交时其余请求被拒绝）。
function freezeSnapshot(view: EntryRow): ViewSnapshot {
  const evidence = buildRetentionEvidenceBatch(listRows(RETENTION_KEY))
  const curve = evidence.flatMap((item) => item.curve)
  const signatures: Record<number, string> = {}
  for (const item of evidence) {
    signatures[item.modeId] = item.signature
  }
  const snapshot: ViewSnapshot = {
    id: nextId('SNAP'),
    viewId: Number(view.id),
    viewCode: String(view.视图编号 ?? `DATA-${view.id}`),
    viewName: String(view.视图名称 ?? ''),
    sourceVersion: readVersion(view),
    state: 'active',
    shareToken: shareTokenOf(view),
    createdAt: nowStamp(),
    retentionModeIds: evidence.map((item) => item.modeId),
    retentionCurve: curve,
    evidenceSummary: {
      curveCount: curve.length,
      modeCount: evidence.length,
      driftCount: 0,
    },
    readonlyReason: '',
    // 固化签名挂在快照上供漂移复核使用。
    retentionSignatures: signatures,
  }
  return saveSnapshot(snapshot)
}

function demoteActiveSnapshots(
  viewId: number,
  reason: string,
): { snapshots: ViewSnapshot[]; migrations: MigrationList[] } {
  const all = listSnapshots()
  const migrations: MigrationList[] = []
  for (const snapshot of all) {
    if (Number(snapshot.viewId) !== viewId || snapshot.state !== 'active') {
      continue
    }
    const demoted = saveSnapshot({
      ...snapshot,
      state: 'readonly',
      readonlyReason: reason,
    })
    const migration: MigrationList = {
      migrationId: nextId('MIGR'),
      viewId,
      snapshotId: demoted.id,
      reason,
      createdAt: nowStamp(),
      references: [
        {
          from: `分享链接 ${demoted.shareToken || '(已吊销)'}`,
          to: '只读历史快照',
          note: '旧引用迁移到只读快照，不再产生新的可分享结果',
        },
        {
          from: `回访视图快照 ${demoted.id}`,
          to: '数据视图重建清单',
          note: '回访曲线、回访模式随快照进入复核数据流后再重建',
        },
      ],
    }
    saveMigration(migration)
    migrations.push(migration)
  }
  return { snapshots: all, migrations }
}

function rebuildChecklist(snapshot: ViewSnapshot): ReviewEntry['rebuildChecklist'] {
  return [
    {
      source: '回访曲线',
      detail: `${snapshot.retentionCurve.length} 个回访曲线数据点，按当前回访模式重新计算`,
    },
    {
      source: '回访模式',
      detail: `引用模式编号 ${snapshot.retentionModeIds.join(', ') || '无'}，核对流失周期后回写`,
    },
    {
      source: '回访视图快照',
      detail: `快照 ${snapshot.id} 降为只读，重建后生成新版本快照`,
    },
  ]
}

// 提交视图评审（回访分析证据请求）：并发调用只写入一份快照，其余拒绝。
// expectedVersion 为调用方读取视图时的基准版本，同版本并发请求只有一个能固化快照。
export function submitViewEvidence(viewId: number, expectedVersion?: number): Promise<ControlResult> {
  return withViewLock(viewId, () => {
    const located = findView(viewId)
    if (!located) {
      return { ok: false, message: `没有找到编号为 ${viewId} 的分析视图` }
    }
    const { rows, index, view } = located
    if (String(view.status) === DELETED_STATUS) {
      return {
        ok: false,
        message: '分析视图已删除，回访分析证据请求被拒绝，且不能恢复分享链接',
      }
    }
    const baseVersion = readVersion(view)
    if (expectedVersion !== undefined && expectedVersion !== baseVersion) {
      return {
        ok: false,
        message: `版本冲突：视图已被其他请求更新到 v${baseVersion}，本次证据请求（基于 v${expectedVersion}）被拒绝`,
      }
    }
    const existing = snapshotForVersion(viewId, baseVersion)
    if (existing && existing.state === 'active') {
      return {
        ok: false,
        message: '该版本已固化回访分析视图数据快照，并发证据请求被拒绝，只保留一份快照',
        snapshot: existing,
      }
    }
    const updated = persistView(rows, index, {
      status: REVIEWING_STATUS,
      pending: true,
      abnormal: false,
      // 每次固化都换发新令牌：旧链接随旧快照降只读而失效，不能继续读到新数据。
      分享链接: `${shareTokenOf(view) || 'share'}-v${readVersion(view) + 1}`,
    })
    // persistView 会推进版本，快照以推进后的版本固化。
    const snapshot = freezeSnapshot(updated)
    return {
      ok: true,
      message: `回访分析证据已固化为快照 ${snapshot.id}，分享链接仍受视图状态约束`,
      snapshot,
    }
  })
}

// 重新保存视图：已删除视图一律拒绝，保证删除终态不可被保存动作翻转。
// expectedVersion 实现乐观并发：同版本并发保存只有一个终态生效。
export function saveDataView(viewId: number, expectedVersion?: number): Promise<ControlResult> {
  return withViewLock(viewId, () => {
    const located = findView(viewId)
    if (!located) {
      return { ok: false, message: `没有找到编号为 ${viewId} 的分析视图` }
    }
    const { rows, index, view } = located
    if (String(view.status) === DELETED_STATUS) {
      return {
        ok: false,
        message: '分析视图已删除，重新保存被拒绝，已删除视图不再产生新的可分享结果',
      }
    }
    const baseVersion = readVersion(view)
    if (expectedVersion !== undefined && expectedVersion !== baseVersion) {
      return {
        ok: false,
        message: `版本冲突：视图已被其他请求更新到 v${baseVersion}，本次保存（基于 v${expectedVersion}）被拒绝，只允许一个终态生效`,
      }
    }
    // 旧版本 active 快照先降只读并生成引用迁移清单，再推进版本。
    demoteActiveSnapshots(viewId, '视图重新保存，历史快照被新版本取代')
    const updated = persistView(rows, index, {
      status: SAVED_STATUS,
      pending: false,
      abnormal: false,
      // 重新保存换发新分享令牌，旧令牌只对应只读历史快照。
      分享链接: `${shareTokenOf(view) || 'share'}-v${readVersion(view) + 1}`,
    })
    const snapshot = freezeSnapshot(updated)
    return {
      ok: true,
      message: `视图已保存为版本 ${readVersion(updated)}，旧快照已降只读并生成引用迁移清单`,
      snapshot,
    }
  })
}

// 删除视图：删除终态立即生效，分享吊销、快照降只读、回执与复核条目一次写齐。
export function deleteDataView(viewId: number, expectedVersion?: number): Promise<ControlResult> {
  return withViewLock(viewId, () => {
    const located = findView(viewId)
    if (!located) {
      return { ok: false, message: `没有找到编号为 ${viewId} 的分析视图` }
    }
    const { rows, index, view } = located
    if (String(view.status) === DELETED_STATUS) {
      return { ok: false, message: '分析视图已经是「已删除」，删除终态不可重复写入' }
    }
    const baseVersion = readVersion(view)
    if (expectedVersion !== undefined && expectedVersion !== baseVersion) {
      return {
        ok: false,
        message: `版本冲突：视图已被其他请求更新到 v${baseVersion}，本次删除（基于 v${expectedVersion}）被拒绝`,
      }
    }
    const oldToken = shareTokenOf(view)
    const { migrations } = demoteActiveSnapshots(
      viewId,
      '分析视图已删除，历史快照降为只读且分享立即失效',
    )
    const updated = persistView(rows, index, {
      status: DELETED_STATUS,
      pending: false,
      abnormal: true,
      分享链接: '',
    })
    const readonlySnaps = listSnapshots().filter(
      (snapshot) => Number(snapshot.viewId) === viewId,
    )
    const receipt: DeleteReceipt = {
      receiptId: nextId('RCPT'),
      viewId,
      viewCode: String(updated.视图编号 ?? `DATA-${viewId}`),
      shareToken: oldToken,
      deletedAt: nowStamp(),
      finalState: DELETED_STATUS,
      checklist: [
        { item: '分享链接', result: `链接 ${oldToken || '(空)'} 已吊销，旧分享立即失效` },
        {
          item: '回访视图快照',
          result: `${readonlySnaps.filter((s) => s.state === 'readonly').length} 份快照全部降为只读，不再可分享`,
        },
        {
          item: '引用迁移',
          result: migrations.length > 0 ? `已生成 ${migrations.length} 份引用迁移清单` : '无历史引用需要迁移',
        },
        {
          item: '复核数据流',
          result: '删除传播条目已登记，回访曲线/回访模式/视图快照一并进入复核',
        },
      ],
    }
    saveReceipt(receipt)
    const latestSnapshot = readonlySnaps[readonlySnaps.length - 1]
    const review = appendReviewEntry({
      reviewId: nextId('REV'),
      viewId,
      snapshotId: latestSnapshot?.id ?? '',
      kind: 'delete-propagation',
      status: '待复核',
      createdAt: nowStamp(),
      reason: `视图 ${receipt.viewCode} 已删除，旧分享失效，按删除核对单完成传播复核`,
      rebuildChecklist: latestSnapshot ? rebuildChecklist(latestSnapshot) : [],
      retentionCurveVersion: latestSnapshot?.sourceVersion ?? readVersion(updated),
      retentionModeVersion: readVersion(updated),
      snapshotVersion: readVersion(updated),
    })
    // 该视图历史上未决的复核条目随删除一并收口。
    updateReviewEntries(
      (entry) => Number(entry.viewId) === viewId && entry.status === '待复核',
      { status: '已复核' },
    )
    return {
      ok: true,
      message: `分析视图已删除，分享链接立即失效，删除核对单 ${receipt.receiptId} 已生成`,
      receipt,
      migration: migrations[0],
      review,
    }
  })
}

// 旧快照重新发布：已删除视图不允许恢复可分享结果，快照只能降为只读并出迁移清单。
export function republishSnapshot(viewId: number, snapshotId?: string): Promise<ControlResult> {
  return withViewLock(viewId, () => {
    const located = findView(viewId)
    if (!located) {
      return { ok: false, message: `没有找到编号为 ${viewId} 的分析视图` }
    }
    const { view } = located
    const target = listSnapshots().find(
      (snapshot) =>
        Number(snapshot.viewId) === viewId && (snapshotId ? snapshot.id === snapshotId : true),
    )
    if (!target) {
      return { ok: false, message: '没有可重新发布的历史快照' }
    }
    if (String(view.status) === DELETED_STATUS) {
      // 仲裁边界落在「历史快照只读」：拒绝恢复分享，登记引用迁移清单。
      const readonly = target.state === 'readonly' ? target : saveSnapshot({
        ...target,
        state: 'readonly',
        readonlyReason: '视图已删除，重新发布被仲裁为只读历史快照',
      })
      const migration: MigrationList = {
        migrationId: nextId('MIGR'),
        viewId,
        snapshotId: readonly.id,
        reason: '删除回执与旧快照重新发布冲突，仲裁为历史快照只读',
        createdAt: nowStamp(),
        references: [
          {
            from: `旧分享 ${readonly.shareToken || '(已吊销)'}`,
            to: '只读历史快照',
            note: '已删除视图不再产生新的可分享结果，引用须迁移到替代视图',
          },
        ],
      }
      saveMigration(migration)
      return {
        ok: false,
        message: '视图已删除，旧快照重新发布被拒绝，快照降为只读并生成引用迁移清单',
        snapshot: readonly,
        migration,
      }
    }
    if (target.state === 'active') {
      return { ok: false, message: '快照仍为可分享状态，无需重新发布', snapshot: target }
    }
    const migration: MigrationList = {
      migrationId: nextId('MIGR'),
      viewId,
      snapshotId: target.id,
      reason: '历史快照重新发布前保持只读，引用迁移到当前版本',
      createdAt: nowStamp(),
      references: [
        {
          from: `只读快照 ${target.id}`,
          to: `视图当前版本 ${readVersion(view)}`,
          note: '只读快照不可恢复分享，请通过保存视图生成新版本快照',
        },
      ],
    }
    saveMigration(migration)
    return {
      ok: false,
      message: '历史快照为只读，不能直接重新发布，请重新保存视图生成新快照',
      snapshot: target,
      migration,
    }
  })
}

// 只读分享入口：所有分享访问都是只读；删除/被取代的链接给出明确失效原因。
export function openSharedView(token: string): SharedViewResult {
  const normalized = token.trim()
  if (!normalized) {
    return { ok: false, reason: '分享链接为空，无法打开分析视图' }
  }
  const snapshot = listSnapshots().find((item) => item.shareToken === normalized)
  const receipt = listReceipts().find((item) => item.shareToken === normalized)
  if (!snapshot) {
    if (receipt) {
      return {
        ok: false,
        reason: `视图 ${receipt.viewCode} 已删除，分享链接已于 ${receipt.deletedAt} 失效`,
        receipt,
      }
    }
    return { ok: false, reason: '分享链接不存在或已被吊销，无法读取回访曲线与视图数据' }
  }
  const view = listRows(DATAVIEW_KEY).find((row) => Number(row.id) === Number(snapshot.viewId))
  const migration = listMigrations().find((item) => item.snapshotId === snapshot.id)
  if (snapshot.state === 'readonly' || view?.status === DELETED_STATUS) {
    return {
      ok: false,
      reason: view?.status === DELETED_STATUS
        ? '分析视图已删除，分享立即失效，仅保留只读历史快照供核对'
        : '该快照已被新版本取代，已降为只读，不提供可分享数据',
      receipt,
      migration,
      snapshot,
    }
  }
  return { ok: true, readonly: true, snapshot, view: view as EntryRow }
}

// 回访模式发生流转后调用：比对固化签名，失效流失周期/曲线漂移进入复核数据流，
// 数据视图页与回访分析页读取同一条队列，实现两页同时纠正。
export function notifyRetentionChanged(): ReviewEntry[] {
  const evidence = buildRetentionEvidenceBatch(listRows(RETENTION_KEY))
  const created: ReviewEntry[] = []
  for (const snapshot of listSnapshots()) {
    const signatures = snapshot.retentionSignatures
    if (!signatures || snapshot.state !== 'active') {
      continue
    }
    const drift = diffRetentionEvidence(evidence, signatures)
    if (drift.length === 0) {
      continue
    }
    const alreadyPending = listReviewEntries().some(
      (entry) =>
        entry.snapshotId === snapshot.id &&
        entry.kind === 'retention-drift' &&
        entry.status === '待复核',
    )
    if (alreadyPending) {
      continue
    }
    saveSnapshot({ ...snapshot, evidenceSummary: { ...snapshot.evidenceSummary, driftCount: drift.length } })
    const entry = appendReviewEntry({
      reviewId: nextId('REV'),
      viewId: Number(snapshot.viewId),
      snapshotId: snapshot.id,
      kind: 'retention-drift',
      status: '待复核',
      createdAt: nowStamp(),
      reason: drift.map((item) => item.reason).join('；'),
      rebuildChecklist: rebuildChecklist(snapshot),
      retentionCurveVersion: snapshot.sourceVersion,
      retentionModeVersion: snapshot.sourceVersion + 1,
      snapshotVersion: snapshot.sourceVersion,
    })
    created.push(entry)
  }
  return created
}

// 页面汇总数据：视图列表、回访页、旧分享入口共用同一份控制面状态。
export function viewControlSummary() {
  return {
    snapshots: listSnapshots(),
    receipts: listReceipts(),
    migrations: listMigrations(),
    reviews: listReviewEntries(),
  }
}

export function markReviewReviewed(reviewId: string): boolean {
  return (
    updateReviewEntries((entry) => entry.reviewId === reviewId, { status: '已复核' }) > 0
  )
}
