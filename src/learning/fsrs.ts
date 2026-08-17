/**
 * FSRS wrapper: one card per lesson, advanced by the objective score of a
 * finished review. `ts-fsrs` owns the algorithm; DVL owns the score→grade
 * mapping (configurable thresholds) and the durable card file.
 * @module dvl/learning/fsrs
 */

import { createEmptyCard, fsrs, generatorParameters, Rating, State } from 'ts-fsrs'
import type { Card, Grade } from 'ts-fsrs'
import type { RatingThresholds } from '../shared/types.ts'

/** One scheduler for the whole plugin (parameters are stateless). */
const scheduler = fsrs(generatorParameters({ enable_fuzz: true }))

/** A fresh card for a lesson entering review rotation. */
export function newCard(): Card {
  return createEmptyCard()
}

/**
 * Map an objective score to an FSRS grade.
 * @param score - score in [0,1].
 * @param thresholds - config boundaries (again < hard < good).
 */
export function gradeFor(score: number, thresholds: RatingThresholds): Grade {
  if (!Number.isFinite(score)) return Rating.Again
  if (score >= thresholds.good) return Rating.Easy
  if (score >= thresholds.hard) return Rating.Good
  if (score >= thresholds.again) return Rating.Hard
  return Rating.Again
}

/**
 * Advance one card after a review.
 * @param card - card before the review.
 * @param score - objective score of the finished review.
 * @param now - epoch ms.
 * @param thresholds - score→grade mapping.
 * @returns the next card (with the next due date).
 */
export function nextCard(card: Card, score: number, now: number, thresholds: RatingThresholds): Card {
  const grade = gradeFor(score, thresholds)
  if (card.state === State.New || card.state === State.Learning) {
    return scheduler.next(card, new Date(now), grade).card
  }
  return scheduler.next(card, new Date(now), grade).card
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
