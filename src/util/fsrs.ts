// FSRS 封装：每课一张卡片，仅由模型明确给出的评级推进，ts-fsrs 负责算法，DVL 负责评级映射与持久化

import {createEmptyCard, fsrs, generatorParameters, Rating} from 'ts-fsrs'
import type {Card, Grade} from 'ts-fsrs'
import type {FsrsCard, ReviewRating} from '../shared/model.ts'

// 整个插件共用一个无状态调度器
const scheduler = fsrs(generatorParameters({enable_fuzz: true}))

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
export function nextCard(card: Card, rating: ReviewRating, now: number): Card {
    return scheduler.next(card, new Date(now), gradeFor(rating)).card
}
