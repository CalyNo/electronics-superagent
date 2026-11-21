import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedCodePath } from '../src/executor/codegen.mjs';

const root = 'D:/yoxi/superagent/projects/蓝牙接收控制器';

test('固件代码白名单：只允许应用工程 app/ 下的 .c/.h', () => {
  assert.equal(isAllowedCodePath(root, 'T23/projects/n32wb03x_EVAL/ble/app/src/key.c'), true);
  assert.equal(isAllowedCodePath(root, 'T23/projects/n32wb03x_EVAL/ble/app/inc/key.h'), true);
  // 绝对路径也支持
  assert.equal(isAllowedCodePath(root, root + '/T23/projects/x/ble/app/src/a.c'), true);
});

test('固件代码白名单：拒绝 SDK/协议栈/boot/构建产物/非源码', () => {
  const denied = [
    'T23/firmware/CMSIS/core/core_cm0.h',
    'T23/firmware/n32wb03x_std_periph_driver/src/gpio.c',
    'T23/middlewares/Nationstech/ble_library/stack.c',
    'T23/middlewares/Third_Party/FreeRTOS/tasks.c',
    'T23/projects/n32wb03x_EVAL/ble/boot/src/main.c',
    'T23/projects/n32wb03x_EVAL/ble/app/MDK-ARM/Objects/T23.axf',
    'T23/projects/n32wb03x_EVAL/ble/app/src/readme.txt',
    '../../etc/passwd',
  ];
  for (const p of denied) assert.equal(isAllowedCodePath(root, p), false, p);
});
