// 无损 JSON 值类型，与 DSH 内部的 JsonValue 同构（官方不再从公开包导出它）
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue}
