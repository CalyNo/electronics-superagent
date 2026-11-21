---
id: DOC-S4-PPAP-014
title: <项目名称> PPAP 提交清单
project: <项目代号>
stage: S4
type: PPAP
revision: v0.1
status: draft
classification: confidential
owner: <质量工程师>
reviewers: []
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
related:
  requirements: []
traceability:
  upstream: [DOC-S4-TR-013, DOC-S3-CP-010, DOC-S4-MSA-011, DOC-S4-SPC-012]
  downstream: []
---

# <项目名称> PPAP 提交清单

## 文档信息

| 项 | 内容 |
| --- | --- |
| 项目代号 | <PCU24> |
| 零件号 | <PCU-24-10K> |
| 客户 | <客户名称> |
| 提交等级 | <Level 3> |
| 版本 | v0.1 |
| 编制 | <姓名> |
| 日期 | <YYYY-MM-DD> |

## 修订记录

| 版本 | 日期 | 修订人 | 修订内容 |
| --- | --- | --- | --- |
| v0.1 | <日期> | <姓名> | 初稿 |

## 1. 提交等级说明

| 等级 | 提交内容 | 适用 |
| --- | --- | --- |
| Level 1 | 仅 PSW | 成熟产品 |
| Level 2 | PSW + 样品 + 有限数据 | 一般 |
| Level 3 | PSW + 样品 + 完整数据 | 默认 |
| Level 4 | PSW + 客户指定 | 客户要求 |
| Level 5 | 全套资料在供方现场评审 | 特殊 |

**本项目选择**：<Level 3>，理由：<新零件、客户默认要求>。

## 2. 18 项要素清单（必填）

| 序号 | 要素 | 要求 | 状态 | 文件/证据 | 责任人 |
| --- | --- | --- | --- | --- | --- |
| 1 | 设计记录 | 图纸、3D 模型、规范 | ☑ | `hardware/_released/hw1.2/` | HW |
| 2 | 工程更改文件 | 所有已批准的 ECN | ☑ | `docs/S5-量产/ECN/` | PM |
| 3 | 顾客工程批准 | 客户签署的设计批准 | ☐ | 待客户签署 | SE |
| 4 | 设计 FMEA | 最新版 DFMEA | ☑ | `DOC-S2-DFMEA-005` | HW |
| 5 | 过程流程图 | 最新版 PFC | ☑ | `DOC-S3-PFC-008` | PE |
| 6 | 过程 FMEA | 最新版 PFMEA | ☑ | `DOC-S3-PFMEA-009` | PE |
| 7 | 控制计划 | 试生产/生产版 | ☑ | `DOC-S3-CP-010` | QE |
| 8 | MSA 研究 | GRR 报告 | ☑ | `DOC-S4-MSA-011` | QE |
| 9 | 尺寸结果 | 全尺寸报告 | ☑ | `evidence/dimensional.pdf` | TE |
| 10 | 材料/性能试验 | 材料与性能报告 | ☑ | `evidence/material-perf.pdf` | TE |
| 11 | 初始过程研究 | Cpk/Ppk 报告 | ☑ | `DOC-S4-SPC-012` | QE |
| 12 | 合格实验室文件 | 实验室资质 | ☑ | `evidence/lab-cert.pdf` | QE |
| 13 | 外观批准报告 | AAR（如适用） | ☐ | 不适用，说明理由 | QE |
| 14 | 生产件样品 | 代表性样品 | ☑ | `evidence/samples/` | PE |
| 15 | 标准样品 | 签样保存 | ☑ | `evidence/master-sample/` | QE |
| 16 | 检具 | 检具清单与 MSA | ☑ | `evidence/gauges.pdf` | QE |
| 17 | 顾客特殊要求 | CSR 符合性矩阵 | ☑ | `evidence/csr-matrix.pdf` | SE |
| 18 | 零件提交保证书 | PSW 签署 | ☐ | 待签署 | QE |

> 状态说明：☑ 完成　☐ 未完成　— 不适用（需备注理由）

## 3. 关键数据摘要

| 项 | 要求 | 实际 | 判定 |
| --- | --- | --- | --- |
| 试产数量 | ≥300 件 | <300> | 合格 |
| 直通率 | ≥95% | <96%> | 合格 |
| CC 特性 Cpk | ≥1.67 | <1.88> | 合格 |
| SC 特性 Cpk | ≥1.33 | <1.45> | 合格 |
| MSA %GRR | <10% | <8.5%> | 合格 |
| 材料合规 | RoHS/REACH | 合格 | 合格 |

## 4. 不符合项与偏差

| 编号 | 要素 | 问题 | 偏差申请 | 客户批准 | 状态 |
| --- | --- | --- | --- | --- | --- |
| NC-001 | 3 | 客户工程批准未回 | 否 | — | 阻塞 |
| NC-002 | 13 | 外观件不适用 | 是 | 待批 | 开放 |

**规则**：任何 ☐ 项必须在提交前关闭或取得客户书面偏差批准，否则不得提交 PPAP。

## 5. PSW（零件提交保证书）摘要

| 项 | 内容 |
| --- | --- |
| 零件号 | <PCU-24-10K> |
| 图纸版本 | <Rev C> |
| 工程变更等级 | <Level 3> |
| 重量 | <420 g> |
| 材料 | <按 BOM> |
| 提交原因 | <新零件 / 工程变更 / 年度确认> |
| 提交等级 | <Level 3> |
| 符合性声明 | 所有测量结果符合规格 |
| 签署人 | <质量负责人> |
| 日期 | <YYYY-MM-DD> |

## 6. 提交包目录

```
ppap-pcu24-hw1.2/
├── 00-PSW.pdf
├── 01-design-record/
├── 02-engineering-changes/
├── 03-customer-approval/
├── 04-DFMEA.pdf
├── 05-PFC.pdf
├── 06-PFMEA.pdf
├── 07-control-plan.pdf
├── 08-MSA.pdf
├── 09-dimensional.pdf
├── 10-material-performance.pdf
├── 11-initial-process-study.pdf
├── 12-lab-certificate.pdf
├── 13-AAR.pdf
├── 14-samples/
├── 15-master-sample/
├── 16-gauges.pdf
├── 17-CSR-matrix.pdf
└── 18-PSW.pdf
```

## 7. 提交前检查

- [ ] 18 项要素全部 ☑ 或有批准的偏差
- [ ] 所有文件为最新版本
- [ ] 所有签署完整
- [ ] 数据与报告一致
- [ ] 客户特殊要求已逐条对照
- [ ] 提交包目录结构完整
- [ ] 电子版与纸质版一致

## 8. 批准

| 角色 | 姓名 | 签字 | 日期 |
| --- | --- | --- | --- |
| 质量工程师 | | | |
| 项目经理 | | | |
| 质量负责人 | | | |
| 客户 SQE | | | |

> ⚠ 待补充：客户工程批准（要素 3）需在提交前取得。
