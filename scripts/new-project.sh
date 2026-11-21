#!/usr/bin/env bash
# ============================================================================
# 新项目骨架生成器
#
# 用法：
#   ./scripts/new-project.sh PCU24 "电机控制器 2024 平台" --org acme --owner "张工"
#   ./scripts/new-project.sh PCU24S "PCU24 衍生型号" --form B --target /srv/repos
#   ./scripts/new-project.sh --verify /srv/repos/pcu24
#
# 只做三件事：建目录、套模板、初始化 Git 基线。
# 不做：建远端仓库、配保护规则、平台注册（这些需要人的账号权限，见 docs/09 §7）
# ============================================================================
set -euo pipefail

CODE=""
NAME=""
FORM="A"
TARGET="."
ORG="acme"
OWNER_NAME=""
PLATFORM=""
CUSTOMER=""
STAGES="S1"
WITH_GIT="0"
DRY="0"
FORCE="0"
VERIFY_DIR=""

SCAFFOLD="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scaffold"

usage() {
  sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() { printf '错误: %s\n' "$*" >&2; exit 1; }
log() { printf '  %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
[[ $# -lt 1 ]] && usage 1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify)   VERIFY_DIR="${2:-}"; shift 2 ;;
    --form)     FORM="${2:-A}"; shift 2 ;;
    --target)   TARGET="${2:-.}"; shift 2 ;;
    --org)      ORG="${2:-acme}"; shift 2 ;;
    --owner)    OWNER_NAME="${2:-}"; shift 2 ;;
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --customer) CUSTOMER="${2:-}"; shift 2 ;;
    --stages)   STAGES="${2:-S1}"; shift 2 ;;
    --git)      WITH_GIT="1"; shift ;;
    --dry-run)  DRY="1"; shift ;;
    --force)    FORCE="1"; shift ;;
    -h|--help)  usage 0 ;;
    -*)         die "未知参数 $1" ;;
    *)
      if   [[ -z "$CODE" ]]; then CODE="$1"
      elif [[ -z "$NAME" ]]; then NAME="$1"
      else die "多余的参数 $1"
      fi
      shift ;;
  esac
done

CODE_LOWER="$(printf '%s' "$CODE" | tr '[:upper:]' '[:lower:]')"

# ---------------------------------------------------------------------------
# 阶段定义：只建启用的阶段，未启用的完全不创建（见 docs/09 §2.2）
# ---------------------------------------------------------------------------
stage_types() {
  case "$1" in
    S1) printf 'S1-策划/CHTR S1-策划/SRS S1-策划/APQP S1-策划/FEAS' ;;
    S2) printf 'S2-产品设计/DFMEA S2-产品设计/DVP S2-产品设计/SC' ;;
    S3) printf 'S3-过程设计/PFC S3-过程设计/PFMEA S3-过程设计/CP' ;;
    S4) printf 'S4-验证/MSA S4-验证/SPC S4-验证/TR S4-验证/PPAP' ;;
    S5) printf 'S5-量产/8D S5-量产/ECN' ;;
    *)  die "未知阶段 $1（可选 S1..S5）" ;;
  esac
}

