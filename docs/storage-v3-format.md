# 桌面存储 v3 格式与恢复契约

历史 JSON v3 规范，现仅用于旧格式兼容和[恢复夹具](../scripts/fixtures/storage-v3/recovery.json)，不再作为当前桌面正本的落地计划。当前桌面正本为 `crates/memokeep-storage` 的 SQLite，Markdown 和按模块 JSON 为导出副本。应用数据模型仍是版本 2，磁盘格式版本是 3，两者分别演进。

## 文件与数据映射

正本文本采用严格 UTF-8，无 BOM。JSON 对象的键唯一，数字按有限 IEEE 754 binary64 解释。代次、大小、行号及其他结构计数使用不超过 `9007199254740991` 的非负整数。非法 JSON、超范围结构值和不可识别格式进入保护状态。JSONL 每行一个紧凑 JSON 对象，以 LF 结束，包括最后一行。SHA-256 以小写十六进制表示，输入是文件的实际字节，包括空白及换行。读取器按字节验哈希，再解析内容。写入时无需重写字节不变的文件。

| 数据 | v3 路径或布局 |
| --- | --- |
| `knowledgeBases`、`noteTags`、`items` | `library/knowledge-bases.json`、`library/tags.json`、`library/items.json`，分别保存数组 |
| `documents` | `library/notes/<知识库键>/<笔记键>.json`，每文件一个对象 |
| `cards` | `cards/groups/<知识库键>.json`，每组一个数组 |
| `cardDocuments`、`cardFolders`、`cardNotebooks` | `cards/card-documents.json`、`cards/card-folders.json`、`cards/card-notebooks.json`，分别保存数组 |
| `reviewRecords`、`focusSessions` | `cards/reviews/<月份>.jsonl`、`planner/focus/<月份>.jsonl`。使用 `reviewedAt` 和 `endedAt` 的 UTC 月份作为物理分片，不能据分片推算工作空间日历。无明确时区的时间字符串和无法归月的旧记录放 `undated.jsonl`，保留原值 |
| `plans`、`memos` | `planner/plans.json`、`planner/memos.json`，分别保存数组 |
| `settings`、`streak`、其余可移植顶层字段 | `profile/preferences.json`、`profile/stats.json`、`profile/extra.json`。最后一项保存剩余键及原始 JSON 值 |
| `trash` | `trash/<记录键>.json`，每文件一个对象 |
| 图片和历史图片 | `attachments/images/`、`attachments/history/`，原始二进制及解析所需的附件标识保存于清单 |
| 扩展内容 | 已注册扩展可描述独立集合和二进制附件。核心处理通用清单与完整性，扩展自身维护其 schema。未识别的必需扩展返回 `UNSUPPORTED_EXTENSION`，禁止写入 |

路径键采用 `sha256(UTF-8(JSON.stringify(id)))`。无知识库归属的分组使用 `unassigned`。路径键只用于存放位置，原始 ID 永远保存在数据内。重复 ID、缺失 ID 或无法拆分的旧集合使用 `profile/compat/<集合键>.json` 保留原始数组并标记 `json` 布局，不能在迁移中去重或补发新 ID。集合键按同一规则编码。写入器必须检查路径重复及覆盖歧义，即使它们由哈希产生。迁移核对原始业务对象的字段、数组顺序、`null` 与缺省区别。当前宿主的界面归一化应在重组之后执行。

宿主位置、授权引用、窗口状态、凭据与设备运行状态留在应用目录，不进可移植数据。阶段 B 需列出宿主字段及现有扩展的映射和还原规则。已知宿主字段不能落入 `extra.json`，无法确认归属的旧字段须保留原始来源并在迁移预览中说明。核心以稳定附件 ID 解析文件，不将绝对路径写回正文。

## 索引

根目录 `memokeep.json` 固定包含 `format: "memokeep-store"`、`version: 3`、`workspaceId`、`generation`、`lastCommitId`、`collections`、`files`。初始代次为 0，`lastCommitId` 为 `null`。每次有业务或扩展事实的提交将代次增加 1，记录该次 `commitId`。

