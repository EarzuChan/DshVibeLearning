// FSRS 封装：每课一张卡片，仅由模型明确给出的评级推进，ts-fsrs 负责算法，DVL 负责评级映射与持久化

import {createEmptyCard, fsrs, generatorParameters, Rating} from 'ts-fsrs'
import type {Card, FSRS, Grade} from 'ts-fsrs'
import type {FsrsCard, ReviewRating} from '../shared/model.ts'

// 短期学习步：ts-fsrs 默认的 1m/10m 会让刚学完的课几分钟后就到期，DVL 默认推到半小时到一小时后
export const DEFAULT_LEARNING_STEPS = ['30m', '1h']
export const DEFAULT_RELEARNING_STEPS = ['30m']

type StepUnit = `${number}${'m' | 'h' | 'd'}`
const STEP_PATTERN = /^\d+(\.\d+)?[mhd]$/

function confirmSteps(name: string, steps: readonly string[]): StepUnit[] {
    for (const step of steps) if (!STEP_PATTERN.test(step)) throw new Error(`复习${name}格式无效：${step}（应为数字加 m、h 或 d，如 30m）`)
    return steps as StepUnit[]
}

// 按学习步与重学步创建调度器；调度器本身无状态，整个插件共用一个
export function createScheduler(learningSteps: readonly string[], relearningSteps: readonly string[]): FSRS {
    return fsrs(generatorParameters({enable_fuzz: true, learning_steps: confirmSteps('学习步', learningSteps), relearning_steps: confirmSteps('重学步', relearningSteps)}))
}

// 为首次进入复习轮转的课程创建新卡片
export function newCard(): Card {
    return createEmptyCard()
}

export function cardFromStored(value: FsrsCard): Card {
    return {...value, due: new Date(String(value.due)), ...(value.last_review === undefined || value.last_review === null ? {} : {last_review: new Date(String(value.last_review))})} as unknown as Card
}

export function cardToStored(card: Card): FsrsCard {
    return {...card, due: card.due.toISOString(), ...(card.last_review === undefined || card.last_review === null ? {} : {last_review: card.last_review.toISOString()})}
}

// 将模型明确给出的复习评级映射为 FSRS grade
export function gradeFor(rating: ReviewRating): Grade {
    switch (rating) {
        case 'again':
            return Rating.Again

        case 'hard':
            return Rating.Hard

        case 'good':
            return Rating.Good

        case 'easy':
            return Rating.Easy
    }
}

// 按模型明确给出的评级推进卡片并返回包含下次到期时间的新卡片
export function nextCard(scheduler: FSRS, card: Card, rating: ReviewRating, now: number): Card {
    return scheduler.next(card, new Date(now), gradeFor(rating)).card
}
