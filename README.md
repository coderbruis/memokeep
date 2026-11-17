# MemoKeep Community

MemoKeep 是一款以本地数据为基础的桌面笔记与复习应用，将知识整理、记忆卡片和间隔复习放在一起。

本仓库发布 Community 版的完整基础功能，采用 [MIT 许可证](LICENSE)。

## 功能

- **知识整理**：知识库、目录、标签、收藏、搜索和多标签页笔记。
- **笔记编辑**：富文本、图片、表格、代码块，以及 Mermaid 图表源码编辑与预览。
- **记忆复习**：从笔记整理记忆卡片，使用 FSRS 安排间隔复习，查看来源笔记。
- **日常学习**：学习计划、备忘录与番茄钟。
- **数据管理**：本地保存、备份与导入导出。
- **语音作答**：在 macOS 上通过系统语音识别将口述答案转成文字。

Pro 是可选的付费扩展，提供自由复习、进阶统计等增强功能。Community 可以独立安装、使用、开发和测试，无需 Pro 账号。

## 本地运行

需要 Node.js 22 LTS、npm，以及可运行 Electron 的桌面环境。

```sh
git clone https://github.com/coderbruis/memokeep.git
cd memokeep
npm ci
npm start
```

`npm ci` 按 `package-lock.json` 安装依赖，首次安装需要联网下载 npm 包和 Electron。

### macOS 语音作答

语音作答依赖 macOS 的 Speech 与 AVFoundation 框架。开发时安装 Xcode Command Line Tools，并先编译语音辅助程序：

```sh
xcode-select --install
node scripts/build-speech-helper.cjs
npm start
```

首次使用时，按系统提示授予麦克风和语音识别权限。默认要求本机识别；支持的语言和可用性取决于系统及已安装的语音资源。如果在语音设置中允许在线识别，音频可能由 Apple 的服务处理。其他平台仍可使用文字作答。

## 检查与测试

```sh
npm run check
npm test
npm run verify:source
```

`check` 检查源码语法，`test` 运行自动化测试，`verify:source` 检查 Community 源码边界。CI 在 Ubuntu 上运行这三项检查；macOS 打包和真实麦克风测试需在 macOS 上另行验证。

## 本地数据

笔记、卡片和学习记录默认保存在本机。建议定期备份，并在导入或批量修改前保留一份副本。在线语音识别及用户主动访问的外部链接可能产生网络请求。

## 参与贡献

欢迎通过 [Issues](https://github.com/coderbruis/memokeep/issues) 报告问题或提出建议，也欢迎提交 Pull Request。提交前请运行上述检查；涉及界面的改动请附上复现步骤或效果截图。

项目代码采用 MIT 许可证；第三方组件适用各自的许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
