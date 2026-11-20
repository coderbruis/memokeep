# MemoKeep Community

MemoKeep 是一款以本地数据为基础的桌面笔记与复习应用，将知识整理、记忆卡片和间隔复习放在一起。

本仓库发布 Community 版的完整基础功能，采用 [MIT 许可证](LICENSE)。

## 功能

- **知识整理**：知识库、目录、标签、收藏、搜索和多标签页笔记。
- **笔记编辑**：富文本、图片、表格、代码块，以及 Mermaid 图表源码编辑与预览。
- **记忆复习**：从笔记整理记忆卡片，使用 FSRS 安排间隔复习，查看来源笔记。
- **日常学习**：学习计划、备忘录与番茄钟。
- **数据管理**：本地保存、备份与导入导出；macOS 系统文件打开与拖入预览。
- **链接卡片**：Rust 抓取网页标题、描述和封面元数据，保留链接／标题／卡片切换。
- **语音作答**：共享语音流程支持转写和答案匹配，实际识别取决于宿主提供的语音服务。

Pro 是可选的付费扩展，提供自由复习、进阶统计等增强功能。Community 可以独立安装、使用、开发和测试，无需 Pro 账号。

## 本地运行

默认桌面版本使用 Tauri。开发需要 macOS、Node.js 24、Rust stable 与 Xcode Command Line Tools。

```sh
git clone https://github.com/coderbruis/memokeep.git
cd memokeep
npm ci
npm --prefix apps/desktop ci
npm start
```

`npm start` 使用 Tauri 应用标识和 SQLite 工作区。旧工作区可通过 `apps/desktop/export-legacy-workspace.cjs` 转换为便携备份，再从「设置 → 数据与备份」预览和恢复。

## 检查与测试

```sh
npm run check
npm test
npm run verify:source
npm run test:desktop
npm run pack:mac
npm run dist:mac
```

`check` 检查源码语法；`test` 运行 JavaScript 测试，以及 Rust 存储库的 Clippy 和测试，任一步失败都会返回失败。仅调试前端时可用 `npm run test:js`，提交前仍需运行完整检查。`verify:source` 检查 Community 源码边界。macOS CI 另外运行桌面宿主 Rust 检查及隔离的 Tauri WebView 迁移、保存和回退验收。`pack:mac` 生成 `.app`，`dist:mac` 生成 DMG。

旧工作空间导出的 Node.js 兼容代码集中在 `scripts/legacy-import/`，只供开发命令和合成数据测试使用，不进入安装包。运行时的备份恢复、图片、Markdown 发布、链接抓取与文件打开由 Rust 实现。服务边界和隔离测试见[桌面服务](docs/desktop-services.md)。

## 本地数据

笔记、卡片和学习记录默认保存在本机。建议定期备份，并在导入或批量修改前保留一份副本。在线语音识别及用户主动访问的外部链接可能产生网络请求。

## 参与贡献

欢迎通过 [Issues](https://github.com/coderbruis/memokeep/issues) 报告问题或提出建议，也欢迎提交 Pull Request。提交前请运行上述检查；涉及界面的改动请附上复现步骤或效果截图。

项目代码采用 MIT 许可证；第三方组件适用各自的许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
