# CLI Hardening Tasks

- [x] 1. store：Keyring.actualPorts 字段（zod default 兼容）+ setActualPorts
      （整体替换 + 修剪）+ applyCatalog/mergeImportView/join 携带
- [x] 2. runtime：startEngine 监听物化后回写实际端口（失败 NOTICE 不阻断）
- [x] 3. 消费侧解析：ai-fly test actualPorts > pin > defaultPort；ports 命令
      LIVE 错开标注
- [x] 4. bug：secret set 尊重 --data（原硬编码默认目录；单测首轮抓出）
- [x] 5. 单测：daemon-state / proxy / settings+relay / secret / service 路由
      参数 / actual-ports（store+引擎+test 解析）/ daemon --detach 进程级回路
      ——新增 7 文件 28 例，全量 522 绿
- [x] 6. 回归：vitest 522/522、tsc 绿、svelte-check 回落基线（2 存量错）
- [x] 7. 发布：0.3.1-alpha.1（CI 假红：Linux 无 SDK 原生模块，detach 集成
      按平台门控）→ alpha.1 实测暴露 AUTH_OK 覆写 actualPorts（构造期内存
      快照整体落盘）→ 修复 + 回归锚点 → 0.3.1-alpha.2 发布产物复演通过
      （ports LIVE 标注 + test 命中错开端口 55888 + DeepSeek 真实 401）
