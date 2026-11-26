---
name: firmware-change
description: 为软件工程师固件工单生成 C 或 H 候选源文件，以及宿主的编译验证约定。
---

# 固件修改作业规范

## 软件工程师

- 工单必须指定项目内现有的 `.c` 或 `.h` 文件。应用路径包括 `firmware/app/`、`firmware/ble/app/` 和 `T23/projects/<board>/ble/app/`。
- 根据工单全文和目标文件原文生成完整候选源码。保留与需求无关的函数、注释和格式，遵循已有 C 方言与编译约束。
- 使用原文或工单已确认的接口、宏和协议字段。缺少完成变更所需的信息时，返回 `BLOCKED: <缺少的信息>`。
- 源码正文从第一行开始输出。SDK、CMSIS、中间件、Bootloader、Keil 工程和构建产物由项目维护者管理。

## T23 工程约定

- T23 工单中的 BLE 配对指毫米波雷达绑定窗口，使用 `0x88/0x01` 协议。
- 按键处理入口是 `key.c` 的 `KEYService()`。配对入口是 `ble_recv.c` 的 `Mmw_PairStart()`。
- 按键双击配置见 `app_user_config.h` 中的 `KEY_DOUBLE_CLICK_PAIR_EN` 和 `KEY_DOUBLE_GAP_MS`。

## 宿主验证

- 宿主检查候选范围及完整性，并将原文保存在状态目录的 `codegen/` 下。
- 项目维护者在 `integrations.firmware.build` 中提供编译程序、参数数组和项目内工作目录。宿主一次验证本工单全部候选，成功后才登记资产或进行 Git 提交。
- 缺少编译配置、候选生成失败或编译失败时，工单进入阻塞状态。编译前已替换的源文件由宿主恢复。
