# MemoKeep 宿主接口契约

现有页面通过 `window.memoKeepDesktop` 和持久化适配层调用桌面宿主。阶段 A 固定可观察语义与现有兼容差异。新宿主可使用不同 IPC，但保留页面调用形状或用适配层转换。公共接口只承载基础能力。原生端口和扩展服务按构建版本注册，公开核心可以独立运行。

## 现有接口及基线

| 能力 | 当前入口 | 可观察契约 |
| --- | --- | --- |
| 读取完整快照 | `read()` | 返回宿主快照。调用方对本地副本的修改不直接写盘。全量提交前，调用方把编辑所依据的快照作为基线传入 `write` |
| 增量读取 | `readChanges(token?)` | 返回 `{data,token}` 或 `{patch,token}`，两者互斥。无 token、过期 token 或另一窗口的 token 返回全量。token 只用于对应窗口的视图快照，不是磁盘代次、同步游标或写权限 |
| 写入 | `write(data,base?,context?)`、`writeChanges(patch,token,context?)` | 全量入口按基线合并。补丁入口按现有数据补丁规则作用于最新状态。当前 token 影响返回全量还是补丁，不能当并发写入锁。新具名业务命令若声明预期修订，陈旧写入须明确拒绝，不悄悄重用旧请求 |
| 上下文 | `context` | 可省略。存在时由宿主校验 `commandId` 与 `domainEvents`，保留事实及顺序。大小和数量以现有 `normalizeTransactionContext` 为准，限制越界和原型字段 |
| 变更提示 | `onDataChanged(callback)` | 现有回调是失效提示，收到后重读。未来适配器必须提供释放函数，关闭窗口时回收订阅，事件不携带凭证或完整业务快照 |
| 关闭 | `onRequestClose`、`confirmClose`、`cancelClose` | 由宿主请求，页面等待保存后确认，失败可取消。新适配器把确认绑定窗口和当次请求，重复确认不能授权关闭其他窗口 |
| 附件与文件 | `chooseNoteImage`、`saveNoteImage`、`readNoteImage`、`getPathForFile` 等 | 现有正文引用稳定 ID。新端口采用限于调用方与会话的异步授权句柄，按用途、大小和来源校验。调用方的路径字符串不构成授权 |
| 基础语音／计时 | `speech.*`、`pomodoro.*` | 语音订阅可释放。宿主提供真实可用性和权限状态，终止语音后不接收过期事件。计时器运行状态存在宿主，保存的专注事实保留原 ID |

Tauri 基线使用[桥接契约测试](../scripts/host-adapter-contract.test.cjs)和[真实 WebView 测试](../apps/desktop/test-desktop.cjs)。Capacitor 的私有仓储入口由私库契约测试覆盖。测试使用合成快照和临时工作区。

## 阶段 B 及候选宿主的增补验收

- 新具名请求使用有界且可序列化的输入、稳定请求标识和明确的错误码。涉及同一事务的重试保持同一标识。取消只在尚未跨越不可撤销提交决定时有效。提交后如暂不能确认，报告 `RECOVERY_REQUIRED` 并等待既有事务恢复。
- 调用结果区分输入错误 `INVALID_REQUEST`、无授权 `PERMISSION_DENIED`、陈旧修订 `STALE_REVISION`、工作空间占用 `WORKSPACE_BUSY`、不支持 `UNSUPPORTED` 和需恢复 `RECOVERY_REQUIRED`。旧接口可按其已有返回形状转换，不能把失败伪装成空集合或保存成功。
- 持久化入口串行化写入，关联同一工作空间与 `commitId`。在可恢复的存储和必需参与者完成持久化后才返回业务成功并发布变更。进度事件和被取消的监听都不能改变提交状态。
- 每个订阅返回幂等的释放函数。跨窗口事件仅提示已提交变化。关闭时停止新增写入，等待保存队列或显式进入恢复状态，再完成窗口握手。
- 命令按平台与可信窗口注册，检查调用方、工作空间和句柄所有权。仅显式提供具名查询及系统动作，避免开放任意 SQL、程序、路径或网络请求。

现有桥接的已知差异包括部分 `onX` 没有返回释放函数，`getPathForFile` 同步返回路径，以及通用 `dataTransactions` 会报告最终提交参与者的异常后继续执行。它们属于现状基线。阶段 B 要为可恢复参与者提供阻止成功确认的结果，与[存储提交顺序](storage-v3-format.md#提交记录)一致。不能用已有 legacy JSON 路径的通过结果替代新门槛。
