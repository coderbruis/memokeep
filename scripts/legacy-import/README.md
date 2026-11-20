# 旧工作空间导出的开发工具

此目录只供开发命令 `core/apps/desktop/export-legacy-workspace.cjs` 和合成数据兼容测试使用，用于把旧 JSON 工作空间及目录中的图片汇总为便携备份。它不进入 Community 或 Pro 的安装包，不参与应用保存、后台服务或恢复事务。

应用中的 SQLite、完整备份预览／恢复／撤回和 Markdown 发布均以 `core/crates/memokeep-storage/` 的 Rust 实现为准。此处保留 Node.js 是为了在更换宿主后仍能读取旧工作空间，不维持一套并行运行的业务服务。

`backup.cjs` 负责旧格式备份校验与媒体清单，`note-images.cjs` 读取旧磁盘图片。请勿把此目录导入产品页面或桌面宿主。
