<template>
  <section class="page" data-module="share-entry">
    <header class="page-head">
      <div>
        <h2>分享视图（只读入口）</h2>
        <p class="page-desc">旧分享链接统一从这里进入；任何分享访问都不可编辑，失效链接给出明确原因与处置单据。</p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/dataview">返回数据视图列表</RouterLink>
      </div>
    </header>

    <form class="filter-bar" @submit.prevent="resolve">
      <label class="filter-item filter-grow">
        <span>分享链接 / 访问令牌</span>
        <input v-model="token" placeholder="粘贴数据视图的分享链接令牌" />
      </label>
      <button class="btn primary" type="submit">打开只读视图</button>
    </form>

    <article v-if="access && access.ok" class="share-card">
      <header class="share-card-head">
        <div>
          <h3>{{ access.snapshot.viewName }}（{{ access.snapshot.viewCode }}）</h3>
          <p class="muted-text">
            只读快照 {{ access.snapshot.id }} · 固化于 {{ access.snapshot.createdAt }} ·
            来源版本 v{{ access.snapshot.sourceVersion }}
          </p>
        </div>
        <span class="readonly-tag">只读</span>
      </header>
      <p class="muted-text">
        快照包含 {{ access.snapshot.evidenceSummary.modeCount }} 个回访模式、
        {{ access.snapshot.evidenceSummary.curveCount }} 个回访曲线数据点；
        当前视图状态「{{ access.view.status }}」。
      </p>
      <table class="data-table">
        <thead>
          <tr><th>回访周期（天）</th><th>留存率</th><th>回访频次</th></tr>
        </thead>
        <tbody>
          <tr v-for="point in access.snapshot.retentionCurve" :key="point.periodDay">
            <td>{{ point.periodDay }}</td>
            <td>{{ (point.retentionRate * 100).toFixed(1) }}%</td>
            <td>{{ point.visitFrequency }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted-text">该入口为只读：不能保存、删除或重新生成分享链接。</p>
    </article>

    <article v-else-if="access" class="share-card share-invalid">
      <h3 class="error-text">分享已失效</h3>
      <p class="error-text">{{ access.reason }}</p>
      <table v-if="access.receipt" class="data-table">
        <thead>
          <tr><th colspan="2">删除核对单（{{ access.receipt.receiptId }}）</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in access.receipt.checklist" :key="item.item">
            <td>{{ item.item }}</td>
            <td>{{ item.result }}</td>
          </tr>
        </tbody>
      </table>
      <table v-if="access.migration" class="data-table">
        <thead>
          <tr><th colspan="2">引用迁移清单（{{ access.migration.migrationId }}）</th></tr>
        </thead>
        <tbody>
          <tr v-for="ref in access.migration.references" :key="ref.from">
            <td>{{ ref.from }} → {{ ref.to }}</td>
            <td>{{ ref.note }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="access.snapshot" class="muted-text">
        历史快照 {{ access.snapshot.id }} 已降为只读，不提供可分享数据。
      </p>
    </article>

    <article v-else class="share-card">
      <p class="muted-text">输入分享令牌后打开只读视图；已删除视图不再产生新的可分享结果。</p>
    </article>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { openSharedView } from '@/api/view-service'
import type { SharedViewResult } from '@/api/view-service'

const route = useRoute()
const token = ref(String(route.query.token ?? ''))
const access = ref<SharedViewResult | null>(null)

function resolve() {
  access.value = openSharedView(token.value)
}

onMounted(() => {
  if (token.value) {
    resolve()
  }
})
</script>
