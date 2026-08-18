// 为 CSS Modules 与普通 CSS import 提供浏览器端类型声明

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