# ---------------------------------------------------------------------------
# 校验模式
# ---------------------------------------------------------------------------
if [[ -n "$VERIFY_DIR" ]]; then
  ROOT="$VERIFY_DIR"
  FAIL=0

  # 形态 B 的资产子树在 projects/<CODE>/ 下，形态 A 在仓库根
  VCODE="$(printf '%s' "$(basename "$ROOT")" | tr '[:lower:]' '[:upper:]')"
  if [[ -d "$ROOT/projects/$VCODE" ]]; then
    BASE="$ROOT/projects/$VCODE"; VFORM="B"
  else
    BASE="$ROOT"; VFORM="A"
  fi

  chk() {
    if [[ -e "$BASE/$1" ]]; then log "OK   $1"; else printf '  FAIL %s\n' "$1"; FAIL=1; fi
  }
  chkr() {
    if [[ -e "$ROOT/$1" ]]; then log "OK   $1"; else printf '  FAIL %s\n' "$1"; FAIL=1; fi
  }
  echo "校验骨架: $ROOT （形态 $VFORM）"

  # 仓库级：始终在仓库根
  for p in .gitattributes .gitignore .github/CODEOWNERS .github/pull_request_template.md \
           README.md docs/_index/documents.csv docs/_index/traceability.csv; do
    chkr "$p"
  done
  # 项目级：形态 B 在 projects/<CODE>/ 下
  for p in .superagent/manifest.yml .superagent/rules.yml .superagent/taxonomy.yml \
           docs/_templates hardware/manifest.yml hardware/_released/compatibility.yml \
           hardware/bom hardware/schematic hardware/pcb firmware software test/unit \
           test/hil evidence tools/validators; do
    chk "$p"
  done
  [[ "$VFORM" == "B" ]] && chkr "platform/bsp"

  if [[ -f "$BASE/.superagent/manifest.yml" ]]; then
    MCODE="$(grep -E '^code:' "$BASE/.superagent/manifest.yml" | head -1 | awk '{print $2}')"
    if [[ "$MCODE" == "$(basename "$ROOT")" || "$(basename "$ROOT")" == "$(printf '%s' "$MCODE" | tr '[:upper:]' '[:lower:]')" ]]; then
      log "OK   manifest.code 与仓库名一致 ($MCODE)"
    else
      printf '  FAIL manifest.code=%s 与仓库名 %s 不一致\n' "$MCODE" "$(basename "$ROOT")"; FAIL=1
    fi
  fi

  if [[ -f "$ROOT/.gitattributes" ]] && grep -q 'filter=lfs' "$ROOT/.gitattributes"; then
    log "OK   LFS 规则存在"
  else
    printf '  FAIL .gitattributes 缺少 LFS 规则\n'; FAIL=1
  fi

  if [[ -d "$ROOT/.git" ]]; then
    if git -C "$ROOT" rev-parse -q --verify 'refs/tags/baseline-v0.0.1' >/dev/null; then
      log "OK   baseline-v0.0.1 存在"
    else
      printf '  FAIL 缺少 baseline-v0.0.1 tag\n'; FAIL=1
    fi
    if git -C "$ROOT" rev-parse -q --verify 'refs/heads/develop' >/dev/null; then
      log "OK   develop 分支存在"
    else
      printf '  FAIL 缺少 develop 分支\n'; FAIL=1
    fi
  fi

  echo
  if [[ $FAIL -eq 0 ]]; then echo "RESULT: PASS"; exit 0; else echo "RESULT: FAIL"; exit 1; fi
fi

# ---------------------------------------------------------------------------
# 生成模式
# ---------------------------------------------------------------------------
[[ -z "$CODE" ]] && die "必须提供项目代号"
[[ -z "$NAME" ]] && die "必须提供项目名称"

[[ "$CODE" =~ ^[A-Z][A-Z0-9]{1,7}$ ]] || die "项目代号须为 2-8 位大写字母数字，且以字母开头：$CODE"
[[ "$FORM" =~ ^[ABC]$ ]] || die "形态只能是 A/B/C：$FORM"
[[ -d "$SCAFFOLD" ]] || die "找不到 scaffold 目录：$SCAFFOLD"

ROOT="$TARGET/$CODE_LOWER"
[[ -e "$ROOT" && $FORCE -eq 0 ]] && die "目标已存在：$ROOT（如需覆盖骨架文件请加 --force）"

# 形态 B 的子树前缀
if [[ "$FORM" == "B" ]]; then
  BASE="$ROOT/projects/$CODE"
else
  BASE="$ROOT"
fi

STAGE_DIRS=""
for s in $(printf '%s' "$STAGES" | tr ',' ' ' | tr '[:lower:]' '[:upper:]'); do
  STAGE_DIRS="$STAGE_DIRS $(stage_types "$s")"
done

echo "生成骨架"
log "代号  : $CODE"
log "形态  : $FORM"
log "根目录: $ROOT"
log "阶段  : $STAGES"
echo

