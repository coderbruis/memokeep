# 便携备份与可选附件扩展

`memokeep-storage::backup` 维护工作空间 JSON、笔记图片和恢复前检查点。可选附件实现通过 `BackupExtension` 接入；核心不引用扩展的业务字段、私有表或收费实现。

## 接入契约

`BackupExtension` 有四个职责：

- `namespace()` 返回稳定且唯一的扩展名。
- `capture(connection, fields, kind)` 在调用者的 SQLite 快照中读取附件，返回 `ExtensionSnapshot`。
- `prepare(connection, fields, snapshot)` 验证领域引用、格式和完整性，返回通用 `ExtensionSummary`；旧备份没有该 namespace 时，`snapshot` 为 `None`。该步骤不能修改业务数据。
- `restore(connection, before, after, snapshot)` 在业务数据和图片使用的同一 SQLite 恢复事务中安装扩展状态。

回调借用宿主提供的连接，不应重新打开连接、提交事务或持有长期业务快照。附件 ID、MIME、字节上限与 SHA-256 由核心验证；领域 ID 约束、MIME 与容器内容是否一致、引用是否齐全仍由扩展验证。

`CaptureKind::Portable` 表示对外导出；`Checkpoint` 表示内部撤销检查点。提供者需明确定义未引用附件的策略，并确保内部检查点保留精确撤销所需的状态。事务保证适用于同一 SQLite 中的数据；不能把另外的文件系统写入描述为该 SQLite 事务的一部分。

宿主使用 `register_extension(connection, namespace)` 声明完整备份所需的提供者。未加载所需提供者的工具会返回 `UnsupportedExtension`，不会导出一个静默漏附件的“完整备份”。该注册表属于本机元数据，不进入业务实体和同步队列。

Tauri 宿主通过可选的 `DesktopBackupExtensions(Vec<Arc<dyn BackupExtension>>)` 注册提供者。未注册扩展时，社区宿主和 CLI 仍可独立运行。

## API 与兼容包装

| 原 API | 带扩展的 API |
| --- | --- |
| `export` | `export_with_extensions` |
| `restore` | `restore_with_extensions` |
| `preview` | `preview_with_extensions` |
| `apply_preview` | `apply_preview_with_extensions` |
| `apply_preview_with_commit` | `apply_preview_with_extensions_and_commit` |
| `can_undo` | `can_undo_with_extensions` |
| `undo` | `undo_with_extensions` |
| `undo_with_commit` | `undo_with_extensions_and_commit` |

原 API 保留为空扩展包装，已有 CLI、纯笔记夹具及提交钩子保持兼容。恢复提交钩子仍在相同事务内执行；任何附件安装或钩子失败都会回滚业务数据、图片、扩展状态和本机恢复记录，恢复预览可在问题修复后重试。

## 文件格式

工作空间的 `version` 与 `backup.version` 是两个独立版本。

- 原始 JSON 和 `backup.version = 1` 继续可读，图片规则保持不变。
- 包含附件扩展的导出使用 `backup.version = 2`，防止不认识扩展的旧 reader 忽略附件后仍报告成功。
- `backup.extensions` 是以 namespace 为键的对象。每个值包含扩展封装版本 `version: 1`、提供者定义的 `metadata`，以及 `attachments` 数组。
- 每个附件含 `id`、`mimeType`、`size`、小写十六进制 `sha256` 和 base64 `data`。重复 ID、大小或哈希不匹配会在写入前拒绝。
- 未知 namespace 显式拒绝。浏览器预览不能安装附件扩展，因此引导用户使用支持相应扩展的桌面宿主。

通用限额为：namespace/附件 ID 最长 128 字节，使用 ASCII 字母、数字和 `._-`，并拒绝对象原型保留名；MIME 最长 256 字节、不得含控制字符；单附件最多 128 MiB，每 namespace 最多 10,000 个附件。图片与扩展附件解码后的总额共享 512 MiB 限额，整个 JSON 文件最多 700 MiB。提供者可采用更严格的限额。

## 预览、取消、应用和撤销

预览返回 `extensions: { namespace: { label, attachments, missing, warnings } }` 和合并后的 `warnings` 数组。通用设置页展示这些摘要与警告；标签、警告均按文本转义。对于缺少扩展附件的旧备份，提供者应明确报告无法恢复的内容或拒绝，不能静默声称完整恢复，也不能在预览时改写原领域元数据。

预览令牌绑定源文件摘要、业务修订及当前扩展状态指纹。文件、业务数据或仅附件状态发生变化后，应用需重新预览。取消只清理预览记录。

应用在同一写事务内捕获恢复前的业务数据和扩展检查点，防止独立附件写入与检查点交错。检查点文件摘要和恢复后的扩展指纹记录在本机 SQLite 中。撤销同时复核业务修订、检查点内容及扩展指纹；新增业务修改、独立附件修改或检查点被替换后，不再覆盖当前数据。

首次启动的修订 0 空工作区仍不能对外导出有效备份。只有内部检查点可以将它表示为规范化空业务状态，从而支持首次恢复后的撤销。应用与撤销保持修订单调递增，不把修订重置为 0，也不接受缺少 `documents/cards` 的外部畸形备份。

选择的本机发布目录不由备份重新授权或替换；Markdown 持续发布在正本恢复提交之后继续更新。
