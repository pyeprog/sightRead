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
- **Segments item 右键深折叠**（2026-07-14）：`Fold/Unfold All Inside Segment` 折/展该段**内部**的全部折叠区（自身区排除——折掉自己就看不到正在检视的结构了）。区间来源与骨架折叠同构：优先语言折叠 provider（过滤为严格落在段内），退化为段落树 headerLines；unfold 先向上展开该段自身（骨架折叠的教训）。只作用于编辑器，树的展开态不动（单向同步的既有限制）。

### 3.2 荧光笔（marker）

- 数据：`{ id, color, note?, startLine, endLine }`，**行粒度**，持久化于 `workspaceState`（不进 repo、不建文件）。
- 调色板：yellow（重点）/ red（存疑）/ green（已验证）/ blue / purple。
- 说明文字：默认渲染在标记区**首行行尾**（`after` 装饰）；`sightread.marker.notePosition = lineStart` 可切到行首（`before` 装饰，会把该行代码右移）。平台不允许行间插入视觉行。
- 同色/异色标记**不允许重叠**：新标记吞掉与之相交的旧标记（replace-on-intersect），防止背景叠加成泥。
- 删除双保险：
  - **自动**：任何编辑与标记行范围相交 → 标记删除；其余编辑只做行号平移。
  - **手动批量**：删除选区内 / 当前函数内 / 当前文件内 / 全 workspace（带确认）。
- 侧边栏 **Markers 视图**：按文件分组列出全部标记（创建时快照的首行文本 + 说明 + 行号），点击跳转，行内垃圾桶单删；标题栏带三个快捷涂色按钮（★ 黄 / ? 红 / ✓ 绿）+ 选色涂色 + 溢出菜单一键全删。
- **视图跟随光标**（2026-07-14）：光标落在某标记行内 → Markers 视图选中该条目（`reveal({select, focus:false})`，segmentsView 同款；条目 id 稳定化以支持 reveal）。

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
- **Segments 视图随光标联动**（2026-07-09）：光标移动时 `TreeView.reveal` 选中光标所在最深段（`focus: false` 不抢焦点；树处于骨架折叠的收起态时跳过，避免 reveal 展开祖先并经 syncCodeFold 反向展开刚折叠的代码）。聚光灯开启时视图同步亮暗：lit 集合之外的段以 `FileDecorationProvider`（自定义 scheme `sightread-seg` 的 resourceUri）染 `list.deemphasizedForeground` 并置灰图标，光标段的 label 用 `TreeItemLabel.highlights` 强调——树条目无法比默认前景更亮，"点亮"只能靠压暗其余部分表达，与编辑器同构。
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
- 入口在 **Segments 视图标题栏的 👁 按钮**（点击循环档位；自定义 view container 本身没有标题按钮贡献点，视图标题栏是最近的位置）与**状态栏的 👁 项**（显示当前档位，点击循环）；当前档位以**数字角标**显示在活动栏的 SightRead 图标上（0 档无角标）。
- `sightread.spotlight.defaultMode`：启动时应用的默认档位（off / seg+var / seg / fn，默认 off）。

### 3.6 入口点（entry points，2026-07-09）

- **动机**（原 doc/inbox 想法）：列举出当前文件所有的"入口"——所有会 export 出去、被外界调用的函数/类/变量。先列举，之后直接顺着引用往下看，再做筛选——给阅读一个文件的路径指出一条明路：从入口开始读，而不是从第一行开始读。
- 侧边栏 **Entry Points 视图**：每个顶层符号按**引用位置**分类（`executeReferenceProvider`）：
  - 有文件外引用 → **入口**；
  - 有来自**其他符号 body 内**的同文件引用（wrapped）→ 隐藏——存在更抽象的包装者，读者应从包装者读起；
  - 只有来自**模块顶层代码**的同文件引用（script ref）→ **中性证据**：调用者是脚本本身，不是读者可以改从其读起的符号，故既不降级也不升级，落到语法提示/疑似入口路径（描述显示 "called at top level"）；
  - 找不到任何引用 → **疑似入口**，弱化显示（`activate` 这类框架钩子、路由 handler，或死代码），`sightread.entries.showSuspected` 可关。
- **发布行**不算调用：`export { … }` 子句、Python `__all__`、以及 Python `__main__` guard 块内的调用（`if __name__ == '__main__': main()` 是"向运行时发布入口"的语法，与 export 子句同族；按缩进向上找 guard，与 Go `main`/`init` 声明侧特例对称）——均记为声明公开证据，`main` 因此是正式入口（描述显示 "script entry"）。
- **语言语法提示**（`sightread.entries.languageHints`，默认开）细化"无引用"情形：`export`/`pub` 关键字、`export { … }` 子句、Python `__all__`、Go 大小写、前导下划线命名——声明公开的升为入口，声明私有的丢弃。
- **导入名永不是入口**（其引用属于原符号），除非文件刻意再发布（`export { x }`、`__all__`）——barrel 文件与 `__init__.py` 因此保有入口。
- 入口类懒展开、逐方法分类；`Go to Entry Point…` QuickPick；编辑器 gutter 雪佛龙（»）标注入口行（`sightread.entries.gutterIcons` 默认开，颜色 `sightread.entries.iconColor`，疑似入口降透明度）。
- 扫描只在视图可见或 gutter 图标开启时运行，按文档版本缓存，引用查询完成即流式补全结果。
- **视图跟随光标**（2026-07-14）：光标落在某入口符号范围内 → 视图选中该条目。刻意只 reveal 顶层符号、不下钻 member——reveal member 会展开容器并触发懒分类的引用查询，被动的光标移动不应引发主动扫描。

