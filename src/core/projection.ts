import {z} from 'zod'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {DvlLearningProjection} from '../shared/projection.ts'
import {isLearningEntered, learningEnteredAt} from './learning-event.ts'

// 接线值校验 schema
export const dvlLearningSchema = z.object({entered: z.boolean(), enteredAt: z.string().nullable()})

// entered 后不再变化的折叠状态
type FoldState = DvlLearningProjection

// 单向折叠：entered 一旦为真永远为真，后续同型事件无操作
export const dvlLearningProjection = {
    key: 'dvlLearning' as const,
    schema: dvlLearningSchema,
    stateVersion: 1,
    init(): FoldState {
        return {entered: false, enteredAt: null}
    },
    apply(state: FoldState, event: SessionEvent): FoldState {
        if (state.entered) return state
        if (!isLearningEntered(event)) return state
        return {entered: true, enteredAt: learningEnteredAt(event.data.text)}
    },
    view(state: FoldState): DvlLearningProjection {
        return {entered: state.entered, enteredAt: state.enteredAt}
    },
}
