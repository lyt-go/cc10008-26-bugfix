<template>
  <section class="page" data-module="retention">
    <header class="page-head">
      <div>
        <h2>回访分析管理</h2>
        <p class="page-desc">分析用户回访行为模式，计算粘性指数和流失周期；流失周期变更会触发回访曲线复核。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记回访模式</button>
        <button class="btn" type="button" @click="exportRows">导出回访分析清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>回访曲线</th>
          <th>当前状态</th>
          <th>失效/漂移原因</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-drifted': driftReason(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <ul class="curve-list">
              <li v-for="point in curveOf(row)" :key="point.periodDay">
                第{{ point.periodDay }}天 留存率 {{ (point.retentionRate * 100).toFixed(1) }}%
              </li>
            </ul>
          </td>
          <td>
            {{ row.status }}
            <span v-if="driftReason(row)" class="invalid-tag">待纠正</span>
          </td>
          <td>
            <span v-if="driftReason(row)" class="error-text">{{ driftReason(row) }}</span>
            <span v-else-if="archivedByDeletion(row)" class="muted-text">引用它的分析视图已删除，快照只读</span>
            <span v-else>—</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无回访分析数据，可先登记回访模式</td>
        </tr>
      </tbody>
    </table>

    <section class="control-panel">
      <h3>回访视图复核数据流（回访曲线 · 回访模式 · 回访视图快照）</h3>
      <p v-if="!reviews.length" class="muted-text">暂无复核条目；固化快照后若流失周期变更，这里会列出需要两页同时纠正的记录</p>
      <table v-else class="data-table">
        <thead>
          <tr><th>复核编号</th><th>类型</th><th>状态</th><th>失效原因</th><th>数据视图重建清单</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="review in reviews" :key="review.reviewId">
            <td>{{ review.reviewId }}</td>
            <td>{{ reviewKindLabel(review.kind) }}</td>
            <td>{{ review.status }}</td>
            <td class="error-text">{{ review.reason }}</td>
            <td>
              <ul class="check-list">
                <li v-for="item in review.rebuildChecklist" :key="item.source">
                  {{ item.source }}：{{ item.detail }}
                </li>
              </ul>
            </td>
            <td>
              <button
                v-if="review.status === '待复核'"
                class="link"
                type="button"
                @click="confirmReview(review.reviewId)"
              >
                确认复核
              </button>
              <span v-else class="muted-text">已收口</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条回访分析记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { markReviewReviewed, viewControlSummary } from '@/api/view-service'
import { buildRetentionCurve } from '@/data/retention-evidence'
import type { EntryRow } from '@/data/types'
import type { RetentionPoint, ReviewEntry } from '@/data/view-control-types'

const meta = moduleMeta('retention')
const columns = ["模式编号", "用户分群", "首次访问窗口", "回访周期天", "回访频次", "粘性指数", "流失周期", "唤醒策略"]
const actions = ["发起分析", "确认模式", "归档模式"]
const statuses = ["草稿", "分析中", "已确认", "已归档"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const control = ref<ReturnType<typeof viewControlSummary>>({
  snapshots: [],
  receipts: [],
  migrations: [],
  reviews: [],
})
const reviews = computed(() => control.value.reviews)

const stats = computed(() => [
  { label: "回访模式总数", value: rows.value.length },
  { label: "已确认模式", value: rows.value.filter((row) => String(row.status) === "已确认").length },
  { label: "分析中模式", value: rows.value.filter((row) => String(row.status) === "分析中").length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const curveCache = new Map<number, RetentionPoint[]>()

function curveOf(row: EntryRow): RetentionPoint[] {
  const key = Number(row.id)
  const cached = curveCache.get(key)
  if (cached) {
    return cached
  }
  const curve = buildRetentionCurve(row)
  curveCache.set(key, curve)
  return curve
}

// 待复核的漂移条目里提到该模式编号时，页面给出明确失效原因。
function driftReason(row: EntryRow): string {
  const code = String(row.模式编号 ?? '')
  const hit = reviews.value.find(
    (review) => review.status === '待复核' && review.reason.includes(code),
  )
  return hit ? hit.reason : ''
}

// 已归档模式若仍被某份只读快照引用，提示其引用视图已删除，数据仅留档只读。
function archivedByDeletion(row: EntryRow): boolean {
  if (String(row.status) !== '已归档') {
    return false
  }
  const modeId = Number(row.id)
  return control.value.snapshots.some(
    (snapshot) =>
      snapshot.state === 'readonly' &&
      snapshot.retentionModeIds.includes(modeId) &&
      control.value.receipts.some((receipt) => Number(receipt.viewId) === Number(snapshot.viewId)),
  )
}

function reviewKindLabel(kind: ReviewEntry['kind']): string {
  const labels: Record<ReviewEntry['kind'], string> = {
    'retention-drift': '回访漂移复核',
    'snapshot-rebuild': '快照重建',
    'delete-propagation': '删除传播核对',
  }
  return labels[kind]
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '回访模式登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  curveCache.delete(Number(row.id))
  reload()
}

function confirmReview(reviewId: string) {
  markReviewReviewed(reviewId)
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    control.value = viewControlSummary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '回访分析列表读取失败'
  }
}

onMounted(reload)
</script>
