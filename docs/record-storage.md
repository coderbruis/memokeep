# 可选笔记记录布局

基础工作空间仍支持快照 API。`documents`、`cardDocuments` 可显式升级到记录布局版本 1；普通旧工作空间不会自动转换。桌面桥接只在临时目录且 `.memokeep-isolated` 内容为 `synthetic` 的隔离库中自动请求带确认的激活。其他工作空间须调用 `activateRecordStorage({confirm:true})`，调用者负责先向用户说明并确认。

激活在一个 SQLite 事务中建立 `workspace_record_mode`、`workspace_record_collection` 和 `workspace_record`，逐项验证笔记 ID、转写数组顺序，并移除对应 `workspace_field` 数组。最后将 SQLite `user_version` 从 3 升到 4，强制旧 v3 读者拒绝打开，避免把已移走的数组误读为空。任何失败回滚全部布局变动和版本；逻辑快照和业务修订不变。新读者兼容 v3/v4，但新库与未确认的旧库保持 v3。后续快照、字段与记录写入共用一个正本，不能再直接更新旧数组行。

`workspace_record` 以 `(scope, field, id)` 为主键，`position` 保留兼容数组顺序，`payload` 保留完整共享记录。集合的存在与空数组分别记录。摘要查询通过更新时间索引分页，返回标题、来源、目录和时间，不包含正文或历史；单条读取按主键选择正文。

公共事务接口：

- `read_on`、`read_fields_on`：在调用者的事务中读取一致快照，兼容两种布局。
- `read_records_on`：读取指定 ID。记录布局直接按主键查询；旧布局保留数组兼容读取。
- `write_snapshot_on`、`write_fields_on`：旧调用者继续使用，启用记录布局后按记录比较并更新。
- `write_records_on`：记录增删改和其他字段更新在同一修订、同一事务中提交；冲突修订和无效数据报错。
- `records::activate_on`：显式物理布局升级，扩展宿主可在同一事务中核对升级前后逻辑快照并登记自己的证据。

实际桌面编辑通过 `transactNote` 使用写时复制，保存确认期间只冻结受影响的记录。目标记录读取、三方合并、CAS 写入均不传整个笔记数组；同字段冲突保留当前编辑，较晚的本机修改继续保持未保存状态。其他业务事务及复习撤销保留原有契约。新增笔记和数组重排仍走兼容保存，不宣称全部写入都已按记录执行。

首页最近笔记使用摘要分页，打开笔记时按 ID 读取当前内容。启动与部分全局页面暂时仍使用全量状态；这次优化不等同于整应用按需加载。若保存时发现其他窗口修订，当前记录先安全合并，随后请求全量补齐，避免把未知远端变更当成已加载。

业务事务仅通过 `publishing::enqueue_on` 登记派生发布工作，文件 I/O 由后台执行。完整恢复、图片恢复及结构变化会请求完整投影。图片清理同时检查记录正文和历史，不能因为旧字段数组已移除而误删附件。

验证与基准只使用合成数据：

```sh
node --test scripts/record-save.test.cjs
node scripts/bench-record-save.cjs
cargo test --locked -p memokeep-storage --test records
cargo test --locked -p memokeep-storage --test records synthetic_record_storage_benchmark -- --ignored --nocapture
```

JS 基准运行实际保存协调器与桌面桥接，IPC 端点为内存夹具；报告往返载荷、克隆输入体积和五次保存中位数。Rust 基准分别在两个临时 SQLite 库测量快照与记录保存。两者不能直接当作完整 GUI 或扩展领域计算的端到端延迟。
