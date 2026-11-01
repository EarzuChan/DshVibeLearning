// HTML 工件及其文件系统投影：ID 随机分配、内容可就地编辑，业务归属由外部实体持有

import {mkdir, readFile, stat} from 'node:fs/promises'
import type {ArtifactId, ArtifactKind} from '../shared/artifacts.ts'
import type {ArtifactSummary} from '../shared/model.ts'
import {generateArtifactId} from '../util/identifiers.ts'
import {isDirectory, isEnoent, isValidArtifactId, LearningFiles, listDirectories, removePath} from './files.ts'

// 解析HTML来提取名字（笑）
function titleOf(html: string, artifactId: string): string {
    const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)
    return match?.[1]?.replace(/\s+/gu, ' ').trim() || artifactId
}

export class ArtifactStore {
    constructor(readonly files: LearningFiles) {}

    // 分配一个新的工件身份：只建目录不建文件，由模型随后用官方 write 工具写入 index.html
    async allocate(kind: ArtifactKind): Promise<{artifactId: ArtifactId; path: string}> {
        let artifactId = generateArtifactId()
        while (await isDirectory(this.files.artifactDir(kind, artifactId))) artifactId = generateArtifactId()

        await mkdir(this.files.artifactDir(kind, artifactId), {recursive: true})
        return {artifactId, path: this.files.artifactHtml(kind, artifactId)}
    }

    async exists(kind: ArtifactKind, artifactId: ArtifactId): Promise<boolean> {
        return (await this.readHtml(kind, artifactId)) !== null
    }

    async readHtml(kind: ArtifactKind, artifactId: ArtifactId): Promise<string | null> {
        try {
            return await readFile(this.files.artifactHtml(kind, artifactId), 'utf8')
        } catch (error: unknown) {
            if (isEnoent(error)) return null
            throw error
        }
    }

    async title(kind: ArtifactKind, artifactId: ArtifactId): Promise<string> {
        const html = await this.readHtml(kind, artifactId)
        if (html === null) throw new Error(`工件不存在：${kind}/${artifactId}`)
        return titleOf(html, artifactId)
    }

    async modifiedAt(kind: ArtifactKind, artifactId: ArtifactId): Promise<string> {
        return (await stat(this.files.artifactHtml(kind, artifactId))).mtime.toISOString()
    }

    async list(kind: ArtifactKind, runs: (kind: ArtifactKind, artifactId: ArtifactId) => ArtifactSummary['runs'] | Promise<ArtifactSummary['runs']>): Promise<Array<Omit<ArtifactSummary, 'previewUrl'>>> {
        const artifacts: Array<Omit<ArtifactSummary, 'previewUrl'>> = []
        
        for (const artifactId of await listDirectories(this.files.artifactCategoryDir(kind))) {
            if (!isValidArtifactId(artifactId)) continue

            const html = await this.readHtml(kind, artifactId)
            if (html === null) continue

            artifacts.push({kind, artifactId, title: titleOf(html, artifactId), modifiedAt: await this.modifiedAt(kind, artifactId), runs: await runs(kind, artifactId)})
        }

        return artifacts.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    }

    async delete(kind: ArtifactKind, artifactId: ArtifactId): Promise<void> {
        await removePath(this.files.artifactDir(kind, artifactId), true)
    }
}
