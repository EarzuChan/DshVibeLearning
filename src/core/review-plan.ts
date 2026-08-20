// 复习计划、正式期次与临时托管期次的持久化边界

import {randomUUID} from 'node:crypto'
import type {Card} from 'ts-fsrs'
import type {ArtifactHash} from '../shared/artifacts.ts'
import type {ReviewPlan, ReviewPlanRound, ReviewRating, TemporaryReviewPlanRound, TemporaryReviewPlanRoundManifest} from '../shared/model.ts'
import {cardFromStored, cardToStored, newCard, nextCard} from './fsrs.ts'
import {isValidArtifactHash, LearningFiles, listJsonFiles, readJson, removePath, writeJson} from './files.ts'
import {isSafeSegment} from './identifiers.ts'

export interface ReviewPlanCreationInput {
    readonly outlineId: string
    readonly lessonId: string
    readonly rating: ReviewRating
}

export interface PreparedReviewPlan {
    readonly plan: ReviewPlan
    readonly dueAt: string
}

function nowIso(): string {
    return new Date().toISOString()
}

function dueAtOf(card: Card): string {
    return card.due.toISOString()
}

function confirmRound(round: ReviewPlanRound): void {
    if (round === null || typeof round !== 'object') throw new Error('复习期次必须是对象')
    if (!isSafeSegment(round.id)) throw new Error(`复习期次 ID 无效：${round.id}`)
    if (round.state !== 'active' && round.state !== 'completed') throw new Error(`复习期次状态无效：${round.state}`)
    if (Number.isNaN(Date.parse(round.startedAt))) throw new Error(`复习期次开始时间无效：${round.id}`)
    if (round.completedAt !== undefined && Number.isNaN(Date.parse(round.completedAt))) throw new Error(`复习期次完成时间无效：${round.id}`)
    if (round.state === 'active' && round.completedAt !== undefined) throw new Error(`活跃复习期次不能有完成时间：${round.id}`)
    if (round.state === 'completed' && round.completedAt === undefined) throw new Error(`已完成复习期次缺少完成时间：${round.id}`)
    if (round.artifactHash !== undefined && !isValidArtifactHash(round.artifactHash)) throw new Error(`复习工件哈希无效：${round.id}`)
}

function confirmPlan(plan: ReviewPlan): void {
    if (plan === null || typeof plan !== 'object') throw new Error('复习计划必须是对象')
    if (!isSafeSegment(plan.id) || !isSafeSegment(plan.outlineId) || !isSafeSegment(plan.lessonId)) throw new Error('复习计划 ID 无效')
    if (plan.card === null || typeof plan.card !== 'object' || Array.isArray(plan.card)) throw new Error(`复习计划卡片无效：${plan.id}`)
    if (Number.isNaN(Date.parse(String(plan.card.due)))) throw new Error(`复习计划卡片缺少有效 due：${plan.id}`)
    if (!Array.isArray(plan.rounds)) throw new Error(`复习计划期次必须是数组：${plan.id}`)
    const ids = new Set<string>()
    let active = 0
    for (const round of plan.rounds) {
        confirmRound(round)
        if (ids.has(round.id)) throw new Error(`复习期次 ID 重复：${round.id}`)
        ids.add(round.id)
        if (round.state === 'active') active += 1
    }
    if (active > 1) throw new Error(`复习计划存在多个活跃期次：${plan.id}`)
}

function confirmTemporaryRound(round: TemporaryReviewPlanRound): void {
    if (round === null || typeof round !== 'object') throw new Error('临时复习期次必须是对象')
    if (!isSafeSegment(round.id) || !isSafeSegment(round.outlineId) || !isSafeSegment(round.lessonId)) throw new Error('临时复习期次 ID 无效')
    if (Number.isNaN(Date.parse(round.startedAt))) throw new Error(`临时复习期次开始时间无效：${round.id}`)
    if (round.artifactHash !== undefined && !isValidArtifactHash(round.artifactHash)) throw new Error(`临时复习工件哈希无效：${round.id}`)
}

function confirmManifest(manifest: TemporaryReviewPlanRoundManifest): void {
    if (manifest === null || typeof manifest !== 'object' || !Array.isArray(manifest.rounds)) throw new Error('临时复习期次清单无效')
    const ids = new Set<string>()
    for (const round of manifest.rounds) {
        confirmTemporaryRound(round)
        if (ids.has(round.id)) throw new Error(`临时复习期次 ID 重复：${round.id}`)
        ids.add(round.id)
    }
}

