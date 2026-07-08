# SightRead 设计文档

> 日期：2026-07-07
> 前置：定位与功能取舍见 [discussion.md](./discussion.md)、[features.md](./features.md)
> 本文记录经三轮讨论收敛后的**当前版本**设计，是实现的直接依据。

## 一、总原则

1. **100% 本地静态**：无 LLM、无网络依赖，一切毫秒级响应。
2. **标注是短命的**：服务于当前这轮阅读，过期即弃。宁可误删，不留脏。不做导出、分享、过期检测。
3. **语义正交**：五个功能各占一条轴——结构（段落化）、注意力（聚光灯）、数据流（变量染色）、判断（荧光笔）、细节层级（骨架折叠）。
4. **渲染冲突集中治理**：所有装饰经由唯一的渲染协调器（compositor）下发，任何功能不得直接调 `setDecorations`。

## 二、视觉通道独占表

| 通道 | 归属 |
|------|------|
| 背景填充（isWholeLine） | 荧光笔 |
| 描边 / 边框 | 变量染色（读一色、写一色） |
| 文字 opacity | 聚光灯置灰（两档灰度） |
| 行尾 `after` 标签 | 荧光笔说明文字 |
| gutter 图标 + overview ruler | 荧光笔 |
| 折叠 | 骨架折叠（纯命令，不注册 provider） |
| Outline / Sticky Scroll | 段落（实验性，默认关闭） |

图层（持久，可共存）：荧光笔。
模式（瞬时）：聚光灯（唯一模式，三档）。模式激活时压制图层：置灰区内的荧光笔标记由 compositor 降为低透明度变体，退出恢复。
变量染色是常开的瞬时效果（描边系），不与填充冲突，同时兼任聚光灯三档的焦点输入。

## 三、功能规格

### 3.1 骨架折叠

- `sightread.foldSkeleton`：折叠行优先取**语言折叠 provider 的真实区间**（`vscode.executeFoldingRangeProvider`，运行时探测，不可用则退回段落树的启发式 `headerLines`），过滤为"完全落在函数体内"的区（以 `extractBody` 的函数体起始行为界，排除签名、装饰器、函数自身的区），一次 `editor.fold { levels: 1, selectionLines }` 折叠。
- `sightread.unfoldSkeleton`：先对函数体内一行做 `editor.unfold { direction: 'up', levels: 32 }` 展开被折叠的祖先链（method/class 被误折时，只展开内部区在屏幕上毫无变化），再对同组行展开内部区。
- **两个教训**（2026-07-07 两轮修复）：① `editor.fold` 不带 `levels`/`direction` 时走"已折叠则折其父区"的交互路径（`setCollapseStateUp`），候选行与语言折叠模型稍有不一致就会波及 method 乃至整个 class——程序化折叠必须显式传 `levels: 1`；② 启发式头行和语言折叠区不保证一致，能拿到 provider 真实区间就用真实区间。
- 不注册 FoldingRangeProvider，复用语言自带折叠区间。零冲突表面。
- **与 Segments 树联动**（2026-07-07）：树节点折叠/展开 → 对应代码区折叠/展开（`editor.fold/unfold` + `selectionLines`）；Segments 标题栏的 fold/unfold 按钮双向同步（fold 折代码并收起整棵树，unfold 反之）。反方向（编辑器里手动点折叠箭头 → 树收起）做不了：平台没有代码折叠变化的公开事件。

### 3.2 荧光笔（marker）

- 数据：`{ id, color, note?, startLine, endLine }`，**行粒度**，持久化于 `workspaceState`（不进 repo、不建文件）。
- 调色板：yellow（重点）/ red（存疑）/ green（已验证）/ blue / purple。
- 说明文字：默认渲染在标记区**首行行尾**（`after` 装饰）；`sightread.marker.notePosition = lineStart` 可切到行首（`before` 装饰，会把该行代码右移）。平台不允许行间插入视觉行。
- 同色/异色标记**不允许重叠**：新标记吞掉与之相交的旧标记（replace-on-intersect），防止背景叠加成泥。
- 删除双保险：
  - **自动**：任何编辑与标记行范围相交 → 标记删除；其余编辑只做行号平移。
  - **手动批量**：删除选区内 / 当前函数内 / 当前文件内 / 全 workspace（带确认）。
- 侧边栏 **Markers 视图**：按文件分组列出全部标记（创建时快照的首行文本 + 说明 + 行号），点击跳转，行内垃圾桶单删；标题栏带三个快捷涂色按钮（★ 黄 / ? 红 / ✓ 绿）+ 选色涂色 + 溢出菜单一键全删。

### 3.3 变量染色（variable tint）

- 自动、瞬时：光标落在 identifier 上（防抖后）→ 该 symbol 在**当前函数内**的所有 occurrence 描边显示；读 = 蓝色实线框，写 = 橙色框加粗。光标移开即消退。
- occurrence 来源：`vscode.executeDocumentHighlights`（自带读写区分）；无 provider 的语言退化为函数范围内的词边界文本匹配。
- 与荧光笔的对偶：自动 vs 手动、瞬时 vs 持久、推断范围 vs 选定范围、描边 vs 填充。

### 3.4 自动切段（segmentation）

- 唯一来源是自动（手动划段因"划完即读完"悖论被废弃）。信号三个：
  1. **空行**分隔；
  2. **顶层块**（if/else、循环、try/catch、内部闭包——由缩进回落 + 续行关键字识别，语言无关）自成一段，块长 < 3 行的并入邻段；
  3. **注释/装饰器行绑定下一段**。