COMMON_DIRS="
$BASE/docs/_templates
$BASE/docs/_index
$BASE/docs/_common/MIN
$BASE/docs/_common/REV
$BASE/docs/_common/RISK
$BASE/docs/_archive
$BASE/hardware/bom
$BASE/hardware/schematic
$BASE/hardware/pcb
$BASE/hardware/mechanical
$BASE/hardware/fixture
$BASE/hardware/datasheet
$BASE/hardware/_released
$BASE/firmware/app
$BASE/firmware/drivers
$BASE/firmware/bsp
$BASE/firmware/bootloader
$BASE/firmware/config
$BASE/software/gui
$BASE/software/tools
$BASE/test/unit
$BASE/test/hil
$BASE/evidence
$BASE/tools/validators
$BASE/tools/generators
$BASE/.superagent
$BASE/.github
"

if [[ "$FORM" == "B" ]]; then
  COMMON_DIRS="$COMMON_DIRS
$ROOT/platform/bsp
$ROOT/platform/drivers
$ROOT/platform/hardware/schematic
$ROOT/platform/hardware/pcb
$ROOT/platform/docs
$ROOT/docs/_index
"
fi

for d in $COMMON_DIRS; do
  [[ -d "$d" ]] || { [[ $DRY -eq 1 ]] && log "mkdir $d" || mkdir -p "$d"; }
done

for st in $STAGE_DIRS; do
  d="$BASE/docs/$st"
  [[ -d "$d" ]] || { [[ $DRY -eq 1 ]] && log "mkdir $d" || mkdir -p "$d"; }
done

# .gitkeep：仅对为空目录，使骨架可随仓库同步
if [[ $DRY -eq 0 ]]; then
  find "$BASE" -type d -empty -exec touch {}/.gitkeep \;
  find "$ROOT" -type d -empty -exec touch {}/.gitkeep \; 2>/dev/null || true
fi

# 模板套用
subst() {
  sed -e "s|{{CODE}}|$CODE|g" \
      -e "s|{{codeLower}}|$CODE_LOWER|g" \
      -e "s|{{NAME}}|$NAME|g" \
      -e "s|{{PLATFORM}}|${PLATFORM:-$CODE}|g" \
      -e "s|{{CUSTOMER}}|${CUSTOMER:-未指定}|g" \
      -e "s|{{OWNER_NAME}}|${OWNER_NAME:-待指定}|g" \
      -e "s|{{org}}|$ORG|g" \
      "$1"
}

copy_tpl() {
  local src="$1" dst="$2"
  if [[ $DRY -eq 1 ]]; then log "tpl $(basename "$src") -> $dst"; return; fi
  mkdir -p "$(dirname "$dst")"
  subst "$src" > "$dst"
}

# 仓库级文件：始终落在仓库根（形态 B 也不例外）
copy_tpl "$SCAFFOLD/README.md"                         "$ROOT/README.md"
copy_tpl "$SCAFFOLD/.gitattributes"                    "$ROOT/.gitattributes"
copy_tpl "$SCAFFOLD/.gitignore"                        "$ROOT/.gitignore"
copy_tpl "$SCAFFOLD/.github/CODEOWNERS"                "$ROOT/.github/CODEOWNERS"
copy_tpl "$SCAFFOLD/.github/pull_request_template.md"  "$ROOT/.github/pull_request_template.md"
copy_tpl "$SCAFFOLD/docs/_index/documents.csv"         "$ROOT/docs/_index/documents.csv"
copy_tpl "$SCAFFOLD/docs/_index/traceability.csv"      "$ROOT/docs/_index/traceability.csv"

# 项目级文件：形态 B 落在 projects/<CODE>/ 下
if [[ "$FORM" == "B" ]]; then
  copy_tpl "$SCAFFOLD/docs/_index/documents.csv"       "$BASE/docs/_index/documents.csv"
  copy_tpl "$SCAFFOLD/docs/_index/traceability.csv"    "$BASE/docs/_index/traceability.csv"
fi
copy_tpl "$SCAFFOLD/.superagent/manifest.yml"          "$BASE/.superagent/manifest.yml"
copy_tpl "$SCAFFOLD/.superagent/rules.yml"             "$BASE/.superagent/rules.yml"
copy_tpl "$SCAFFOLD/.superagent/taxonomy.yml"          "$BASE/.superagent/taxonomy.yml"
copy_tpl "$SCAFFOLD/hardware/manifest.yml"             "$BASE/hardware/manifest.yml"
copy_tpl "$SCAFFOLD/hardware/_released/compatibility.yml" "$BASE/hardware/_released/compatibility.yml"

