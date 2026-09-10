/**
 * DSH 模块的本地类型面（METIS 插件所用 API 子集）。
 *
 * 背景：metis workspace 不在 DSH pnpm workspace 内，且不做 DSH 传递依赖安装；
 * DSH 包的完整 .d.ts 依赖其 workspace 类型图，无法被独立 workspace 干净解析。
 * 因此这里以 declare module 提供「METIS 插件实际使用的 API 形状」的结构化类型；
 * 运行时使用 DSH 构建产物（vitest alias / profile node_modules），契约一致。
 *
 * 完整权威类型以 DSH 包内 src 为准；此处形状如有漂移，以 DSH 源码为权威修正本文件。
 * 边界参数类型在工具 JSON 边界由 DSH 执行层真实校验（defineTool execute 收到
 * 的 args 已经过 parameters 校验），因此边界处按 any 处理不损失实际安全性。
 */

declare module '@deepseek-ai/cordis' {
  /** Cordis 服务基类：constructor 把 self 以 `key` 挂到 ctx（声明合并暴露 ctx.<key>）。 */
  export class Service {
    ctx: any
    constructor(ctx: any, key: string)
  }
  /** 上下文接口：插件服务经声明合并挂载，此处提供开放索引兜底。 */
  export interface Context {
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export interface ToolParameterSpec {
    type: 'string' | 'number' | 'boolean' | 'json'
    description?: string
    required?: true
  }
  export interface ToolDefinition<Args = any, Value = any> {
    name: string
    description: string
    parameters: Record<string, ToolParameterSpec>
    output: {
      schema: Record<string, unknown>
      render: (args: Args, value: Value) => Array<{ type: 'text'; text: string }>
    }
    execute: (args: Args, exec?: unknown) => Promise<Value>
  }
  /** args 形状由 parameters 声明并在 DSH 执行层校验；此处边界为 any。 */
  export function defineTool(spec: {
    name: string
    description: string
    parameters: Record<string, ToolParameterSpec>
    output: {
      schema: Record<string, unknown>
      render: (args: any, value: any) => Array<{ type: 'text'; text: string }>
    }
    execute: (args: any, exec?: unknown) => Promise<any>
  }): { name: string }

  export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
}

declare module '@deepseek-ai/dsh-util-values' {
  export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
}
