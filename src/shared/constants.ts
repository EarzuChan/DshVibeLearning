// 稳定的跨模块标识集中定义，避免 Cordis 名称与协议字符串散落重复

// --- Cordis 标识 ---

export const CORDIS_CONTEXT_LEARNING = 'dvl:learning'
export const CORDIS_SECTION_SNAPSHOT = 'dvl:snapshot'
export const CORDIS_EFFECT_DICTIONARIES = 'dvl: dictionaries'
export const CORDIS_EFFECT_LIFECYCLE_CONTROLLER = 'dvl: lifecycle controller'
export const CORDIS_EFFECT_DATA_CHANGE_SUBSCRIBER = 'dvl: data change subscriber'
export const CORDIS_EFFECT_LEARNING_DATA_CONTROLLER = 'dvl: learning data controller'
export const CORDIS_EFFECT_LEARNING_VIEW_TAB = 'dvl: learning view tab'
export const CORDIS_EFFECT_BACKEND_ROUTES = 'dvl: /learning routes'
export const CORDIS_EFFECT_AGENT_TOOLS = 'dvl: agent tools'
export const CORDIS_SLOT_CONVERSATION_VIEW = 'conversation.view'
export const CORDIS_SLOT_SESSION_HEADER_UTILITIES = 'conversation.session.header.utilities'
export const CORDIS_SLOT_TOOL_CALL_TOOLVIEW = 'tool.call.toolview'

// --- 前端“贡献点” ---

export const LEARNING_VIEW_ID = 'vibe-learning'
export const LEARNING_OUTLINE_CARD_ID = 'vibe-learning-outline-card'
export const LEARNING_NOTES_CARD_ID = 'vibe-learning-notes-card'

// --- HTTP 路由 ---

// 挂在 DSH webServer 上的路由前缀，无尾斜杠，子路径一律以此为根
export const DVL_SERVER_ROUTE_PREFIX = '/learning'
