import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
// `?raw` 把文件作为文本载入（与 Vite/vitest 一致）；tsdown 不认识没有插件的 `.css` 导入。
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
export default defineConfig([
  // 服务端：独立进程入口，ESM，Node 平台。
  { entry: { index: 'src/index.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024',
    dts: true, clean: true, deps: { neverBundle: ['zod', 'proper-lockfile'] } },
  // 面板：单文件 IIFE，浏览器平台，随包打包 React，由 PanelServer 以 /main.js 提供。
  { entry: { main: 'src/client/main.tsx' }, outDir: 'lib/panel', format: 'iife', platform: 'browser', target: 'es2022',
    dts: false, clean: false, plugins: [raw], deps: { neverBundle: [] },
    outputOptions: { entryFileNames: 'main.js' } },
])
