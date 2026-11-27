// 本地工作区版本的入口。
// 界面沿用原有的编辑器 / Agent 渲染 / 侧栏；数据源由 server/workspace-adapter.mjs
// 映射到本地文件夹，因此「打开工作区 → 编辑文件」是唯一的主流程。
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
// 工作区选择页的容器样式叠加在既有界面样式之上。
import './workspace.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