- `collections` 的键是集合名。`{layout:"json",path}` 指向一个 `kind: "json"` 的文件，读取结果是该集合原值。`{layout:"rows",order:[[path,row],...]}` 重建拆分数组。`row` 从 0 开始，单对象文件只允许 0，数组文件和 JSONL 采用对应元素或行号。一个业务文件只属于一个集合，拆分文件中的每一行只可被引用一次，且所有行都须被引用。空拆分数组保存为 `order:[]`。路径、布局、类型与行号必须相符。
- `files` 的键是根目录相对路径，值包含 `generation`、`size`、`sha256`、`kind`。`kind` 为 `json`、`jsonl` 或 `asset`。可选 `attachmentId` 与 `mediaType` 绑定资产引用。文件代次不得超过索引代次，未变更的文件保留原代次。索引本身不递归列入 `files`。`profile/extra.json` 用保留的索引集合名 `extra` 登记，重组时展开为剩余顶层字段，拒绝覆盖其他集合对应的业务字段。原始业务对象中名为 `extra` 的字段仍可存于该文件。
- 可选 `requiredExtensions` 为唯一的扩展标识数组。数据目录间移动保留 `workspaceId`，实际根身份仍由宿主指针校验。扩展字段和未识别的可选元数据按原 JSON 值保留。
- 路径采用 `/` 分段，规范 writer 使用 ASCII 小写文件名。拒绝绝对路径、`.`、`..`、空段、反斜杠、Windows 设备名、大小写折叠冲突及符号链接逃逸。禁止索引指向 `export/`、`.memokeep/`、活动索引本身或根目录以外的位置。只读取登记文件。额外文件不参与重建，也不因未登记而被删除。

## 提交记录

单一写入者持有工作空间级平台锁。锁键绑定实际根身份，不能以拼写不同的路径绕过。锁文件内容供诊断，所有接入宿主必须实际互斥。缺少锁、原子替换或持久化保证的目标只能试读。网络共享目录、网盘多写和跨卷事务不在首批可写范围。阶段 B 在实际目标卷验证数据与目录入口刷盘；进程中止测试与断电持久化测试分别记录。苹果文档指出磁盘缓存可能重排写入，是否使用更强刷盘原语需按实际环境验证。 [Apple fsync 说明](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html)

`.memokeep/staging/<commitId>/` 包含 `manifest.json`、`base-index.json`、`target-index.json`、`payload/<最终相对路径>` 及决策发布后的 `COMMIT`。保存新旧两个索引的完整原始字节，供当前索引已切换后的重启验证。变更项记录完整文件描述符，新建时 `before` 为 `null`，删除时 `after` 为 `null`。以下为清单示例。

```json
{
  "format": "memokeep-commit",
  "version": 1,
  "workspaceId": "workspace-demo",
  "commitId": "commit-1",
  "baseGeneration": 0,
  "targetGeneration": 1,
  "baseIndexSha256": "<64 lowercase hex>",
  "targetIndexSha256": "<64 lowercase hex>",
  "changes": [{"path":"library/notes/demo/note.json","before":null,"after":{"generation":1,"size":42,"sha256":"<64 lowercase hex>","kind":"json"}}]
}
```

`COMMIT` 是 `{"commitId":"commit-1","manifestSha256":"<64 lowercase hex>"}`。宿主生成的 `commitId` 使用 1 至 128 个 ASCII 小写字母、数字或连字符，首位为字母或数字，作为路径段时也遵守设备名限制。清单的变化项必须唯一且与新旧索引文件描述符的差异对应。提交只允许在 base 到 target 的相邻代次切换。目标索引标记同一 `lastCommitId`。空间不足、校验失败和权限错误必须报告具体阶段。

