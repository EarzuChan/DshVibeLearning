import {createHash} from 'node:crypto'

// 生成工件目录使用的短内容哈希，相同内容始终得到相同 ID
export function contentHash(data: string, length = 16): string {
    return createHash('sha256').update(data).digest('hex').slice(0, length)
}

// 生成 URL 使用的工作区 ID，即规范 cwd 的 12 位短哈希
export function workspaceIdOf(cwd: string): string {
    return contentHash(cwd, 12)
}

// 检查可作为文件或 URL 路径段的 ID 是否安全
export function isSafeSegment(id: string): boolean {
    return /^[a-z0-9][a-z0-9_-]{0,127}$/iu.test(id)
}