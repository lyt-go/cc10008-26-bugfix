// 用 esbuild 把 TS 测试（含 @ 路径别名）打包成临时 ESM，再交给 node:test 运行。
// 不依赖额外测试框架，仓库已有的 esbuild 即可。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = process.argv[2]
if (!entry) {
  throw new Error('用法：node tests/run-esbuild.mjs <测试文件入口>')
}

const outfile = join(tmpdir(), `view-control-test-${Date.now()}.mjs`)

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  alias: {
    '@': new URL('../src', import.meta.url).pathname,
  },
})

try {
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(outfile, { force: true })
}
