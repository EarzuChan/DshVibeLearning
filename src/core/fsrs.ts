// FSRS 封装：每课一张卡片，仅由模型明确给出的评级推进，ts-fsrs 负责算法，DVL 负责评级映射与持久化，不存在分数到评级的自动推导

import {createEmptyCard, fsrs, generatorParameters, Rating, State} from 'ts-fsrs'
import type {Card, Grade} from 'ts-fsrs'
import type {ReviewRating} from '../shared/model.ts'

// 整个插件共用一个无状态调度器
const scheduler = fsrs(generatorParameters({enable_fuzz: true}))

// 为首次进入复习轮转的课程创建新卡片
export function newCard(): Card {
    return createEmptyCard()
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
export function nextCard(card: Card, rating: ReviewRating, now: number): Card {
    return scheduler.next(card, new Date(now), gradeFor(rating)).card
}

// 返回供 prompt 与 GUI 使用的卡片状态文本
export function stateLabel(card: Card): string {
    switch (card.state) {
        case State.New:
            return 'new'
        case State.Learning:
            return 'learning'
        case State.Review:
            return 'review'
        case State.Relearning:
            return 'relearning'
        default:
            return String(card.state)
    }
}
