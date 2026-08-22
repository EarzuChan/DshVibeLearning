// 工件哈希ID注册表

import type {Context} from '@deepseek-ai/cordis'
import {generateWorkspaceHashIdOf} from '../util/identifiers.ts'

const workspaceHashIdToWorkspaceCwd = new Map<string, string>()

// 从CWD生成ID并记录
export function recordWorkspaceHashIdByGeneratingItFromItsCwd(cwd: string): void {
    workspaceHashIdToWorkspaceCwd.set(generateWorkspaceHashIdOf(cwd), cwd)
}

// ID->CWD：先查我们记的，再看官方
export function getWorkspaceCwdOrNullByItsHashId(ctx: Context, workspaceId: string): string | null {
    const ourRecord = workspaceHashIdToWorkspaceCwd.get(workspaceId)
    if (ourRecord !== undefined) return ourRecord

    const reg = ctx.get('workspaceRegistry')
    if (reg !== undefined) for (const workspace of reg.list()) if (generateWorkspaceHashIdOf(workspace.path) === workspaceId) return workspace.path

    return null
}