# 形态 B：仓库根的 README 描述平台与项目清单，项目自己的 README 留在子树里
if [[ "$FORM" == "B" && $DRY -eq 0 ]]; then
  copy_tpl "$SCAFFOLD/README.md" "$BASE/README.md"
  cat > "$ROOT/README.md" <<EOF
# ${CODE_LOWER} 平台仓

> 单仓多项目：\`platform/\` 为共享资产（执行器默认只读），\`projects/<CODE>/\` 为各衍生型号。

## 项目

| 代号 | 名称 | 状态 |
| --- | --- | --- |
| \`${CODE}\` | ${NAME} | 开发中 |

## 规则

- 共享资产改动需 \`@${ORG}/platform\` 批准，且必须评估对所有项目的回归影响；
- 执行器写权限限定在 \`projects/<CODE>/\`，\`platform/\` 只读；
- 各项目文档规范见 \`projects/<CODE>/.superagent/\`。

## 索引

全局索引见 \`docs/_index/\`；项目内索引见 \`projects/<CODE>/docs/_index/\`。
EOF
fi

# 模板副本：从平台同步，只读
TPL_SRC="$(cd "$SCAFFOLD/.." && pwd)/templates"
if [[ -d "$TPL_SRC" && $DRY -eq 0 ]]; then
  cp -f "$TPL_SRC"/*.md "$BASE/docs/_templates/" 2>/dev/null || true
  find "$BASE/docs/_templates" -type f -name '*.md' -exec chmod 444 {} \; 2>/dev/null || true
fi

# manifest 的 stages.enabled 与生成目录保持一致
if [[ $DRY -eq 0 && -f "$BASE/.superagent/manifest.yml" ]]; then
  STAGE_YAML="[$(printf '%s' "$STAGES" | tr ',' ' ' | tr '[:lower:]' '[:upper:]' | tr ' ' ',' | sed 's/,,*/,/g')]"
  sed -i.bak "s|^  enabled: .*|  enabled: $STAGE_YAML|" "$BASE/.superagent/manifest.yml" && rm -f "$BASE/.superagent/manifest.yml.bak"
  # 占位符长度与实际值不同，压缩过宽的注释缩进，避免生成后对齐错位
  sed -i.bak -E 's/ {3,}#/  #/' "$BASE/.superagent/manifest.yml" && rm -f "$BASE/.superagent/manifest.yml.bak"
fi

# ---------------------------------------------------------------------------
# Git 初始化：首提由人完成，执行器不得创建基线（docs/09 §5.1）
# ---------------------------------------------------------------------------
if [[ "$WITH_GIT" == "1" ]]; then
  if [[ $DRY -eq 1 ]]; then
    log "git init -b main && commit && branch develop && tag baseline-v0.0.1"
  else
    git -C "$ROOT" init -q -b main
    git -C "$ROOT" add -A
    if [[ -z "$(git -C "$ROOT" config user.name || true)" ]]; then
      git -C "$ROOT" config user.name "bootstrap"
      git -C "$ROOT" config user.email "bootstrap@localhost"
    fi
    git -C "$ROOT" commit -q -m "chore(bootstrap): $CODE 项目骨架与模板基线"
    git -C "$ROOT" branch -q develop
    git -C "$ROOT" tag -a baseline-v0.0.1 -m "$CODE 骨架基线，可供智能体接单"
    log "Git: main + develop + baseline-v0.0.1"
  fi
fi

echo
echo "完成。后续人工步骤（需要你的仓库管理权限，脚本不代做）："
cat <<'NEXT'
  1. 建远端仓库并推送：git remote add origin <url> && git push -u origin main develop --tags
  2. 配置分支保护：main/develop 禁直推、必须 PR、状态检查必过（docs/09 §5.2）
  3. 添加执行器账号为 collaborator（write），并加入 agents 组
  4. 替换 .github/CODEOWNERS 与 .superagent/manifest.yml 中的占位符
  5. 平台侧注册 profile / stateDir / source / policy 项目条目
  6. 填 docs/_index/import-map.csv 导入存量资产（如为存量项目）
  7. 校验：./scripts/new-project.sh --verify <repo>
NEXT