### 3.7 阅读轨迹（trail，2026-07-14）

- **动机**：现有功能都在单文件/单函数尺度辅助阅读，缺少函数与函数之间调用关系的表达。其他插件的做法是全量扫描（LLM 或 language server）生成外部文档 / WebView——慢、有成本、排版非标准化。Trail 反其道：**用户自然阅读，结构自然显现**——读者的 drill-in 与引用跳转本身就是调用结构的发现过程，走过的路即地图。
- **数据是图，视图是树投影**（`core/trail.ts`）。调用关系本质是 DAG 且可能有环，树状存储表达不了（Navigation History 的教训：模型与视图不分离，导致"调用方成为父节点"做不到）。节点 = 函数/方法/类/模块（script 顶层代码归模块节点），边 = "调用方 → 被调方"，边上存**已知最早**的 callsite 行。树投影每次渲染现算：被多个调用方调用的函数在每个调用方下都出现（镜像节点懒展开、共享子树），环沿祖先链截断为 ↻ 叶子；纯环成分无严格根时按创建序补根。ref-jump 发现调用方 ⇒ 被读函数自动不再是根——**re-root 是图的自然结果，无需特判**。子节点按 callsite 升序排列 = 被调方在父函数叙事中的出场顺序。
- **节点永远是落点的 enclosing symbol**，不是光标下的任意 symbol（Navigation History 的变量污染从源头消失）。`vs/symbols.ts` 在同一次 DocumentSymbol 查询里多算第三种语义 `at`：最内层符号、**头行算符号本身**（区别于聚光灯的头行让位），并携带 kind/名字范围/容器名。
- **边只由已验证的结构性跳转产生**（precision-first，`core/jumpClassify.ts`）：
  - **drill-in**：落点在某符号自己的名字上，且出发点的词 == 该符号名（去参数表，C 族符号名带参数表）→ 出发 scope 调用落点符号；
  - **ref-jump**：落点的词 == 刚读符号名，且不落在任何定义的名字上 → 落点 scope 调用该符号（调用方成为父节点）；
  - 识别的是**语义签名而非输入手势**：F12 / Cmd+Click / peek 选择 / 肉眼找到后点击，一视同仁；同一行内的移动永不算跳转；重复点击已在名字上的符号不算自调用，但从体内调用点跳到自己头上是递归；
  - 候选边须经**单次 definition provider 验证**才入图（drill-in 验出发词的定义确在落点符号；ref-jump 验落点词的定义确在刚读符号）——跳转刚用过 provider、缓存是热的，毫秒级。验证失败静默丢弃，宁缺毋滥。其余一切跳转（Ctrl+Tab、搜索结果、面包屑……）全部忽略；召回缺口由 `Pin Current Function to Trail` 显式命令兜底（并自动聚焦视图）。
  - **出发点在快手势下不会 settle**（2026-07-14 实测教训）：Cmd+Click、"点击调用词后立刻 F12"都在防抖窗口内连发两个 selection 事件，出发点的 settle 被防抖吞掉或被管线令牌作废——settled-pair 分类天生看不见它。两层修复：① settled 状态即使被管线作废也照喂 trail（对渲染是过期数据，对 trail 恰是出发点）；② trail 自持一条**原始光标轨迹**（每个 selection 事件同步记 uri/行/词，零查询，16 条环），settled 分类无果时回退：落地在符号名上 + 轨迹中最后一个不同行状态（3s 窗口内）的词等于该名 → 补解析出发点的 enclosing symbol（其文档必然还开着）→ 同样的 definition 验证 → 入图。ref-jump 不需要此回退：找引用的出发点是驻留状态（peek 打开与浏览的时间远超防抖），天然已 settle。
- **激活与生命周期**：
  - **仅视图可见时记录**（entriesView 的 watching 门控同款）；录制中 ⇔ 面板可见，面板即状态指示器，不设状态栏图标。
  - 规则的不可见靠两层消解：① `viewsWelcome` 空态文案在"打开面板发现是空的"这个惊奇现场解释规则；② 隐藏期只把 settled 状态推入**小环形缓冲**（12 条 / 3 分钟窗口，管线现成数据、零查询），视图打开时回放缓冲——"刚才那几跳"当场显形，也顺带桥接 visible 在切侧栏时的闪断。
  - 标题栏 ⏸/▶（context key `sightread.trailPaused`）与 🗑 清空；右键单删节点（连带只有它能到达的子孙；共享的、被 pin 的幸存）。
  - **纯内存、不持久化**（原则 2：标注是短命的），杜绝历史堆积；300 节点兜底上限，按**整树最近访问时间**驱逐、永不动最活跃的树。
