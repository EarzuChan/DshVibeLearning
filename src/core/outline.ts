// 树形大纲与根级 Workflow，所有迁移均由调用方显式发起

import {randomUUID} from 'node:crypto'
import type {Outline, OutlineNode, OutlinePhase, OutlineWorkflow} from '../shared/model.ts'
import {isValidArtifactHash, LearningFiles, listJsonFiles, readJson, removePath, writeJson} from './files.ts'
import {isSafeSegment} from '../util/identifiers.ts'

export interface OutlineInput {
    readonly title: string
    readonly tree: readonly OutlineNode[]
}

function visitNodes(nodes: readonly OutlineNode[], visit: (node: OutlineNode) => void): void {
    for (const node of nodes) {
        visit(node)
        if (node.kind === 'group') visitNodes(node.children, visit)
    }
}

export function outlineLessons(outline: Outline): OutlineNode[] {
    const lessons: OutlineNode[] = []
    visitNodes(outline.tree, node => { if (node.kind === 'lesson') lessons.push(node) })
    return lessons
}

export function findOutlineLesson(outline: Outline, lessonId: string): OutlineNode | null {
    let found: OutlineNode | null = null
    visitNodes(outline.tree, node => { if (node.kind === 'lesson' && node.id === lessonId) found = node })
    return found
}

export function outlineArtifactHashes(outline: Outline): string[] {
    return Object.values(outline.artifactBindings)
}

export function confirmOutline(outline: Outline): void {
    if (!isSafeSegment(outline.id)) throw new Error('纲目 ID 无效')
    if (outline.title.trim().length === 0) throw new Error('纲目标题不能为空')
    if (!Array.isArray(outline.tree) || outline.tree.length === 0) throw new Error('纲目树不能为空')

    const ids = new Set<string>()
    const lessonIds = new Set<string>()
    visitNodes(outline.tree, node => {
        if (!isSafeSegment(node.id)) throw new Error(`节点 ID 无效：${node.id}`)
        if (ids.has(node.id)) throw new Error(`节点 ID 重复：${node.id}`)
        if (node.title.trim().length === 0) throw new Error(`节点 ${node.id} 标题不能为空`)
        if (node.kind === 'group' && !Array.isArray(node.children)) throw new Error(`分组节点 ${node.id} 缺少 children`)
        if (node.kind === 'lesson') lessonIds.add(node.id)
        ids.add(node.id)
    })

    if (outline.artifactBindings === null || typeof outline.artifactBindings !== 'object' || Array.isArray(outline.artifactBindings)) throw new Error('大纲工件绑定必须是对象')
    for (const [lessonId, artifactHash] of Object.entries(outline.artifactBindings)) {
        if (!lessonIds.has(lessonId)) throw new Error(`工件绑定引用了不存在的课程：${lessonId}`)
        if (!isValidArtifactHash(artifactHash)) throw new Error(`工件绑定哈希无效：${artifactHash}`)
    }

    const workflow = outline.workflow
    if (!['not-started', 'learning', 'qa', 'completed'].includes(workflow.phase)) throw new Error(`Workflow 阶段无效：${workflow.phase}`)
    if ((workflow.phase === 'learning' || workflow.phase === 'qa') && (workflow.currentLessonId === null || !ids.has(workflow.currentLessonId))) throw new Error('进行中的 Workflow 必须指向存在的课程')
    if ((workflow.phase === 'not-started' || workflow.phase === 'completed') && workflow.currentLessonId !== null) throw new Error('未开始或已完成的 Workflow 不得保留当前课程')
    for (const lessonId of workflow.completedLessonIds) if (!ids.has(lessonId)) throw new Error(`Workflow 引用了不存在的已完成课程：${lessonId}`)
}

function normalizeNode(node: OutlineNode): OutlineNode {
    const description = node.description?.trim()
    if (node.kind === 'lesson') return {id: node.id || randomUUID(), kind: 'lesson', title: node.title.trim(), ...(description ? {description} : {})}
    return {id: node.id || randomUUID(), kind: 'group', title: node.title.trim(), ...(description ? {description} : {}), children: node.children.map(normalizeNode)}
}

