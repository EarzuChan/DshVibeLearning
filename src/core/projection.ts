import {z} from 'zod'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {SessionDvlLearningState} from '../shared/projection.ts'
import {isLearningEntered, parseLearningChangeOutline} from './learning-event.ts'

// 接线值校验 schema
export const dvlLearningSchema = z.object({entered: z.boolean(), activeOutlineId: z.string().min(1).nullable()})

// 折叠状态与接线值同形
type FoldState = SessionDvlLearningState // 折叠态岂不是“旧的态”吧

// 会话学习状态投影：entered 单向折叠，激活纲目按事件后写后得
export const dvlLearningProjection = {
  key: 'dvlLearning' as const, schema: dvlLearningSchema, stateVersion: 2, // 这个版本何意味？
  init(): FoldState { return {entered: false, activeOutlineId: null} },
  apply(state: FoldState, event: SessionEvent): FoldState { // THINKING：每次更新就是往旧的上叠？
    // 更新当前激活的大纲
    const outlineId = parseLearningChangeOutline(event)
    if (outlineId !== undefined) return {...state, activeOutlineId: outlineId}

    // 更新当前的进入与否
    if (!isLearningEntered(event) || state.entered) return state
    return {...state, entered: true}
  },
  view(state: FoldState): FoldState { return state },
}
