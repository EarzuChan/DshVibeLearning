// DVL 持久化 JSON 类型定义，所有内容必须能经 JSON.stringify 往返，工作区 learning 文件是权威副本

// 单个课程节点的学习进度状态
export type LessonState = 'not-started' | 'learning' | 'qa' | 'done'

// 模型可创作并展示的三种工件类型
export type ArtifactKind = 'lesson' | 'review' | 'quiz'

// 纲目树中的一个节点，group 可嵌套，lesson 为叶子课程
export interface OutlineNode {
  readonly id: string
  readonly kind: 'group' | 'lesson'
  readonly title: string
  readonly order: number // 同级节点顺序，升序排列
  readonly parentId: string | null // null 表示直接挂在纲目根节点下
  readonly lessonId?: string // lesson 节点的稳定课程 ID，纲目修改时保持不变
  readonly state?: LessonState // lesson 节点的学习进度状态，默认为 not-started
  readonly artifactHash?: string // 已展示课程工件的当前内容哈希
  readonly description?: string // 提供给模型的可选课程目标或备注
}

// 持久化纲目文件，对应 outlines/<id>.json
export interface Outline {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly nodes: OutlineNode[]
}

// 单个工件的元数据，对应 index.html 同目录下的 meta.json
export interface ArtifactMeta {
  readonly kind: ArtifactKind
  readonly targetId: string // 工件所属课程 ID，review 和 quiz 亦如此
  readonly title: string
  readonly createdAt: string
}

// 一次工件展示或作答尝试，只记录机制信息，不包含教学判断
export interface ArtifactRun {
  readonly runId: string
  readonly artifactHash: string
  readonly kind: ArtifactKind
  readonly targetId: string
  readonly callId: string // 创建或恢复该运行的 DSH 工具 callId，同时作为幂等键
  readonly createdAt: string
}

// DVL 包装不透明提交结果的机制信封，对应 runs/<runId>/result.json，payload 原样保存且不解析教学语义
export interface ResultEnvelope {
  readonly kind: ArtifactKind
  readonly targetId: string
  readonly artifactHash: string
  readonly runId: string
  readonly submittedAt: string
  readonly payload: unknown // window.DVL.submit(...) 提交的任意 JSON 值
}

// DVL 包装模型不透明判阅报告的机制信封，对应 runs/<runId>/feedback.json，payload 原样保存且不校验结构
export interface FeedbackEnvelope {
  readonly kind: ArtifactKind
  readonly targetId: string
  readonly artifactHash: string
  readonly runId: string
  readonly savedAt: string
  readonly payload: unknown
}

// 工件下展示的一次运行摘要，只包含状态信息而不包含 payload
export interface ArtifactRunSummary {
  readonly runId: string
  readonly createdAt: string
  readonly hasResult: boolean
  readonly hasFeedback: boolean
}

// 笔记访问权限
export type NoteAccess = 'private' | 'readable' | 'readwrite'

// 笔记文件夹
export interface NoteFolder {
  readonly id: string
  readonly name: string
  readonly createdAt: string
}

// 一条全局存储的笔记，模型只能看到当前权限为 readable 或 readwrite 的笔记
export interface Note {
  readonly id: string
  readonly folderId: string
  readonly title: string
  readonly markdown: string
  readonly tags: readonly string[] // 使用 workspace:<id>、outline:<id>、lesson:<id> 等前缀，可同时存在多个
  readonly access: NoteAccess
  readonly createdAt: string
  readonly updatedAt: string
}

// 笔记数据库
export interface NotesDb {
  readonly folders: NoteFolder[]
  readonly notes: Note[]
}

// 模型完成一次判阅后明确给出的 FSRS 评级
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy'

// 一次已完成的复习记录，持久保存在卡片历史中
export interface ReviewRecord {
  readonly at: string
  readonly rating: ReviewRating // 模型明确给出的 FSRS 评级，不从分数推导
  readonly sourceRunId: string // 评级来源的结果运行，同时作为幂等来源
  readonly reason?: string // 可选的评级理由
}

// 持久化 FSRS 卡片文件，对应 cards/<lessonId>.json
export interface CardFile {
  readonly lessonId: string
  readonly card: Record<string, unknown> // 序列化后的 ts-fsrs Card
  readonly history: ReviewRecord[]
}

// 服务端持有的规范展示描述符，展示期间可通过 cwd + callId 获取，结束后从持久化工具结果元数据恢复
export interface PresentArtifactDescriptor {
  readonly version: 1
  readonly callId: string
  readonly workspaceId: string
  readonly kind: ArtifactKind
  readonly category: string // URL 分类路径段，即 lessons、reviews 或 quizzes
  readonly hash: string
  readonly targetId: string
  readonly title: string
  readonly runId: string // 当前运行不可猜测的 ID，同时存在于规范 URL 中
  readonly url: string // 服务端签发的当前运行规范 URL
}

// present_artifact 的带内结束结果
export type PresentOutcome = { readonly kind: 'result'; readonly result: ResultEnvelope } | { readonly kind: 'no-result'; readonly reason: 'interrupted' | 'timeout' | 'error'; readonly detail?: string }

// 复习计划工具确认写入前展示的只读候选，commitReviewPlan 写入卡片文件前均不持久化
export interface ReviewPlanProposal {
  readonly lessonId: string
  readonly rating: ReviewRating
  readonly sourceRunId: string
  readonly reason?: string
  readonly current: CardFile | null // 当前卡片文件，不存在时为 null
  readonly nextCard: Record<string, unknown> // 应用 rating 后的候选下一张卡片
  readonly due: string // 候选下次复习时间，ISO 时间戳
  readonly alreadyApplied: boolean // sourceRunId 是否已存在于当前卡片历史中
}

// 每轮快照注入的单个纲目信息
export interface SnapshotOutline {
  readonly id: string
  readonly title: string
  readonly active: boolean
}

// 每轮快照注入的当前进行中课程信息
export interface SnapshotLesson {
  readonly id: string
  readonly title: string
  readonly state: LessonState
}

// 每轮快照注入的到期复习信息
export interface SnapshotCard {
  readonly lessonId: string
  readonly lessonTitle: string
  readonly due: string
  readonly state: string
  readonly overdue: boolean
}

// 注入 P2 prompt 与 GUI API 的完整学习状态快照
export interface LearningSnapshot {
  readonly workspaceId: string
  readonly learningDirExists: boolean
  readonly activeOutlineId: string | null
  readonly outlines: SnapshotOutline[]
  readonly currentLessons: SnapshotLesson[] // 处于 learning 或 qa 状态的课程，即当前课程位置
  readonly dueCards: SnapshotCard[] // 当前已到期卡片，按 due 时间升序排列
}