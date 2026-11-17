// 删除传播与回访分析视图快照相关的公共类型。

// 快照的可访问性终态：固化时可分享；视图删除或被新版本取代后降为只读。
export type SnapshotState = 'active' | 'readonly'

// 回访曲线数据点：由回访模式推导，随快照一起固化，供复核数据流比对。
export type RetentionPoint = {
  periodDay: number
  retentionRate: number
  visitFrequency: string
}

export type ViewSnapshot = {
  id: string
  viewId: number
  viewCode: string
  viewName: string
  // 生成快照时分析视图的版本号，用于并发冲突仲裁。
  sourceVersion: number
  state: SnapshotState
  shareToken: string
  createdAt: string
  // 固化时视图引用的回访模式（含流失周期），模式改动后据此发现漂移。
  retentionModeIds: number[]
  retentionCurve: RetentionPoint[]
  evidenceSummary: {
    curveCount: number
    modeCount: number
    driftCount: number
  }
  readonlyReason: string
  // 固化时各回访模式的证据签名（流失周期/曲线），模式改动后据此识别漂移。
  retentionSignatures?: Record<number, string>
}

// 删除回执：删除终态生效后立即生成，旧分享据此失效并给出明确原因。
export type DeleteReceipt = {
  receiptId: string
  viewId: number
  viewCode: string
  shareToken: string
  deletedAt: string
  finalState: '已删除'
  // 删除核对单条目：快照、分享、复核流各自核对到的处理结果。
  checklist: { item: string; result: string }[]
}

// 引用迁移清单：历史快照降为只读后，旧引用需要迁移到替代视图或新快照。
export type MigrationList = {
  migrationId: string
  viewId: number
  snapshotId: string
  reason: string
  createdAt: string
  references: { from: string; to: string; note: string }[]
}

// 复核数据流条目：回访曲线、回访模式、回访视图快照三者一起进入同一复核流。
export type ReviewEntry = {
  reviewId: string
  viewId: number
  snapshotId: string
  kind: 'retention-drift' | 'snapshot-rebuild' | 'delete-propagation'
  status: '待复核' | '已复核'
  createdAt: string
  reason: string
  // 重建清单：该视图可据此重建数据视图。
  rebuildChecklist: { source: string; detail: string }[]
  retentionCurveVersion: number
  retentionModeVersion: number
  snapshotVersion: number
}