export class OutlineStore {
    constructor(readonly files: LearningFiles) {}

    async read(id: string): Promise<Outline | null> {
        const outline = await readJson<Outline>(this.files.outlineFile(id))
        if (outline !== null) confirmOutline(outline)
        return outline
    }

    async list(): Promise<Outline[]> {
        const outlines: Outline[] = []
        for (const name of await listJsonFiles(this.files.outlinesDir)) {
            const outline = await readJson<Outline>(`${this.files.outlinesDir}/${name}`)
            if (outline === null) continue
            confirmOutline(outline)
            outlines.push(outline)
        }

        return outlines.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))
    }

    // 大纲标准化
    async normalize(input: OutlineInput, outlineId: string | null): Promise<Outline> {
        const previous = outlineId === null ? null : await this.read(outlineId)

        if (outlineId !== null && previous === null) throw new Error(`纲目不存在：${outlineId}`)
        const outline: Outline = {id: outlineId ?? randomUUID(), title: input.title.trim(), tree: input.tree.map(normalizeNode), artifactBindings: previous?.artifactBindings ?? {}, workflow: previous?.workflow ?? {phase: 'not-started', currentLessonId: null, completedLessonIds: []}}

        confirmOutline(outline)

        return outline
    }

    async write(outline: Outline): Promise<void> {
        confirmOutline(outline)
        await writeJson(this.files.outlineFile(outline.id), outline)
    }

    async updateArtifactBinding(outlineId: string, lessonId: string, artifactHash: string | null): Promise<Outline> {
        const outline = await this.read(outlineId)
        if (outline === null) throw new Error(`纲目不存在：${outlineId}`)
        if (findOutlineLesson(outline, lessonId)?.kind !== 'lesson') throw new Error(`课程不存在：${lessonId}`)

        const artifactBindings = {...outline.artifactBindings}
        if (artifactHash === null) delete artifactBindings[lessonId]
        else artifactBindings[lessonId] = artifactHash
        const updated = {...outline, artifactBindings}
        confirmOutline(updated)
        await this.write(updated)
        return updated
    }

    async transition(id: string, phase: OutlinePhase, currentLessonId: string | null): Promise<Outline> {
        const outline = await this.read(id)
        if (outline === null) throw new Error(`纲目不存在：${id}`)

        const current = outline.workflow
        const completed = new Set(current.completedLessonIds)

        if (phase === 'learning') {
            if (currentLessonId === null || findOutlineLesson(outline, currentLessonId)?.kind !== 'lesson') throw new Error(`下一课程不存在：${currentLessonId ?? 'null'}`)
            if (current.phase === 'qa' && current.currentLessonId !== null) completed.add(current.currentLessonId)
            if (current.phase !== 'not-started' && current.phase !== 'qa' && !(current.phase === 'learning' && current.currentLessonId === currentLessonId)) throw new Error(`不可从 ${current.phase} 进入 learning`)
        } else if (phase === 'qa') {
            if (current.phase !== 'learning' || current.currentLessonId === null) throw new Error(`不可从 ${current.phase} 进入 qa`)
            currentLessonId = current.currentLessonId
        } else if (phase === 'completed') {
            if (current.phase !== 'qa' || current.currentLessonId === null) throw new Error(`不可从 ${current.phase} 完成纲目`)
            completed.add(current.currentLessonId)
            currentLessonId = null
        } else if (current.phase !== 'not-started') throw new Error('只能在初始状态保持 not-started')

        const workflow: OutlineWorkflow = {phase, currentLessonId, completedLessonIds: [...completed]}
        const updated = {...outline, workflow}

        confirmOutline(updated)

        await this.write(updated)

        return updated
    }

    async delete(id: string): Promise<void> {
        await removePath(this.files.outlineFile(id))
    }
}
