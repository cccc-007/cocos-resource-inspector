# 资源 / Prefab 体检

面向 **Cocos Creator 3.8.x** 的独立编辑器扩展。集中检查资源引用、Prefab / 场景的丢失引用和脚本，并在清理资源前查看静态影响范围。

## 安装

1. 解压 `release/cocos-resource-inspector.zip`。
2. 将其中的 `cocos-resource-inspector` 文件夹放到项目的 `extensions/` 下。也可以直接复制 `dist/cocos-resource-inspector`。
3. 在 Creator 的扩展管理器中刷新并启用插件，必要时重新打开项目。
4. 从菜单 **扩展 → 资源 / Prefab 体检** 打开面板，点击 **扫描项目**。

无需向 `assets` 添加脚本、挂载组件或配置服务器，也无需在安装后的插件目录运行 npm。

```text
项目/
  assets/
  extensions/
    cocos-resource-inspector/
      package.json
      main.js
      lib/
      panels/
      static/
      RIReports/       ← 导出报告时自动创建
```

## 功能

- **项目体检**：检查 Prefab / 场景等序列化资源中的丢失 UUID 引用、失效脚本 UUID、越界对象引用、JSON / meta 文件异常和重复 UUID。记录资源、节点路径、组件及属性位置。
- **引用定位**：搜索名称、路径或 UUID，查看“谁引用了它”和“它引用了谁”。支持压缩 UUID 与图片等资源的子资源 UUID。
- **删除影响预览**：展示直接引用者和间接影响资源；选择主资源时同时考虑其子资源。插件提供预览，不执行删除或自动修改。
- **资源大小统计**：统计源资源总大小、按类型的文件数及大小占比，列出严格大于 50 KB（51,200 字节）的全部源资源，按大小降序排列。面板每页显示 100 项，可翻页查看全部；HTML 报告完整列出。左侧资源列表支持按大小升序 / 降序排列，并显示单项大小。
- **未使用检测**：列出疑似未使用的图片、音频、Spine / DragonBones（含二进制）、动画剪辑、图集及其他二进制文件。按类型、状态和名称筛选，按源文件大小排序，可定位资源和查看引用；HTML / JSON 报告包含检测结果。
- **资源定位**：在 Creator 资源管理器中选中资源。节点定位需要先打开对应场景或 Prefab；使用节点 UUID、Prefab 文件标识及实例层级确定具体节点，兼容编辑器增加的 Scene / Canvas 包装层和 UUID 重建。Prefab 实例覆盖中的资源引用会定位到目标节点或组件所在节点；身份无法唯一确认时会提示手动确认。
- **HTML / JSON 报告**：导出到插件自己的 `RIReports/`。HTML 可离线浏览，JSON 保留本次扫描结果。
- **后台扫描**：使用独立工作线程，支持进度及取消；面板分页读取结果。资源发生变化时提示重新扫描。

## 推荐工作流

先保存场景和 Prefab，等待 Creator 导入资源结束，然后扫描。

在“体检问题”中先看错误，点击定位资源；打开对应资源后，按报告中的节点和属性检查引用。在左侧选择资源，切换“引用定位”查看上下游关系；准备清理资源时查看“删除影响”，再结合业务代码确认。

修改、移动或重新导入资源后重新扫描。扫描期间发生资源变化时，结果会标记需要更新。插件只读取已保存到磁盘的内容，不包含尚未保存的场景改动。

在“资源大小”页签查看类型汇总和大资源排行，点击“定位”可回到资源管理器。统计以 `assets/` 下源文件的磁盘字节为准，不含 `.meta`、目录、引擎内置资源、`library/` 或构建产物；图片的 Texture / SpriteFrame 等子资源不会重复计入。相同内容的不同文件分别计数。读取失败的文件标记为大小未知，扫描被截断时会提示结果不完整。这里显示的大小用于排查源资源体积，构建后包体、压缩后的下载大小和显存占用需要另行分析。

在“未使用检测”页签默认查看“疑似未使用”，优先检查体积较大的候选。所有已保存的场景、Prefab、脚本，以及图片 / 音频 / 动画之外的其他资源都作为保守入口；只要能沿可识别的依赖链到达，就视为有引用。即使某个 Prefab 没有被场景使用，它引用的资源也会保留，因此结果不等同于某次构建的可达资源清单。未被入口使用的动画及其图集、贴图可以一起成为候选；共享图片只要仍有使用链就会保留。图片同文件内的 Texture / SpriteFrame 元数据互引不算外部使用，子资源也不重复统计大小。

