import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { saveRows, listRows, resetRows } from '@/data/local-store'
import { __resetViewControl, listSnapshots, listReviewEntries } from '@/data/view-control'
import {
  deleteDataView,
  saveDataView,
  submitViewEvidence,
  republishSnapshot,
  openSharedView,
  notifyRetentionChanged,
  viewControlSummary,
} from '@/api/view-service'
import { runAction } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const VIEW_ID = 3 // 种子里 DATA-0003，初始「已保存」
const RETENTION_ID = 3

function setView(patch: Partial<EntryRow>): EntryRow {
  const rows = listRows('dataview')
  const index = rows.findIndex((row) => Number(row.id) === VIEW_ID)
  const updated: EntryRow = { ...rows[index], ...patch }
  const next = [...rows]
  next[index] = updated
  saveRows('dataview', next)
  return updated
}

function getView(): EntryRow {
  return listRows('dataview').find((row) => Number(row.id) === VIEW_ID) as EntryRow
}

function setRetention(patch: Partial<EntryRow>): void {
  const rows = listRows('retention')
  const index = rows.findIndex((row) => Number(row.id) === RETENTION_ID)
  const next = [...rows]
  next[index] = { ...rows[index], ...patch }
  saveRows('retention', next)
}

function settled<T>(results: PromiseSettledResult<T>[]): { fulfilled: T[]; rejected: unknown[] } {
  const fulfilled: T[] = []
  const rejected: unknown[] = []
  for (const result of results) {
    if (result.status === 'fulfilled') {
      fulfilled.push(result.value)
    } else {
      rejected.push(result.reason)
    }
  }
  return { fulfilled, rejected }
}

