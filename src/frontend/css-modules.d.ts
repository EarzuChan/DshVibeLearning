// 干啥的文件？

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'