音频除了 UUID 引用，还扫描脚本和配置文本中的**完整文件名、去扩展名名称和路径**。例如 `playSound('click.mp3')`、`playSound('sfx/click')` 或配置值 `"sound": "click"` 都会产生 `audio-name` 引用，能在“查看引用”中找到来源文件和文本偏移 / 属性。支持 JS / TS、JSON、TXT、CSV / TSV、YAML、XML、INI、TOML 和 Lua。名称完整匹配，`hit` 不会因出现 `white` 而命中；同名音频无法唯一确认时全部保留，完整项目路径可以区分同名文件。注释、普通文本和变量名也会保守视为线索，不代表实际执行了播放；拼接名称、外部配置及运行时才确定的值仍需人工核实。

Spine 会补充骨骼文件到同名 `.atlas` / `.txt`（或 meta 明确引用的图集）、再到纹理页的路径依赖，支持多页图集。DragonBones 会识别图集 JSON 的 `imagePath`，并保守关联常见的 `_ske.json` / `_ske.dbbin` 与 `_tex.json` 导出组合；还支持 plist 图集的纹理路径。`.skel` / `.dbbin` 不作为 JSON 解码，依赖通过 meta 和配套图集确认。格式依据 [Creator Spine 资源说明](https://docs.cocos.com/creator/3.8/manual/zh/asset/spine.html) 与 [DragonBones 资源说明](https://docs.cocos.com/creator/3.8/manual/zh/asset/dragonbones.html)。

`resources` 目录、meta 中标记 `isBundle` 的目录及其依赖在没有静态使用链时归入“动态加载待确认”。引用扫描达到上限、取消、读取失败或动画配套路径无法解析时，未发现使用链的资源归入“扫描不完整待确认”，不计入疑似未使用。缺失 meta 或重复 UUID 的资源也需要先确认身份。插件只提供检查与定位，不自动删除文件。

## 覆盖范围与限制

本插件分析磁盘上的 `assets/`、`.meta` 和可识别的序列化资源，同时利用编辑器资源数据库识别内置资源及子资源。

- **没有查到引用不等于可安全删除**。代码中的动态加载、拼接路径、配置表间接引用、远程资源、自定义导入器依赖不一定能通过静态扫描识别。
- UUID 对应的脚本文件存在，也不代表脚本一定能编译、注册或执行。非 UUID 的自定义类名不用于判断脚本丢失，需要通过 Creator 的编译及运行检查确认。
- 空属性可能是可选配置，插件不会把所有 `null` 都判为丢失引用。
- 资源数据库不可用时退回磁盘扫描，并在结果中提示覆盖限制。
- 脚本的 `import` 关系、二进制模型、自定义二进制格式的内部依赖、非常规 Spine / DragonBones 图集组织、未保存的改动及运行时对象不在完整扫描保证范围内。其他 `.bin` / `.bytes` 可以检查可识别的外部引用，插件不会解码其内部格式。此版本不提供包体分析或自动修复。
- 扫描设置文件大小、引用数量和问题数量上限，达到上限会在结果中明确提示；HTML 的体检问题、静态引用和未使用资源列表每类最多展示 10,000 条，大于 50 KB 的源资源列表完整展示；JSON 保留本次扫描已记录的全部结果。

## 开发

开发和自动化测试使用 Node.js 18 或更高版本，无需安装第三方运行时依赖。安装后的插件使用 Creator 内置的 Node.js，兼容 Creator 3.8.3 的 Node.js 14.16。

```sh
npm test
npm run build
npm run package
npm run check:editor -- "D:\creator\Creator\3.8.3\CocosCreator.exe"
```

`build` 校验 JavaScript 语法并生成可安装目录 `dist/cocos-resource-inspector`；`package` 生成带正确顶层目录的 ZIP。

`check:editor` 在构建后使用指定 Creator 的内置 Node.js 校验安装包模块加载、工作线程扫描、引用查询及 HTML / JSON 导出，不打开编辑器窗口。

也可进行独立磁盘扫描：

```sh
npm run scan -- "D:\MyCocosProject" html
```

命令行模式没有 Creator 的资源数据库信息，会提示相应限制。报告仍保存在当前插件源码目录的 `RIReports/`。

扩展接入方式参考 [Cocos Creator 扩展接口](https://docs.cocos.com/creator/3.8/manual/zh/editor/extension/contributions.html) 和 [场景脚本](https://docs.cocos.com/creator/3.8/manual/zh/editor/extension/scene-script.html)。
