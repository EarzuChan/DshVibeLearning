import {z} from 'zod'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {SessionDvlLearningState} from '../shared/projection.ts'
import {isLearningEntered, parseLearningChangeOutline, parseLearningDelegate} from './learning-event.ts'

// 接线值校验 schema
export const dvlLearningSchema = z.object({entered: z.boolean(), activeOutlineId: z.string().min(1).nullable(), delegatedFrom: z.string().min(1).nullable()})

// 折叠状态与接线值同形
type FoldState = SessionDvlLearningState

// 会话学习状态投影：entered 单向折叠，激活纲目按事件后写后得，子代理归属只认第一条
export const dvlLearningProjection = {
  key: 'dvlLearning' as const, stateSchema: dvlLearningSchema, stateVersion: 4, // 投影缓存版本，折叠逻辑或状态形状变化时递增
  init(): FoldState { return {entered: false, activeOutlineId: null, delegatedFrom: null} },
  apply(state: FoldState, event: SessionEvent): FoldState {
    // 更新当前激活的大纲
    const outlineId = parseLearningChangeOutline(event)
    if (outlineId !== undefined) return {...state, activeOutlineId: outlineId}

    // 记录子代理归属
    const rootSessionId = parseLearningDelegate(event)
    if (rootSessionId !== undefined) return state.delegatedFrom === null ? {...state, delegatedFrom: rootSessionId} : state

    // 更新当前的进入与否
    if (!isLearningEntered(event) || state.entered) return state
    return {...state, entered: true}
  },
  wire: {
    viewSchema: dvlLearningSchema,
    view(state: FoldState): FoldState { return state },
  },
}
