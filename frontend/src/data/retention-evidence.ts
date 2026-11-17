// 回访分析证据构建：回访曲线在这里由回访模式推导，数据视图快照通过这里取数，
// 形成「回访曲线 -> 回访模式 -> 回访分析/数据视图」的单一调用关系。
import type { EntryRow } from './types'
import type { RetentionPoint } from './view-control-types'

// 回访周期天字段在示例数据里可能是占位文本，解析失败时回落到默认周期。
function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

// 由单条回访模式生成回访曲线：以回访周期为步长，粘性逐周期衰减，
// 流失周期之后曲线归零——失效的流失周期会直接改变曲线形态，必须进复核流。
export function buildRetentionCurve(mode: EntryRow): RetentionPoint[] {
  const period = Math.max(1, toNumber(mode.回访周期天, 7))
  const frequency = String(mode.回访频次 ?? '未登记')
  const stickiness = Math.min(1, Math.max(0, toNumber(mode.粘性指数, 0.5) / 100 || toNumber(mode.粘性指数, 0.5)))
  const churnCycle = Math.max(1, toNumber(mode.流失周期, period * 4))
  const points: RetentionPoint[] = []
  for (let step = 1; step <= 4; step += 1) {
    const day = period * step
    const withinChurn = day <= churnCycle
    points.push({
      periodDay: day,
      retentionRate: withinChurn ? Number((stickiness * Math.pow(0.7, step - 1)).toFixed(4)) : 0,
      visitFrequency: frequency,
    })
  }
  return points
}

export type RetentionEvidence = {
  modeId: number
  modeCode: string
  curve: RetentionPoint[]
  churnCycle: number
  signature: string
}

// 单条模式的证据签名：流失周期等关键字段进入签名，字段一改签名就变，
// 固化快照里的旧签名可据此识别漂移。
export function buildRetentionEvidence(mode: EntryRow): RetentionEvidence {
  const curve = buildRetentionCurve(mode)
  const churnCycle = Math.max(1, toNumber(mode.流失周期, Math.max(1, toNumber(mode.回访周期天, 7)) * 4))
  return {
    modeId: Number(mode.id),
    modeCode: String(mode.模式编号 ?? `RETE-${mode.id}`),
    curve,
    churnCycle,
    signature: JSON.stringify({ churnCycle, curve }),
  }
}

export function buildRetentionEvidenceBatch(rows: EntryRow[]): RetentionEvidence[] {
  return rows
    .filter((row) => String(row.status) !== '已归档')
    .map((row) => buildRetentionEvidence(row))
}

// 对比固化签名与当前模式：返回发生漂移（含失效流失周期）的模式编号及原因。
export function diffRetentionEvidence(
  current: RetentionEvidence[],
  fixedSignatures: Record<number, string>,
): { modeId: number; modeCode: string; reason: string }[] {
  const drift: { modeId: number; modeCode: string; reason: string }[] = []
  for (const evidence of current) {
    const fixed = fixedSignatures[evidence.modeId]
    if (fixed && fixed !== evidence.signature) {
      drift.push({
        modeId: evidence.modeId,
        modeCode: evidence.modeCode,
        reason: `回访模式 ${evidence.modeCode} 的流失周期/回访曲线已变更，固化快照数据失效，需要两页同时纠正`,
      })
    }
  }
  return drift
}