- **重要性显示，无任何行为计数**——visitCount 被否决：settle 计数度量的是光标抖动习惯而非重要性，dwell time 同罪（午饭问题）。替代为两个无噪声来源：
  - 客观 = 图拓扑：发现入度 ≥2 的节点 description 显示 `↗ n callers`（跳转是刻意动作，抖动伪造不出边）；出度与探索深度由子树形状自然可见；
  - 主观 = 荧光笔联动：函数体内有 marker 的节点 label 染 marker 色（FileDecorationProvider，自定义 scheme `sightread-trail`，与 Segments 视图同构）——重要性由人判断、由图定位；不另设 pin/star 判断通道（语义正交：判断属于荧光笔）。
- **显示通道分配**（2026-07-14）：label = 从属 + 名字——方法显示为 `ClassName.method`（containerName 本就在节点身份 key 里，只是补上显示；嵌套函数显示为 `outer.inner`，同为真实从属）。从属是主要阅读信息（"当前函数调用了哪些**类**的方法"），占主通道且参与树的 type-to-filter。description 只留结构徽标（↻ 递归 / ↗ n callers），**不显示文件名**——位置是点击随手可达的信息，降级到 tooltip（`相对路径:行号` + called at line N）。label = 身份与从属、description = 图拓扑、tooltip = 位置，与通道独占原则同构。
- 光标 settle 在已有节点内 → touch + `reveal({select, focus:false})` 跟随；根排序按创建序倒序（新树在上），刻意**不**按访问时间排——阅读中实时重排会晃。
- 编辑漂移：节点 key 不含行号（uri + 容器名 + 名字），range 信息每次到访自愈；跨文件跳转落点符号未就绪（LS 冷启动）给 600ms 宽限再解析一次，仍无则按模块语义处理。
- v2 预留：右键节点按需 call-hierarchy 扩展（机器补的边用暗色区别于亲脚走过的边）；与 Entry Points 联动（从入口开始读时自动种根）。

## 四、架构

```
src/
  core/            纯逻辑，零 vscode 依赖，单元测试覆盖
    segmentation.ts   切段算法 + 函数体提取
    markers.ts        荧光笔数据操作（编辑平移/相交删除/替换插入）
    focus.ts          焦点集合计算、行区间代数（merge/subtract/contain）
    enclosing.ts      "当前函数"选择（显式命令取最内层 vs 聚光灯的头行让位）
    entries.ts        入口点分类（引用位置 + 语言语法提示）
    trail.ts          阅读轨迹图模型（节点/边/树投影/环覆盖/删除与驱逐）
    jumpClassify.ts   结构跳转分类（drill-in / ref-jump 的语义签名识别）
  vs/              平台层
    compositor.ts     唯一渲染出口：装饰类型注册 + 图层/模式合成
    symbols.ts        函数查找（executeDocumentSymbolProvider，两种语义见 core/enclosing）
    segmentCache.ts   按文档版本缓存的切段结果
    highlighter.ts    荧光笔命令 + workspaceState 持久化 + 编辑跟踪
    variableTint.ts   occurrence 获取与降级
    spotlight.ts      聚光灯档位状态 + 焦点计算入口
    skeletonFold.ts   折叠命令对
    segmentsView.ts   Segments 树视图（光标联动 + 亮暗镜像）+ Go to Segment
    markersView.ts    Markers 树视图（按文件分组，快捷涂色/删除）
    entriesView.ts    Entry Points 树视图 + gutter 图标 + Go to Entry Point
    trailView.ts      Trail 树视图（记录器 + LSP 验证 + 可见性门控 + 回放缓冲）
    palette.ts        荧光笔调色板与 gutter/树图标生成
  extension.ts     事件接线：统一的光标管线（防抖 + 过期令牌），文档变更分发
```

统一光标管线：`selection 变化 → 找函数 → 喂 trail/各视图 reveal → 算 tint → 算段落 → 算焦点 → compositor.render`。中途文档/光标再变则丢弃（令牌失效）。settled 状态是唯一数据源：trail 记录器与 Entry Points / Markers / Segments 三个视图的光标跟随都消费它。

存储只有一个：荧光笔库（workspaceState）。段落是带缓存的现算，变量染色和折叠零存储，阅读轨迹纯内存（关窗即弃）。

## 五、已知风险与待实证项

1. **切段质量**跟随代码质量——设计上已接受，垃圾代码退化无害。启发式参数（块长阈值等）待真实代码调参。
2. ~~Outline 注入的 provider 合并行为~~——已实证失败并移除（死锁，见 §3.4），段落与荧光笔列表由侧边栏视图承载。
3. **聚光灯三档的焦点抖动**——v1 只做防抖，保持策略待体感。
4. **函数体提取**对非常规签名（多行签名、装饰器）是启发式，接受误差。