export class ReviewPlanStore {
    constructor(readonly files: LearningFiles) {}

    async read(id: string): Promise<ReviewPlan | null> {
        const plan = await readJson<ReviewPlan>(this.files.reviewPlanFile(id))
        if (plan !== null) confirmPlan(plan)
        return plan
    }

    async list(): Promise<ReviewPlan[]> {
        const plans: ReviewPlan[] = []
        for (const name of await listJsonFiles(this.files.reviewPlansDir)) {
            const plan = await readJson<ReviewPlan>(`${this.files.reviewPlansDir}/${name}`)
            if (plan === null) continue
            confirmPlan(plan)
            plans.push(plan)
        }
        return plans
    }

    async find(outlineId: string, lessonId: string): Promise<ReviewPlan | null> {
        return (await this.list()).find(plan => plan.outlineId === outlineId && plan.lessonId === lessonId) ?? null
    }

    async create(input: ReviewPlanCreationInput): Promise<PreparedReviewPlan> {
        if (!isSafeSegment(input.outlineId) || !isSafeSegment(input.lessonId)) throw new Error('复习计划的纲目或课程 ID 无效')
        if (await this.find(input.outlineId, input.lessonId) !== null) throw new Error('该课程已经存在复习计划')
        const card = nextCard(newCard(), input.rating, Date.now())
        const plan: ReviewPlan = {id: randomUUID(), outlineId: input.outlineId, lessonId: input.lessonId, card: cardToStored(card), rounds: []}
        confirmPlan(plan)
        return {plan, dueAt: dueAtOf(card)}
    }

    async write(plan: ReviewPlan): Promise<void> {
        confirmPlan(plan)
        for (const other of await this.list()) if (other.id !== plan.id && other.outlineId === plan.outlineId && other.lessonId === plan.lessonId) throw new Error('该课程已经存在复习计划')
        await writeJson(this.files.reviewPlanFile(plan.id), plan)
    }

    async claim(planId: string, force: boolean): Promise<{plan: ReviewPlan; round: ReviewPlanRound}> {
        const plan = await this.read(planId)
        if (plan === null) throw new Error(`复习计划不存在：${planId}`)
        const active = plan.rounds.filter(round => round.state === 'active')
        if (active.length > 1) throw new Error(`复习计划存在多个活跃期次：${planId}`)
        if (active.length === 1) return {plan, round: active[0] as ReviewPlanRound}
        const due = Date.parse(String(plan.card.due))
        if (!force && (Number.isNaN(due) || due > Date.now())) throw new Error('复习计划尚未到期，需要 force 才能提前复习')
        const round: ReviewPlanRound = {id: randomUUID(), state: 'active', startedAt: nowIso()}
        const updated = {...plan, rounds: [...plan.rounds, round]}
        await this.write(updated)
        return {plan: updated, round}
    }

    async updateRoundArtifactBinding(planId: string, roundId: string, artifactHash: ArtifactHash): Promise<ReviewPlan> {
        const plan = await this.read(planId)
        if (plan === null) throw new Error(`复习计划不存在：${planId}`)
        const round = plan.rounds.find(item => item.id === roundId)
        if (round === undefined) throw new Error(`复习期次不存在：${roundId}`)
        if (round.state !== 'active') throw new Error(`只能绑定活跃复习期次：${roundId}`)
        if (round.artifactHash !== undefined && round.artifactHash !== artifactHash) throw new Error(`复习期次已经绑定其他工件：${roundId}`)
        const updated = {...plan, rounds: plan.rounds.map(item => item.id === roundId ? {...item, artifactHash} : item)}
        await this.write(updated)
        return updated
    }

    async complete(planId: string, rating: ReviewRating): Promise<ReviewPlan> {
        const plan = await this.read(planId)
        if (plan === null) throw new Error(`复习计划不存在：${planId}`)
        const active = plan.rounds.filter(round => round.state === 'active')
        if (active.length !== 1) throw new Error(`复习计划必须有且只有一个活跃期次：${planId}`)
        const card = nextCard(cardFromStored(plan.card), rating, Date.now())
        const completedAt = nowIso()
        const activeId = (active[0] as ReviewPlanRound).id
        const updated: ReviewPlan = {...plan, card: cardToStored(card), rounds: plan.rounds.map(round => round.id === activeId ? {...round, state: 'completed' as const, completedAt} : round)}
        await this.write(updated)
        return updated
    }

