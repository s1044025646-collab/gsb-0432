# G-code 平面圆弧与模态坐标解释后端

离线二维刀路解释服务：把受限 G-code 文本中的直线与圆弧指令还原为明确的几何运动段（起点、终点、圆心、方向、扫角、长度），提供 HTTP API 与 CLI，使用 SQLite 持久化。纯本地运行，不连接机床、不发送控制信号、不判断加工安全，不做三维仿真、速度规划或刀具补偿。

## 环境要求

- Windows 本地，Node.js >= 22（使用内置 node:sqlite，无需原生编译、Docker、WSL 或任何外部服务）
- 开发依赖仅 typescript / tsx / @types/node

## 快速开始

    npm install
    npm run build     # 编译 TypeScript 到 dist/
    npm test          # 运行全部测试（node:test）
    npm run demo      # 演示：G3 四分之一圆 vs G2 四分之三圆、非法行拒绝
    npm start         # 启动 API 服务（默认自动选择空闲端口）
    node dist/cli.js serve 8080   # 指定端口

## 支持的语法子集

- 运动：G0 G1（直线）、G2（顺时针圆弧）、G3（逆时针圆弧）
- 坐标模式：G90（绝对）、G91（增量）
- 字：X Y（目标坐标，毫米）、I J（圆心相对本段起点的偏移）
- 普通空白、大小写字母、分号后的行尾注释；空行与纯注释行无动作
- 数值支持整数、小数、科学计数法，必须有限且在 ±1e6 内

明确不支持（返回错误而非忽略）：Z R F M S T N（行号）等其它字母、G0/G1/G2/G3/G90/G91 以外的 G 指令、宏、变量、括号注释、程序跳转。

## 坐标与模态约定

- 仅 XY 平面，单位毫米；初始状态：原点 (0,0)、绝对模式 G90、运动模式 G0
- G90/G91 控制本行及后续 X/Y 的意义，坐标模式对本行先生效；省略的轴保持原位
- I/J 始终为从本段起点到圆心的偏移，不受 G90/G91 影响，省略视为 0
- 只给坐标不给运动 G 字时沿用上一运动模式；单独的模式指令不生成运动段、不重置位置
- 每行至多一个运动代码和一个坐标模式代码；同一字母重复赋值拒绝
- 圆弧扫角由起终点相对圆心的角度沿指定方向（G2 顺 / G3 逆）确定，不取短弧；起终点相同且圆心有效时按整圆（2π）处理
- 半径一致性容差：绝对 1e-6、相对 1e-6（取较大者），容差版本 1.0.0 随报告入库
- 零半径、无有效圆心（I=J=0）、半径不一致均明确拒绝；弧长 = 半径 x 扫角，直线长 = 两点距离

## 错误码

E_PARSE 无法解析 | E_DUPLICATE_WORD 重复字 | E_UNSUPPORTED_LETTER 不支持的字母 | E_UNSUPPORTED_G 不支持的 G 指令 | E_MULTIPLE_MOTION / E_MULTIPLE_DISTANCE_MODE 一行多个运动/模式代码 | E_NON_FINITE 非有限数值 | E_VALUE_RANGE 超出数值范围 | E_LINE_LIMIT 超行数上限 | E_ARC_NO_CENTER 无有效圆心 | E_ARC_ZERO_RADIUS 零半径 | E_ARC_RADIUS_MISMATCH 半径不一致 | E_NOT_FOUND | E_BAD_REQUEST

诊断包含具体行号与原始字。任何一行非法：分析返回诊断（HTTP 422），报告状态记为 error，不保存任何运动段，不会混入上次成功的结果。

## 限制配置（src/config.ts）

行数上限 10000、数值范围 ±1e6、分页上限 500（默认 100）、数据目录 data/（可用环境变量 GCODE_DATA_DIR 覆盖）。

## CLI

    node dist/cli.js import <file> [name]         # 导入程序（创建程序与版本1）
    node dist/cli.js version <programId> <file>   # 修改程序另建新版本
    node dist/cli.js validate <file>              # 校验
    node dist/cli.js interpret <file>             # 解释全部运动段
    node dist/cli.js analyze <versionId>          # 解释并保存报告
    node dist/cli.js modal <file> [line]          # 按行查看前后模态状态
    node dist/cli.js length <versionId>           # 查询总长度
    node dist/cli.js export <versionId> [page] [limit]  # 分页导出段列表
    node dist/cli.js history [programId]          # 程序/版本历史
    node dist/cli.js serve [port]                 # 启动 API（默认空闲端口）
    node dist/cli.js demo                         # 演示

## HTTP API

- POST   /programs                        导入 {name, source}
- GET    /programs                        程序历史
- POST   /programs/:id/versions           另建版本 {source}
- GET    /programs/:id/versions           版本列表（含报告状态与总长）
- POST   /versions/:id/analyze            解释并保存报告（非法则 422 仅存诊断）
- POST   /versions/:id/validate           只校验不落库
- GET    /versions/:id/report             读取报告
- GET    /versions/:id/segments?page=&limit=  分页导出段列表
- GET    /versions/:id/length             总长度
- GET    /versions/:id/modal?line=N       按行查看前后模态
- GET    /versions/:id/source             读取原始来源与约定

## 数据库

SQLite 存于 data/gcode.db，表：programs、versions（原始文本、初始约定、容差版本）、reports（状态、诊断、总长）、segments（完整几何段）。修改程序另建版本，历史版本可重启后完整读取。

## 演示示例

    G1 X1 Y0        ; 移动到 (1,0)
    G3 X0 Y1 I-1 J0 ; 以原点为圆心的四分之一圆，弧长 π/2 ≈ 1.5708

将 G3 改为 G2 后扫角为 3π/2（四分之三圆），弧长 ≈ 4.7124。见 examples/ 与 npm run demo。

## 限制

- 仅解释几何，不评估加工安全；不实现 R 形式圆弧、螺旋、刀具补偿、坐标系变换（G54 等）
- node:sqlite 在 Node 25 仍标记 experimental（启动时有警告），功能稳定可用
