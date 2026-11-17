<template>
  <section class="page" data-module="dataview">
    <header class="page-head">
      <div>
        <h2>数据视图管理</h2>
        <p class="page-desc">管理可定制和分享的数据分析视图，组合多个数据源、过滤条件和度量。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记分析视图</button>
        <button class="btn" type="button" @click="exportRows">导出数据视图清单</button>
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
          <th>当前状态</th>
          <th>失效原因</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-deleted': isDeleted(row) }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '分享链接'">
              <span v-if="isDeleted(row)" class="error-text">已吊销：{{ failureReason(row) }}</span>
              <span v-else-if="readonlyReason(row)" class="muted-text">只读：{{ readonlyReason(row) }}</span>
              <RouterLink v-else :to="shareRoute(row)" class="link">{{ row[column] ?? '—' }}</RouterLink>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            {{ row.status }}
            <span v-if="isDeleted(row)" class="invalid-tag">终态</span>
          </td>
          <td>
            <span v-if="failureReason(row)" class="error-text">{{ failureReason(row) }}</span>
            <span v-else-if="readonlyReason(row)" class="muted-text">{{ readonlyReason(row) }}</span>
            <span v-else>—</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="isDeleted(row)"
              :title="isDeleted(row) ? '已删除视图不再产生新的可分享结果' : ''"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无数据视图数据，可先登记分析视图</td>
        </tr>
      </tbody>
    </table>

    <section class="control-panel">
      <h3>删除核对单</h3>
      <p v-if="!summary.receipts.length" class="muted-text">暂无删除回执</p>
      <table v-else class="data-table">
        <thead>
          <tr><th>回执编号</th><th>视图编号</th><th>删除时间</th><th>核对项</th></tr>
        </thead>
        <tbody>
          <tr v-for="receipt in summary.receipts" :key="receipt.receiptId">
            <td>{{ receipt.receiptId }}</td>
            <td>{{ receipt.viewCode }}</td>
            <td>{{ receipt.deletedAt }}</td>
            <td>
              <ul class="check-list">
                <li v-for="item in receipt.checklist" :key="item.item">
                  {{ item.item }}：{{ item.result }}
                </li>
              </ul>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="control-panel">
      <h3>引用迁移清单（历史快照降为只读）</h3>
      <p v-if="!summary.migrations.length" class="muted-text">暂无引用迁移记录</p>
      <table v-else class="data-table">
        <thead>
          <tr><th>迁移编号</th><th>快照编号</th><th>原因</th><th>引用去向</th></tr>
        </thead>
        <tbody>
          <tr v-for="migration in summary.migrations" :key="migration.migrationId">
            <td>{{ migration.migrationId }}</td>
            <td>{{ migration.snapshotId }}</td>
            <td>{{ migration.reason }}</td>
            <td>
              <ul class="check-list">
                <li v-for="ref in migration.references" :key="ref.from">
                  {{ ref.from }} → {{ ref.to }}（{{ ref.note }}）
                </li>
              </ul>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="control-panel">
      <h3>回访视图复核数据流（回访曲线 · 回访模式 · 视图快照）</h3>
      <p v-if="!summary.reviews.length" class="muted-text">暂无待复核条目</p>
      <table v-else class="data-table">
        <thead>
          <tr><th>复核编号</th><th>类型</th><th>状态</th><th>原因</th><th>数据视图重建清单</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="review in summary.reviews" :key="review.reviewId">
            <td>{{ review.reviewId }}</td>
            <td>{{ reviewKindLabel(review.kind) }}</td>
            <td>
              {{ review.status }}
              <span v-if="review.status === '待复核'" class="invalid-tag">待办</span>
            </td>
            <td>{{ review.reason }}</td>
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
      <span>共 {{ total }} 条数据视图记录</span>
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
} from '@/api/local-service'
import {
  deleteDataView,
  markReviewReviewed,
  saveDataView,
  submitViewEvidence,
  viewControlSummary,
} from '@/api/view-service'
import type { EntryRow } from '@/data/types'
import type { ReviewEntry, ViewSnapshot } from '@/data/view-control-types'

const meta = moduleMeta('dataview')
const columns = ["视图编号", "视图名称", "数据源组合", "过滤条件集", "维度选择", "度量选择", "排序规则", "分享链接"]
const actions = ["提交视图评审", "保存视图", "删除视图"]
const statuses = ["草稿", "视图评审中", "已保存", "已删除"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const snapshots = ref<ViewSnapshot[]>([])
const control = ref<ReturnType<typeof viewControlSummary>>({
  snapshots: [],
  receipts: [],
  migrations: [],
  reviews: [],
})

const stats = computed(() => [
  { label: "分析视图总数", value: rows.value.length },
  { label: "已保存视图", value: rows.value.filter((row) => String(row.status) === "已保存").length },
  { label: "评审中视图", value: rows.value.filter((row) => String(row.status) === "视图评审中").length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const summary = computed(() => control.value)

function isDeleted(row: EntryRow): boolean {
  return String(row.status) === '已删除'
}

function activeSnapshot(row: EntryRow): ViewSnapshot | undefined {
  return snapshots.value.find(
    (snapshot) => Number(snapshot.viewId) === Number(row.id) && snapshot.state === 'active',
  )
}

function latestSnapshot(row: EntryRow): ViewSnapshot | undefined {
  const matched = snapshots.value.filter((snapshot) => Number(snapshot.viewId) === Number(row.id))
  return matched[matched.length - 1]
}

function failureReason(row: EntryRow): string {
  if (!isDeleted(row)) {
    return ''
  }
  const receipt = control.value.receipts.find((item) => Number(item.viewId) === Number(row.id))
  return receipt
    ? `删除终态已生效（回执 ${receipt.receiptId}），分享立即失效，快照降为只读`
    : '视图已删除，分享链接不可用'
}

function readonlyReason(row: EntryRow): string {
  if (isDeleted(row)) {
    return ''
  }
  return latestSnapshot(row)?.readonlyReason ?? ''
}

function shareRoute(row: EntryRow) {
  const snapshot = activeSnapshot(row)
  return { path: '/share', query: { token: snapshot?.shareToken ?? String(row.分享链接 ?? '') } }
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
  errorMessage.value = '分析视图登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const viewId = Number(row.id)
  const expectedVersion = Number(row._version ?? 1)
  const result =
    action === '删除视图'
      ? await deleteDataView(viewId, expectedVersion)
      : action === '保存视图'
        ? await saveDataView(viewId, expectedVersion)
        : await submitViewEvidence(viewId, expectedVersion)
  if (!result.ok) {
    errorMessage.value = result.message
  }
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
    snapshots.value = control.value.snapshots
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '数据视图列表读取失败'
  }
}

onMounted(reload)
</script>