1. 在独占门控下完成原状态恢复并核对 base 索引。每个工作空间仅允许一笔未退休的存储提交。若存在多个有效待恢复提交，保护并保留全部证据，由恢复工具查明来源。参与者持久化 prepare，由阶段 B 的通用事务上下文提供 `commitId` 及前后业务快照。业务投影和协议指纹由参与者计算。
2. 写入并校验清单、全部新增 payload 与新旧索引。按目标平台约定持久化文件及目录入口。正式文件保持 base。
3. 通过同目录临时文件原子发布 `COMMIT` 并持久化。有效标记是不可撤销决定。结果不确定时报告 `RECOVERY_REQUIRED`，保留证据直到重开确认磁盘状态。
4. 首先核对标记、清单和两份索引的原始哈希、工作空间、版本、代次、必需扩展和文件清单差异。当前索引必须匹配其中一份。若匹配 base，预检整批路径和可恢复字节。已经匹配 after 的目标（含已删除）可以跳过。其余目标须匹配 before，且对应的安装字节须匹配 after。校验未变更的文件。通过预检再落位，核对完整目标内容，并以根目录临时文件持久化替换 `memokeep.json`。若当前已匹配 target，校验完整目标快照。保留暂存索引至提交记录退休。落位期间不向外暴露混合代次。
5. 存储恢复后再恢复参与者。参与者退出必须可重试且绑定同一 `commitId`。全部完成并持久化后才可以发布窗口变化和成功 ACK。恢复过程不得产生第二条账本记录或把历史窗口通知重新当成新业务事实。
6. 确认完成后原子移动整个 journal 到 `.memokeep/garbage/<commitId>/` 并持久化两个父目录入口，再异步清理。垃圾目录不参与恢复。不能通过逐个删除活跃目录内的 COMMIT 或清单完成清理。退休结果不确定时暂缓下一笔写入。正常启动完成完整校验后开放业务／网络。

### 恢复判定

| 观察 | 恢复行为 |
| --- | --- |
| 无标记且确认仍为 base | 校验活动索引及其完整文件。确认没有已安装的候选证据后放弃暂存，并让参与者恢复未决 prepare |
| 无标记但候选已部分落位或已成为活动索引 | `RECOVERY_REQUIRED`，保留证据。活动索引即使自洽也不能据此撤销 prepare |
| 标记损坏、代次冲突、目标字节缺失或索引不符 | `RECOVERY_REQUIRED`，保留证据，阻止写入、同步及成功事件 |
| 有效标记且 base 尚可前滚 | 逐项验证并前滚，再完成参与者 |
| 有效标记且 target 已落位 | 核对 target，完成或确认已完成的参与者，安全清理 journal |
| 磁盘缺失、活动指针失效或所需扩展不可用 | 打开恢复入口，保留活动源身份，禁止把备用路径或空目录当作活动库 |

迁移候选以应用目录内的活动指针 `storage-location.json` 为准。v1 指针记录 `pointerVersion`、`workspaceId`、`format`（`legacy-json` 或 `folder-v3`）、`location`、宿主验证的 `rootIdentity`，以及可选的 `authorizationRef`。激活 v3 时另记录 `migrationId` 和激活时的 `generation`。此代次是诊断信息，当前代次由目标索引决定。迁移任何内容前，先持久化指向旧源的有效指针，为中断恢复提供明确的旧活动源。候选文件的存在不构成激活。

迁移时先停接请求、取锁、完成恢复和备份，再复制到候选目录，核对完整字段和附件字节。用户确认时，在独占门控下重新验证源指纹与候选目录身份、索引哈希和完整文件。候选及其目录入口持久化后，在应用目录原子替换并持久化活动指针。结果不确定时在重开后重新解析指针与验证相应目标。旧源继续保留。已激活目标不可读时进入保护。旧格式导出只还原兼容内容，跨设备历史另按协调恢复流程处理。

Markdown 是提交完成后的派生文件，默认位于 `export/`。外部编辑不作为输入。失败需记入独立待补写状态，重试从最新已提交代次派生。关闭持续发布时不再写副本。不能因导出失败回滚或重复应用业务提交。
