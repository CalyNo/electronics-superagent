---
name: firmware-change
description: T23 固件应用代码修改的安全边界与作业流程。当软件工程师（SW）岗位需要修改 firmware/ble/app 下的 C/H 源码、或需要编译验证 Keil 工程时使用。
---

# T23 固件修改作业规范（软件工程师 SW）

## 何时使用

- 收到形如「修改/新增 T23 固件代码……」的 code-change 工单；
- 需要在 `ble/app/src` 或 `ble/app/inc` 下改 `.c` / `.h` 文件；
- 需要编译验证改动是否通过。

## 项目路径

- 项目根：`D:/yoxi/superagent/projects/蓝牙接收控制器`
- 应用代码：`T23/projects/n32wb03x_EVAL/ble/app/`
- Keil 工程：`T23/projects/n32wb03x_EVAL/ble/app/MDK-ARM/T23.uvprojx`
- Keil 命令行：`/d/KEIL/UV4/UV4.exe`（Git Bash）或 `D:\KEIL\UV4\UV4.exe`

## 允许修改（白名单）

仅以下目录下的 `.c` / `.h`：

```
T23/projects/n32wb03x_EVAL/ble/app/src/
T23/projects/n32wb03x_EVAL/ble/app/inc/
```

## 禁止触碰

- SDK / 协议栈：`T23/middlewares/`、`ble_library/`
- CMSIS / 启动文件 / 芯片头文件
- bootloader：`ble/boot/`
- 构建产物：`MDK-ARM/Objects/`、`MDK-ARM/Listings/`、`*.o` `*.axf` `*.map`
- 策略与配置：`.superagent/policy.yml`、`manifest.json`

越过白名单的修改会被 superagent 拒绝登记，不会进入工单资产。

## 作业流程

1. **读**：读取目标文件全文，定位要改的函数/宏。
2. **改**：最小改动，保留现有风格与无关代码。新增功能优先用配置宏包一层（如 `XXX_EN`），默认可关闭。
3. **输出**：给出**完整文件内容**，不要只给 diff 或片段。宿主会把全文写回并先备份到 `.state/codegen/`。
4. **编译验证**：
   ```bash
   cd "D:/yoxi/superagent/projects/蓝牙接收控制器/T23/projects/n32wb03x_EVAL/ble/app/MDK-ARM"
   "/d/KEIL/UV4/UV4.exe" -j0 -b "T23.uvprojx" -o "build.log"
   grep -E "Error|Warning" build.log | tail -20
   ```
   目标：**0 Error、0 Warning**。有错误就修，不要提交编译不过的代码。
5. **提交**：由 superagent 引擎统一 git 提交；不要自行 commit，避免与工单记录脱节。

## 已知约定

- 「BLE 配对」在本项目特指**毫米波雷达绑定窗口**（0x88/0x01 协议），不是 BLE 从设备配对。
- 按键触发入口：`key.c` 的 `KEYService()`；配对入口：`ble_recv.c` 的 `Mmw_PairStart()`。
- 双击判定阈值：`KEY_DOUBLE_CLICK_PAIR_EN` / `KEY_DOUBLE_GAP_MS`（见 `app_user_config.h`）。

## 失败处理

- 无法确定如何安全实现时：**不要修改文件**，返回明确说明；宿主会保持文件原样并回退工单为 blocked。
- 输出疑似截断、含占位符、或长度不足原文 60% 时，宿主会拒绝写入。
