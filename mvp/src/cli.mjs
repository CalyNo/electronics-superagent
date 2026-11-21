#!/usr/bin/env node
// CLI 入口（唯一需要 `node src/cli.mjs` 调用的文件）。
//
// 这里只做一件事：先装警告过滤器，再动态加载实现。
// 为什么要这么绕：node:sqlite 在 import 阶段就发出 ExperimentalWarning，
// 静态 import 的话实现先于本文件执行，过滤来不及装上（会让每次启动都多两行噪音，
// 盖住真正要看的信息）。动态 import 才能保证"先装过滤器、再加载依赖"。

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  // 只压这一条，其余警告（含我们自己触发的）照常输出
  if (/SQLite is an experimental feature/i.test(text)) return;
  return emitWarning(warning, ...rest);
};

await import('./cli-impl.mjs');
