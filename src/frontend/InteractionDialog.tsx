import {useEffect, useState} from 'react'
import {Button, JsonTree, MarkdownText, Modal} from '@deepseek-ai/dsh-client-ui-primitives'
import type {InteractionDialogProps} from './contract.ts'
import type {PendingInteractionDto} from '../shared/api.ts'
import css from './InteractionDialog.module.css'

// Markdown 与 JSON 树的界面文案，原语组件要求由调用方提供
const MARKDOWN_LABELS = {code: {copyLabel: '复制', copiedLabel: '已复制'}, footnotes: '脚注'}
const JSON_TREE_LABELS = {copyValue: '复制值', copyJson: '复制 JSON', copyPath: '复制路径', copyPrettyJson: '复制格式化 JSON', copyCompactJson: '复制紧凑 JSON', copied: '已复制', copyFailed: '复制失败', collapseNode: '折叠', expandNode: '展开', copyButtonTitle: (action: string) => action}

// FIXME：好像还有问题？
function Dialog({interaction, busy, error, onSelect}: {readonly interaction: PendingInteractionDto; readonly busy: boolean; readonly error: string | null; readonly onSelect: (optionId: string) => void}) {
    return <Modal open onClose={() => {}} title={interaction.title} className={css.dialog} headless>
        <div className={css.content}>
            <header className={css.header}><h2 className={css.title}>{interaction.title}</h2></header>

            <div className={css.body}>
                <p className={css.instruction}>请查看下方内容，并选择一个选项以继续</p>
                {error !== null && <div className={css.error} role="alert">{error}</div>}
                {interaction.content.kind === 'markdown' && <div className={css.markdown}><MarkdownText text={interaction.content.text} labels={MARKDOWN_LABELS}/></div>}
                {interaction.content.kind === 'json' && <div className={css.json}>{typeof interaction.content.value === 'object' && interaction.content.value !== null ? <JsonTree data={interaction.content.value as object | unknown[]} label="确认内容" labels={JSON_TREE_LABELS}/> : <pre className={css.primitiveJson}>{JSON.stringify(interaction.content.value, null, 2)}</pre>}</div>}
            </div>

            <footer className={css.options}>{interaction.options.map(option => <Button key={option.id} className={css.option} variant={option.id === 'confirm' ? 'primary' : 'outline'} disabled={busy} title={option.description} aria-label={option.description === undefined ? option.label : `${option.label}：${option.description}`} onClick={() => { onSelect(option.id) }}>{option.description === undefined ? option.label : `${option.label}：${option.description}`}</Button>)}</footer>
        </div>
    </Modal>
}

export function InteractionDialog({sessionId, connect, respond}: InteractionDialogProps) {
    const [interactions, setInteractions] = useState<readonly PendingInteractionDto[]>([])
    const [busyInteractionId, setBusyInteractionId] = useState<string | null>(null)
    const [interactionError, setInteractionError] = useState<{readonly id: string; readonly message: string} | null>(null)
    useEffect(() => {
        setInteractions([])
        return connect(sessionId, event => {
            setInteractions(current => event.type === 'requested' ? current.some(item => item.id === event.interaction.id) ? current : [...current, event.interaction] : current.filter(item => item.id !== event.interactionId))
        })
    }, [connect, sessionId])

    const interaction = interactions[0]
    if (interaction === undefined) return null
    const select = (optionId: string): void => {
        if (busyInteractionId === interaction.id) return
        setBusyInteractionId(interaction.id)
        setInteractionError(null)
        void respond(interaction.id, sessionId, optionId).catch(cause => {
            setBusyInteractionId(current => current === interaction.id ? null : current)
            setInteractionError({id: interaction.id, message: cause instanceof Error ? cause.message : String(cause)})
        })
    }
    return <Dialog interaction={interaction} busy={busyInteractionId === interaction.id} error={interactionError?.id === interaction.id ? interactionError.message : null} onSelect={select}/>
}
