// DVL 浏览器端 tsdown 打包配置，输出 Web Shell 模块加载器要求的 lib/client.js，并内联处理 CSS Modules

import {readFile} from 'node:fs/promises'
import {basename, dirname, resolve as resolvePath} from 'node:path'
import {transform} from 'lightningcss'
import type {UserConfig} from 'tsdown'

// 浏览器插件 ID，同时写入模块加载器与样式标签
const ID = 'dsh-vibe-learning'

// Web Shell 冻结模块表提供的平台模块
const PLATFORM_MODULES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'] as const

// Snapshot Store 引擎例外项，由 Shell 的立即层运行时提供
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

// 由模块加载器模块表解析的外部依赖
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

// 根据 importer 解析源码树中的 .module.css 路径
function cssSourcePath(source: string, importer: string): string {
    return resolvePath(dirname(importer), source)
}

const config: UserConfig = {
    name: `${ID}/client`,
    entry: {client: 'src/frontend/index.ts'},
    outDir: 'lib', // 与 Node 端产物共用 lib，因此不能 clean，否则会删掉 tsc 生成的 Node 端文件
    format: 'cjs',
    platform: 'browser',
    dts: false,
    tsconfig: 'src/frontend/tsconfig.json',
    sourcemap: true,
    clean: false,
    deps: {
        neverBundle: [...CLIENT_EXTERNALS], onlyBundle: ['clsx'],
        alwaysBundle: (spec: string) => CLIENT_EXTERNALS.includes(spec) ? undefined : true // 模块表之外的依赖全部内联，否则运行时 require 会找不到
    },
    plugins: [{
        name: 'dsh-css-modules-inline',

        resolveId(source: string, importer: string | undefined) {
            if (!source.endsWith('.module.css')) return null
            const abs = importer !== undefined ? cssSourcePath(source, importer) : source
            return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
        },

        async load(virtualId: string) {
            if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null

            const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
            this.addWatchFile(fileId) // 虚拟 ID 会隐藏真实样式文件，因此手动加入监听图

            const source = await readFile(fileId)
            const {code, exports: cssExports} = transform({filename: fileId, code: source, cssModules: {pattern: '[hash]_[local]'}, minify: true})

            const classMap: Record<string, string> = {}
            for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name

            // 每个 CSS Module 注入一个可幂等复用的 style[data-plugin] 标签
            return [
                `const css = ${JSON.stringify(code.toString())};`,
                `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
                'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
                '  const tag = document.createElement(\'style\');',
                `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
                '  tag.dataset.pluginCss = tagId;',
                '  tag.textContent = css;',
                '  document.head.appendChild(tag);',
                '}',
                `export default ${JSON.stringify(classMap)};`,
            ].join('\n')
        },
    }],
    outputOptions: {
        entryFileNames: 'client.js',
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
}

// ---------

export default config
