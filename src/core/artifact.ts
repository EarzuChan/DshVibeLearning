// 不可变 HTML 工件及其文件系统投影，业务归属由外部实体持有

import {readFile, stat} from 'node:fs/promises'
import type {ArtifactHash, ArtifactKind} from '../shared/artifacts.ts'
import type {ArtifactSummary} from '../shared/model.ts'
import {isEnoent, isValidArtifactHash, LearningFiles, listDirectories, removePath} from './files.ts'

// 解析HTML来提取名字（笑）
function titleOf(html: string, hash: string): string {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)
    return match?.[1]?.replace(/\s+/gu, ' ').trim() || hash
}

export class ArtifactStore {
    constructor(readonly files: LearningFiles) {}

    async exists(kind: ArtifactKind, hash: ArtifactHash): Promise<boolean> {
        return (await this.readHtml(kind, hash)) !== null
    }

    async readHtml(kind: ArtifactKind, hash: ArtifactHash): Promise<string | null> {
        try {
            return await readFile(this.files.artifactHtml(kind, hash), 'utf8')
        } catch (error: unknown) {
            if (isEnoent(error)) return null
            throw error
        }
    }

    async title(kind: ArtifactKind, hash: ArtifactHash): Promise<string> {
        const html = await this.readHtml(kind, hash)
        if (html === null) throw new Error(`工件不存在：${kind}/${hash}`)
        return titleOf(html, hash)
    }

    async modifiedAt(kind: ArtifactKind, hash: ArtifactHash): Promise<string> {
        return (await stat(this.files.artifactHtml(kind, hash))).mtime.toISOString()
    }

    async list(kind: ArtifactKind, runs: (kind: ArtifactKind, hash: ArtifactHash) => ArtifactSummary['runs'] | Promise<ArtifactSummary['runs']>): Promise<ArtifactSummary[]> {
        const artifacts: ArtifactSummary[] = []
        
        for (const hash of await listDirectories(this.files.artifactCategoryDir(kind))) {
            if (!isValidArtifactHash(hash)) continue

            const html = await this.readHtml(kind, hash)
            if (html === null) continue

            artifacts.push({kind, hash, title: titleOf(html, hash), modifiedAt: await this.modifiedAt(kind, hash), runs: await runs(kind, hash)})
        }

        return artifacts.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    }

    async delete(kind: ArtifactKind, hash: ArtifactHash): Promise<void> {
        await removePath(this.files.artifactDir(kind, hash), true)
    }
}
