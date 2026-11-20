# 第三方软件声明

MemoKeep Community 使用以下开源组件。MemoKeep 的 MIT 许可证不替代第三方组件自身的许可证、版权声明或商标权利。

## 随源码提供的浏览器组件

| 组件 | 版本 | 用途 | 许可证与保留的声明 |
| --- | --- | --- | --- |
| Choices.js | 11.2.3 | 选择控件 | MIT；[完整声明](web/vendor/choices/LICENSE) |
| Quill | 2.0.3 | 富文本编辑 | BSD-3-Clause；[完整声明](web/vendor/quill/LICENSE)、[浏览器包声明](web/vendor/quill/quill.js.LICENSE.txt) |
| ts-fsrs | 5.4.2 | 间隔复习调度 | MIT；[完整声明](web/vendor/ts-fsrs/LICENSE) |
| Mermaid | 11.17.2 | 图表预览 | MIT；[完整声明](web/vendor/mermaid/LICENSE)、[来源](web/vendor/mermaid/README.md) |
| PrismJS | 1.30.0 | 代码高亮 | MIT；[完整声明](web/vendor/prism/LICENSE)、[来源及生成方式](web/vendor/prism/README.md) |
| Lucide | 随源码附带的图标 | 界面图标 | ISC；[完整声明](web/assets/icons/LUCIDE_LICENSE.txt) |

Mermaid 的浏览器文件保留了上游捆绑声明，包括 Lodash、DOMPurify、Cytoscape 内嵌代码等组件的声明。DOMPurify 的声明提供 Apache-2.0 或 MPL-2.0 许可选项。重新分发、压缩或重新生成这些文件时，请保留其内嵌许可证与版权声明。

Quill 的依赖还包括 Parchment（BSD-3-Clause）、quill-delta（MIT）、fast-diff（Apache-2.0）、EventEmitter3（MIT）与 Lodash（MIT）。这些依赖各自的原始许可文件随 npm 包提供；重新生成浏览器包时也应一并保留。

## npm 运行时依赖

以下版本取自 `package-lock.json`。其中部分组件同时以浏览器文件形式随源码提供。

| 包 | 锁定版本 | 许可证 |
| --- | --- | --- |
| `@mixmark-io/domino` | 2.2.0 | BSD-2-Clause |
| `choices.js` | 11.2.3 | MIT |
| `quill` | 2.0.3 | BSD-3-Clause |
| `ts-fsrs` | 5.4.2 | MIT |

安装后的各包目录中保留了原始 `LICENSE`、`NOTICE` 或同类文件。传递依赖的名称、版本及可用的许可证元数据见 `package-lock.json`；对应许可证全文以各包附带文件为准。

## 桌面运行与构建工具

| 组件 | 锁定版本 | 许可证 |
| --- | --- | --- |
| Tauri | 2.12.7 | MIT 或 Apache-2.0 |
| Wry | 0.57.3 | MIT 或 Apache-2.0 |
| esbuild | 0.28.2 | MIT |

Rust 依赖版本见 `Cargo.lock`，npm 依赖版本见相应锁文件。分发应用及重新生成浏览器文件时，保留各依赖所要求的许可证和版权声明。