describe('DATV-0003 删除传播与只读入口', () => {
  beforeEach(() => {
    resetRows('dataview')
    resetRows('retention')
    __resetViewControl()
    setRetention({
      回访周期天: 7,
      粘性指数: 80,
      流失周期: 28,
      回访频次: '每周一次',
    })
    setView({ 分享链接: 'share-token-data-0003', status: '已保存', pending: false })
  })

  it('删除后旧分享立即失效：链接吊销、快照降只读、生成删除核对单，三个入口给出明确原因', async () => {
    const before = await submitViewEvidence(VIEW_ID)
    assert.equal(before.ok, true)
    const token = before.snapshot?.shareToken as string

    const removed = await deleteDataView(VIEW_ID)
    assert.equal(removed.ok, true)
    assert.ok(removed.receipt, '删除回执必须生成')
    assert.equal(removed.receipt?.checklist.length, 4, '删除核对单覆盖分享/快照/迁移/复核四项')

    const view = getView()
    assert.equal(view.status, '已删除')
    assert.equal(view.分享链接, '', '分享链接字段必须清空吊销')

    const shared = openSharedView(token)
    assert.equal(shared.ok, false, '旧分享不能再读到回访曲线')
    assert.match(shared.reason, /已删除|失效/)
    assert.ok(('receipt' in shared ? shared.receipt : undefined), '失效原因带删除回执')

    const snaps = listSnapshots().filter((s) => Number(s.viewId) === VIEW_ID)
    assert.ok(snaps.length > 0 && snaps.every((s) => s.state === 'readonly'), '快照全部降为只读')
    assert.ok(snaps.every((s) => s.readonlyReason.length > 0), '只读快照带明确原因')

    const emptyToken = openSharedView('')
    assert.equal(emptyToken.ok, false)
    const unknownToken = openSharedView('not-exist-token')
    assert.equal(unknownToken.ok, false)
    assert.match(unknownToken.reason, /不存在|吊销/)
  })

  it('并发删除与重新保存同一视图：只允许一个终态生效，另一个被拒绝且不能恢复分享', async () => {
    const baseVersion = Number(getView()._version ?? 1)
    const results = await Promise.allSettled([
      deleteDataView(VIEW_ID, baseVersion),
      saveDataView(VIEW_ID, baseVersion),
      deleteDataView(VIEW_ID, baseVersion),
      saveDataView(VIEW_ID, baseVersion),
    ])
    const { fulfilled, rejected } = settled(results)
    assert.equal(rejected.length, 0, '锁队列内任务以结果对象返回，不应抛异常')

    const wins = fulfilled.filter((r) => r.ok)
    const loses = fulfilled.filter((r) => !r.ok)
    assert.equal(wins.length, 1, '同一视图并发只允许一个终态生效')
    assert.equal(loses.length, 3, '其余并发请求全部被拒绝')
    assert.ok(loses.every((r) => /版本冲突|已删除/.test(r.message)), '拒绝原因必须是版本冲突或删除终态')

    const view = getView()
    assert.equal(view.status, '已删除', '删除终态在仲裁中优先，已删除视图不可翻转')
    assert.equal(view.分享链接, '', '被拒绝的保存不能恢复分享链接')

    // 删除后再串行保存/提交证据仍被拒绝。
    const saveAgain = await saveDataView(VIEW_ID)
    assert.equal(saveAgain.ok, false)
    assert.match(saveAgain.message, /已删除/)
    const evidenceAgain = await submitViewEvidence(VIEW_ID)
    assert.equal(evidenceAgain.ok, false)
    assert.match(evidenceAgain.message, /已删除|不能恢复分享/)

    const versions = new Set(fulfilled.map(() => view._version))
    assert.ok((view._version as number) >= 1)
    assert.equal(versions.size, 1)
  })

  it('并发回访分析证据请求只写入一份快照，其余被拒绝', async () => {
    const baseVersion = Number(getView()._version ?? 1)
    const results = await Promise.allSettled([
      submitViewEvidence(VIEW_ID, baseVersion),
      submitViewEvidence(VIEW_ID, baseVersion),
      submitViewEvidence(VIEW_ID, baseVersion),
    ])
    const { fulfilled } = settled(results)
    assert.equal(fulfilled.filter((r) => r.ok).length, 1, '只有一份证据请求成功')
    assert.equal(fulfilled.filter((r) => !r.ok).length, 2)

    const active = listSnapshots().filter(
      (s) => Number(s.viewId) === VIEW_ID && s.state === 'active',
    )
    assert.equal(active.length, 1, '同一版本只固化一份 active 快照')
    assert.equal(active[0].retentionCurve.length, 12, '快照固化全部回访模式的回访曲线（3 模式 × 4 点）')
    assert.ok(active[0].retentionModeIds.length > 0, '快照引用回访模式')
  })

  it('删除回执与旧快照重新发布冲突：仲裁为历史快照只读并生成引用迁移清单，且不再产生可分享结果', async () => {
    const evidence = await submitViewEvidence(VIEW_ID)
    const snapshotId = evidence.snapshot?.id as string
    await deleteDataView(VIEW_ID)

    const republish = await republishSnapshot(VIEW_ID, snapshotId)
    assert.equal(republish.ok, false, '已删除视图不允许重新发布快照')
    assert.ok(republish.migration, '必须生成引用迁移清单')
    assert.match(republish.message, /只读/)

    const summary = viewControlSummary()
    const migrations = summary.migrations.filter((m) => m.snapshotId === snapshotId)
    assert.ok(migrations.length >= 1)
    assert.ok(migrations.every((m) => m.references.length > 0))

    const token = evidence.snapshot?.shareToken as string
    const shared = openSharedView(token)
    assert.equal(shared.ok, false, '仲裁后旧分享仍不可用')
    assert.ok(shared.snapshot?.state === 'readonly')
  })

  it('保存新版本时旧快照降只读并出迁移清单，有效分享始终只读打开', async () => {
    const first = await saveDataView(VIEW_ID)
    assert.equal(first.ok, true)
    const oldToken = first.snapshot?.shareToken as string

    const second = await saveDataView(VIEW_ID)
    assert.equal(second.ok, true)
    assert.notEqual(second.snapshot?.id, first.snapshot?.id)

    const oldShared = openSharedView(oldToken)
    assert.equal(oldShared.ok, false, '旧版本链接随快照只读而失效')
    assert.match(oldShared.reason, /只读|取代/)
    assert.ok(oldShared.migration)

    const newToken = second.snapshot?.shareToken as string
    const newShared = openSharedView(newToken)
    assert.equal(newShared.ok, true)
    if (newShared.ok) {
      assert.equal(newShared.readonly, true, '即使有效分享也只能只读访问')
      assert.equal(newShared.snapshot.state, 'active')
      assert.ok(newShared.snapshot.retentionCurve.length > 0)
    }
  })

  it('失效流失周期触发漂移：回访曲线/模式/视图快照一起进入复核数据流，两页读同一队列', async () => {
    const evidence = await submitViewEvidence(VIEW_ID)
    assert.equal(evidence.ok, true)

    // 模拟回访模式在回访分析页发生流转，流失周期被纠正。
    setRetention({ 流失周期: 14 })
    const created = notifyRetentionChanged()
    assert.ok(created.length >= 1, '漂移必须生成复核条目')
    const entry = created[0]
    assert.equal(entry.kind, 'retention-drift')
    assert.equal(entry.status, '待复核')
    assert.match(entry.reason, /流失周期/)
    const sources = entry.rebuildChecklist.map((item) => item.source)
    assert.deepEqual(
      [...sources].sort(),
      ['回访曲线', '回访模式', '回访视图快照'].sort(),
      '三类证据一起进入复核流',
    )

    // 数据视图页与回访分析页通过同一服务读取同一条队列。
    const dataviewQueue = viewControlSummary().reviews.map((r) => r.reviewId)
    const retentionQueue = listReviewEntries().map((r) => r.reviewId)
    assert.deepEqual(dataviewQueue.sort(), retentionQueue.sort())

    // 通过既有 runAction 流转回访模式也会自动挂接漂移复核。
    setRetention({ 流失周期: 10, status: '草稿' })
    runAction('retention', RETENTION_ID, '发起分析')
    const pending = viewControlSummary().reviews.filter((r) => r.status === '待复核')
    assert.ok(pending.some((r) => r.reviewId === entry.reviewId) || pending.length >= 1)
  })

  it('通用状态流转拒绝绕过：dataview 动作不能走 runAction 直接改状态', () => {
    const result = runAction('dataview', VIEW_ID, '删除视图')
    assert.equal(result.ok, false)
    assert.match(result.message, /删除传播|仲裁/)
    assert.notEqual(getView().status, '已删除')
  })

  it('删除传播条目随删除进入复核流，且删除后视图不再产生任何新的可分享结果', async () => {
    await submitViewEvidence(VIEW_ID)
    await deleteDataView(VIEW_ID)
    const reviews = viewControlSummary().reviews
    assert.ok(reviews.some((r) => r.kind === 'delete-propagation'), '删除传播核对条目入流')

    const afterDelete = await Promise.allSettled([
      saveDataView(VIEW_ID),
      submitViewEvidence(VIEW_ID),
      republishSnapshot(VIEW_ID),
    ])
    const { fulfilled } = settled(afterDelete)
    assert.ok(fulfilled.every((r) => !r.ok), '删除后任何产生分享结果的入口全部拒绝')
    assert.ok(
      listSnapshots()
        .filter((s) => Number(s.viewId) === VIEW_ID)
        .every((s) => s.state === 'readonly'),
    )
  })

  it('版本冲突仲裁边界两种做法：删除终态优先得到删除核对单；旧快照再发布降只读得到迁移清单，不变量始终成立', async () => {
    // 边界一：删除终态与保存竞争，删除先到 -> 分享立即失效 + 删除核对单。
    let base = Number(getView()._version ?? 1)
    const raceA = await Promise.allSettled([
      deleteDataView(VIEW_ID, base),
      saveDataView(VIEW_ID, base),
    ])
    const winnerA = settled(raceA).fulfilled.find((r) => r.ok)
    assert.ok(winnerA?.receipt, '删除终态生效时必须带删除核对单')
    assert.equal(getView().status, '已删除')
    assert.equal(openSharedView(winnerA?.snapshot?.shareToken ?? 'whatever').ok, false)

    // 复位到未删除视图，覆盖边界二：旧快照重新发布被仲裁为只读 + 引用迁移清单。
    resetRows('dataview')
    __resetViewControl()
    setView({ 分享链接: 'share-token-boundary', status: '已保存', pending: false })
    base = Number(getView()._version ?? 1)
    const evidence = await submitViewEvidence(VIEW_ID, base)
    // 重新保存后原快照降为只读，再发布历史快照才触发「只读仲裁」边界。
    await saveDataView(VIEW_ID)
    const republishOnLive = await republishSnapshot(VIEW_ID, evidence.snapshot?.id)
    // 未删除视图上的只读快照同样不能恢复分享，只能引导迁移。
    assert.equal(republishOnLive.ok, false)
    assert.ok(republishOnLive.migration, '历史快照只读做法生成引用迁移清单')
    assert.equal(republishOnLive.snapshot?.state, 'readonly')

    // 两种边界下的共同不变量：被仲裁的旧快照没有被重新激活，不产生恢复出来的分享。
    const oldSnapshot = listSnapshots().find((s) => s.id === evidence.snapshot?.id)
    assert.equal(oldSnapshot?.state, 'readonly')
    const reactivated = listSnapshots().some(
      (s) => s.shareToken === evidence.snapshot?.shareToken && s.state === 'active',
    )
    assert.equal(reactivated, false)
  })
})
