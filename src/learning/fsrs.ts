/**
 * FSRS wrapper: one card per lesson, advanced only by an explicit model-reported
 * rating. `ts-fsrs` owns the algorithm; DVL owns the `ReviewRating` → `Grade`
 * mapping and the durable card file. No score→rating derivation exists: ratings
 * come from the model's full judgement of one graded run.
 * @module dvl/learning/fsrs
 */

import { createEmptyCard, fsrs, generatorParameters, Rating, State } from 'ts-fsrs'
import type { Card, Grade } from 'ts-fsrs'
import type { ReviewRating } from '../shared/types.ts'

/** One scheduler for the whole plugin (parameters are stateless). */
const scheduler = fsrs(generatorParameters({ enable_fuzz: true }))

/** A fresh card for a lesson entering review rotation. */
export function newCard(): Card {
  return createEmptyCard()
}

/** Map an explicit model rating to an FSRS grade. */
export function gradeFor(rating: ReviewRating): Grade {
  switch (rating) {
    case 'again': return Rating.Again
    case 'hard': return Rating.Hard
    case 'good': return Rating.Good
    case 'easy': return Rating.Easy
  }
}

/**
 * Advance one card after a review, given the model's explicit rating.
 * @param card - card before the review.
 * @param rating - explicit model rating (`again`|`hard`|`good`|`easy`).
 * @param now - epoch ms.
 * @returns the next card (with the next due date).
 */
export function nextCard(card: Card, rating: ReviewRating, now: number): Card {
  return scheduler.next(card, new Date(now), gradeFor(rating)).card
}

/** Human label for a card state, for prompts and the GUI. */
export function stateLabel(card: Card): string {
  switch (card.state) {
    case State.New: return 'new'
    case State.Learning: return 'learning'
    case State.Review: return 'review'
    case State.Relearning: return 'relearning'
    default: return String(card.state)
  }
}