- **递归树结构**（2026-07-07 第二版）：块段落的内部（更深缩进的每一段连续区）递归切段成子节点，根即函数，深度上限 5。call/assignment/flow 类段落不向下递归（多行调用的参数不是结构）。
- **结构化命名**，注释内容永不作为段落名：
  - 分支：`if ...` / `if ... else ...` / `if ... elif{3} ... else ...`（关键字取语言实际所用，如 JS 的 `else if`）
  - 循环 `for ...`/`while ...`，上下文 `with ...`，异常 `try ... except ... finally ...`，分派 `switch ...`/`match ...`
  - 定义：`def foo` / `class Bar` / `function baz`（语言关键字 + 名字）
  - 赋值段：`a=.. b=.. c=..`（最多 4 个 token，超出加 `…`）
  - 调用段：`shutil.rmtree(...)`，无参写 `path.unlink()`
  - 流控制：`return ...` / `raise ...`
  - 均无法识别时退化为首行代码文本（截断 60 字符）。
- 垃圾代码退化为"整个函数一段"，无害。
- 纯函数实现（`core/segmentation.ts`），按文档版本缓存。
- 消费方：聚光灯二/三档、`Go to Segment` QuickPick、侧边栏 **Segments 视图**（随光标显示当前函数的段落树，按 kind 显示彩色图标：branch=黄/loop=绿/try=红/definition=紫/assignment=橙/call=蓝；不显示行号）。
- ~~Outline 注入~~（**已实证失败，2026-07-07**）：provider 内调 `executeDocumentSymbolProvider` 会与 VS Code OutlineModel 的 in-flight 请求合并机制形成循环等待，Outline 永远 loading。"既消费又提供符号"结构性走不通，按预留退路改为侧边栏 TreeView。

### 3.5 聚光灯（spotlight）

三档退化阶梯，每档只比上一档多一个数据依赖：

| 档 | 焦点集合 | 依赖 |
|----|---------|------|
| 1 Function | 当前函数；函数外重灰 | DocumentSymbol |
| 2 Segment | 基于段落树的四档着色（见下） | + 自动切段 |
| 3 Segment+Var | 二档 ∪ 当前 symbol occurrence 所在的最深节点 | + 变量染色 |

**四档着色**（2026-07-07 第二版，随段落树递归化引入）——光标落在树的某个节点上时：

| 亮度 | 范围 | opacity 设置 |
|------|------|--------------|
| 最淡 | 函数外部 | `functionDimOpacity` (0.15) |
| 次淡 | 函数内非祖先、非兄弟的部分 | `segmentDimOpacity` (0.4) |
| 再次 | 光标节点的兄弟节点 | `siblingDimOpacity` (0.6) |
| 最浓 | 自己 + 全部子孙 + 相关节点（occurrence 所在最深节点）+ 祖先首行与函数首行（上下文锚） | 1.0 |

- 切段失灵（无段落/光标在段落间隙）→ 自动退化为一档行为。
- 光标驱动 + 防抖（~120ms）；焦点抖动的保持策略留待原型体感调参。
- 入口在 **Segments 视图标题栏的 👁 按钮**（点击循环档位；自定义 view container 本身没有标题按钮贡献点，视图标题栏是最近的位置）；当前档位以**数字角标**显示在活动栏的 SightRead 图标上（0 档无角标）。状态栏项已移除（2026-07-07）。
- `sightread.spotlight.defaultLevel`：启动时应用的默认档位（0–3，默认 0）。

## 四、架构

```
src/
  core/            纯逻辑，零 vscode 依赖，单元测试覆盖
    segmentation.ts   切段算法 + 函数体提取
    markers.ts        荧光笔数据操作（编辑平移/相交删除/替换插入）
    focus.ts          焦点集合计算、行区间代数（merge/subtract/contain）
  vs/              平台层
    compositor.ts     唯一渲染出口：装饰类型注册 + 图层/模式合成
    symbols.ts        最内层函数查找（executeDocumentSymbolProvider）
    segmentCache.ts   按文档版本缓存的切段结果
    highlighter.ts    荧光笔命令 + workspaceState 持久化 + 编辑跟踪
    variableTint.ts   occurrence 获取与降级
    spotlight.ts      档位状态 + 焦点计算 + 状态栏
    skeletonFold.ts   折叠命令对
    segmentOutline.ts Go to Segment + 实验性 DocumentSymbolProvider
  extension.ts     事件接线：统一的光标管线（防抖 + 过期令牌），文档变更分发
```

统一光标管线：`selection 变化 → 找函数 → 算 tint → 算段落 → 算焦点 → compositor.render`。中途文档/光标再变则丢弃（令牌失效）。

存储只有一个：荧光笔库（workspaceState）。段落是带缓存的现算，变量染色和折叠零存储。

## 五、已知风险与待实证项

1. **切段质量**跟随代码质量——设计上已接受，垃圾代码退化无害。启发式参数（块长阈值等）待真实代码调参。
2. ~~Outline 注入的 provider 合并行为~~——已实证失败并移除（死锁，见 §3.4），段落与荧光笔列表由侧边栏视图承载。
3. **聚光灯三档的焦点抖动**——v1 只做防抖，保持策略待体感。
4. **函数体提取**对非常规签名（多行签名、装饰器）是启发式，接受误差。
