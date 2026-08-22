// 后端事实源变更通知：只表达数据域失效，不携带业务数据，也不理解前端

export type DataChangeChannel = 'workspace' | 'learning' | 'notes'

export interface DataChange {
  readonly id: number
  readonly channel: DataChangeChannel
  readonly workspaceId?: string
}

export type DataResetSignal = {readonly id: number, readonly channel: 'reset'}

const BUFFER_SIZE = 256

// 进程内单调事件与最近事件缓冲，供 SSE 断线后按 Last-Event-ID 补发
export class DataChangeBus {
  private nextId = 1
  private readonly listeners = new Set<(change: DataChange) => void>()
  private readonly recent: DataChange[] = []

  publish(channel: 'workspace' | 'learning', workspaceId: string): DataChange

  publish(channel: 'notes'): DataChange

  publish(channel: DataChangeChannel, workspaceId?: string): DataChange {
    const change: DataChange = {id: this.nextId++, channel, ...(workspaceId === undefined ? {} : {workspaceId})}

    this.recent.push(change)

    if (this.recent.length > BUFFER_SIZE) this.recent.shift()

    for (const listener of this.listeners) listener(change)

    return change
  }

  subscribe(listener: (change: DataChange) => void): () => void {
    this.listeners.add(listener)

    return () => { this.listeners.delete(listener) }
  }

  // 返回待补发事件；null 表示需要全量重载
  eventsSince(lastId: number): DataChange[] | null {
    if (lastId < 0 || lastId > this.currentId()) return null
    if (this.currentId() - lastId > BUFFER_SIZE) return null

    return this.recent.filter(change => change.id > lastId)
  }

  // 当前事件边界，用于首连和断线过久时的全量重载信号
  resetSignal(): DataResetSignal { return {id: this.currentId(), channel: 'reset'} }

  private currentId(): number { return this.nextId - 1 }
}
