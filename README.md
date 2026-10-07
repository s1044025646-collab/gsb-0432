# G-code 平面圆弧与模态坐标解释后端

离线二维刀路解释服务：把受限 G-code 文本中的直线与圆弧指令还原为明确的几何运动段（起点、终点、圆心、方向、扫角、长度），提供 HTTP API 与 CLI，使用 SQLite 持久化。纯 TypeScript + Node.js，Windows 本地运行，不依赖 Docker / WSL / 外部服务。

**明确不做**：不连接机床、不发送控制信号、不判断真实加工安全；不做三维仿真、速度规划、刀具补偿。

## 环境要求

- Node.js >= 22.5（使用内置 node:sqlite，无需原生编译依赖）
- 仅开发依赖：typescript、@types/node

## 快速开始

    npm install
    npm run build     # 编译到 dist/
    npm test          # 编译并运行全部测试
    npm start         # 启动 HTTP 服务（默认端口 0 = 自动选空闲端口，控制台打印实际端口）
    npm run demo      # 内置演示（四分之一圆 / 四分之三圆 / 版本比较 / 非法行拒绝）

CLI（node dist/cli.js <命令>，数据库默认在项目内 data/gcode.db，可用 --db 覆盖）：

- serve [--port N]              启动 HTTP API（默认自动选空闲端口）
- import <file> [--name N]      导入程序文件并分析，存为新程序
- validate <file>               仅校验，不写库；失败退出码 1
- report <versionId>            查看完整几何报告（含原始来源与约定）
- modal <versionId> --line N    查看某行前后模态状态
- length <versionId>            查询总长度（mm）
- export <versionId> [--out f] [--format csv]   导出段列表（默认 JSON）
- list / versions <programId>   读取历史 / 版本比较
- demo                          内置演示

## 支持的语法子集（除此之外一律报错）

- 运动：G0、G1（直线），G2（顺时针圆弧）、G3（逆时针圆弧）
- 坐标模式：G90（绝对）、G91（增量）
- 字：X、Y（终点坐标，毫米），I、J（圆心偏移，毫米）
- 普通空白、大小写字母、分号后的行尾注释；空行与纯注释行无动作
- 数值支持整数、小数、科学计数法，必须有限且绝对值不超过 1e6

明确不支持（返回错误而非估算/忽略）：Z、R、F、M、S、T、除上述外的所有 G 字、宏、变量、括号注释、程序跳转、行号字。

## 坐标与模态约定

- 只解释 XY 平面毫米坐标；初始状态：原点 (0,0)、G90 绝对模式、G0
- G90/G91 控制本行及之后 X/Y 的绝对/增量意义；坐标模式先对本行生效
- 省略的坐标轴保持原位；只给坐标而省略运动 G 字时沿用上一运动模式
- 单独的模式指令（如一行只有 G91）不生成运动段、不重置位置
- I/J 始终表示从本段起点到圆心的偏移，不受 G90/G91 影响；省略视为 0
- 每行至多一个运动代码和一个坐标模式代码；同一字母（G 除外）重复赋值拒绝

## 圆弧几何规则

- G2 顺时针、G3 逆时针；由起终点相对圆心的角度沿指定方向确定扫角，不取较短弧
- 起终点相同且圆心有效时按完整一周处理（扫角 2π）
- 起终点到圆心半径须一致：|r0-r1| <= max(absTol, relTol * r均值)，默认 abs=1e-6、rel=1e-6（容差版本 1.0，随报告入库）
- 零半径、无有效圆心（I、J 均零或均省略）、半径不一致一律明确拒绝
- 弧长 = 半径 × 扫角；直线长 = 两点距离；每段记录来源行号与原始指令

## 错误码

解释层：LINE_LIMIT、PARSE_SYNTAX、EMPTY_WORD、DUPLICATE_WORD、UNSUPPORTED_WORD、UNSUPPORTED_G、MULTIPLE_MOTION、MULTIPLE_DISTANCE、NON_FINITE、VALUE_RANGE、ZERO_RADIUS、NO_CENTER、RADIUS_MISMATCH。
API 层：VALIDATION、NOT_FOUND、ANALYSIS_FAILED、INTERNAL。诊断定位到具体行号与字。

## 限制配置（src/gcode.ts 的 DEFAULT_LIMITS）

- maxLines = 10000（程序行数上限）
- maxAbsValue = 1e6（数值范围）
- maxPageSize = 500（输出分页上限）

## HTTP API

默认监听 127.0.0.1，端口 0 表示自动选空闲端口（node dist/server.js [port]）。

- POST /programs                  导入 {name, source}，自动分析，返回状态与诊断
- POST /programs/:id/versions     修改程序，另建新版本并分析
- POST /validate                  仅校验 {source}，不落库
- GET  /programs                  历史列表
- GET  /programs/:id              程序的版本列表（新旧比较）
- GET  /versions/:id/report       完整报告：原始来源、约定、容差版本、诊断、分页段列表（?page=&size=）
- GET  /versions/:id/segments     导出段列表（?format=csv 导出 CSV）
- GET  /versions/:id/modal?line=N 某行前后模态状态
- GET  /versions/:id/length       总长度（mm）
- GET  /health                    健康检查

## 持久化

SQLite（data/gcode.db）保存：程序、版本（原始文本、初始约定 JSON、容差版本）、分析报告（状态、诊断、总长度）、段列表、逐行模态。修改程序另建版本，历史可比较。存在非法行的程序只保存诊断，不保存段与总长度，不会污染此前成功版本的数据；重启后可读取原始来源与完整几何报告。

## 演示验证

    G1 X1 Y0
    G3 X0 Y1 I-1 J0    -> 圆心 (0,0)，CCW，扫角 90°，弧长 ≈ π/2 ≈ 1.570796
    G2 X0 Y1 I-1 J0    -> 同参数改 G2：CW，扫角 270°，弧长 ≈ 3π/2 ≈ 4.712389

测试覆盖：绝对/增量混用、运动模态继承、省略单轴、整圆、负坐标、半径不一致、重复字、不支持指令、坐标模式当行生效、注释与大小写、行数/数值上限、圆弧参数角度采样（半径/首尾/方向）、三四五直线、版本比较与重启后读取。

## 已知限制

- 仅 XY 平面、毫米；无 Z 轴、无 R 格式圆弧、无进给/主轴语义
- node:sqlite 在 Node 25 仍标记为实验性（启动时有 ExperimentalWarning，功能稳定可用）
- 段导出单次最多 maxPageSize 条，需分页拉取