    async temporaryManifest(): Promise<TemporaryReviewPlanRoundManifest> {
        const manifest = await readJson<TemporaryReviewPlanRoundManifest>(this.files.temporaryReviewPlanRoundsFile) ?? {rounds: []}
        confirmManifest(manifest)
        return manifest
    }

    private async writeTemporaryManifest(manifest: TemporaryReviewPlanRoundManifest): Promise<void> {
        confirmManifest(manifest)
        await writeJson(this.files.temporaryReviewPlanRoundsFile, manifest)
    }

    async claimTemporary(outlineId: string, lessonId: string): Promise<{manifest: TemporaryReviewPlanRoundManifest; round: TemporaryReviewPlanRound}> {
        if (!isSafeSegment(outlineId) || !isSafeSegment(lessonId)) throw new Error('临时复习期次的纲目或课程 ID 无效')
        const manifest = await this.temporaryManifest()
        const round: TemporaryReviewPlanRound = {id: randomUUID(), outlineId, lessonId, startedAt: nowIso()}
        const updated = {rounds: [...manifest.rounds, round]}
        await this.writeTemporaryManifest(updated)
        return {manifest: updated, round}
    }

    async preserveArtifactAsTemporary(outlineId: string, lessonId: string, artifactHash: ArtifactHash): Promise<TemporaryReviewPlanRoundManifest> {
        const manifest = await this.temporaryManifest()
        const round: TemporaryReviewPlanRound = {id: randomUUID(), outlineId, lessonId, startedAt: nowIso(), artifactHash}
        const updated = {rounds: [...manifest.rounds, round]}
        await this.writeTemporaryManifest(updated)
        return updated
    }

    async updateTemporaryRoundArtifactBinding(roundId: string, artifactHash: ArtifactHash): Promise<TemporaryReviewPlanRoundManifest> {
        const manifest = await this.temporaryManifest()
        const round = manifest.rounds.find(item => item.id === roundId)
        if (round === undefined) throw new Error(`临时复习期次不存在：${roundId}`)
        if (round.artifactHash !== undefined && round.artifactHash !== artifactHash) throw new Error(`临时复习期次已经绑定其他工件：${roundId}`)
        const updated = {rounds: manifest.rounds.map(item => item.id === roundId ? {...item, artifactHash} : item)}
        await this.writeTemporaryManifest(updated)
        return updated
    }

    async removeTemporaryRoundsForArtifact(artifactHash: ArtifactHash): Promise<TemporaryReviewPlanRoundManifest> {
        const manifest = await this.temporaryManifest()
        const updated = {rounds: manifest.rounds.filter(round => round.artifactHash !== artifactHash)}
        if (updated.rounds.length !== manifest.rounds.length) await this.writeTemporaryManifest(updated)
        return updated
    }

    async adoptTemporaryRound(roundId: string, planId: string): Promise<{plan: ReviewPlan; manifest: TemporaryReviewPlanRoundManifest; round: ReviewPlanRound}> {
        const manifest = await this.temporaryManifest()
        const temporary = manifest.rounds.find(item => item.id === roundId)
        if (temporary === undefined) throw new Error(`临时复习期次不存在：${roundId}`)
        if (temporary.artifactHash === undefined) throw new Error(`临时复习期次尚未绑定工件：${roundId}`)
        const plan = await this.read(planId)
        if (plan === null) throw new Error(`复习计划不存在：${planId}`)
        if (plan.outlineId !== temporary.outlineId || plan.lessonId !== temporary.lessonId) throw new Error('临时复习期次与目标复习计划不匹配')
        if (plan.rounds.some(round => round.state === 'active')) throw new Error('目标复习计划仍有活跃期次')
        const completedAt = nowIso()
        const round: ReviewPlanRound = {id: randomUUID(), state: 'completed', startedAt: temporary.startedAt, completedAt, artifactHash: temporary.artifactHash}
        const updatedPlan = {...plan, rounds: [...plan.rounds, round]}
        const updatedManifest = {rounds: manifest.rounds.filter(item => item.id !== roundId)}
        await this.write(updatedPlan)
        await this.writeTemporaryManifest(updatedManifest)
        return {plan: updatedPlan, manifest: updatedManifest, round}
    }

    async delete(id: string): Promise<void> {
        await removePath(this.files.reviewPlanFile(id))
    }
}
