#!/usr/bin/env bash
# ============================================================================
# 存量项目迁移助手
#
# 用法：
#   ./scripts/import-project.sh /data/legacy/PCU_V2 --scan
#   ./scripts/import-project.sh /data/legacy/PCU_V2 --plan --out .migration
#   ./scripts/import-project.sh /data/legacy/PCU_V2 --apply --code PCU24 --stages S1,S2
#   ./scripts/import-project.sh /data/legacy/pcu24 --verify
#
# 安全原则（不可更改）：
#   1. --scan / --plan 是只读的，不写源目录一个字节；
#   2. --apply 只新增，绝不覆盖、绝不删除、绝不移动任何原有文件；
#   3. 冲突文件写成 <原名>.platform-new 留给人裁决；
#   4. 所有新增动作登记在 .migration/manifest.txt，支持一键回滚（docs/10 §7.1）。
# ============================================================================
set -euo pipefail

SRC=""
MODE="scan"
CODE=""
OUT=""
STAGES="S1"
PNAME=""
PCUSTOMER=""
PPLATFORM=""
POWNER=""
MAX_MB="50"
WITH_GIT_INIT="0"
DRY="0"
ASSUME_YES="0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAFFOLD="$SCRIPT_DIR/../scaffold"

usage() {
  sed -n '3,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}
die() { printf '错误: %s\n' "$*" >&2; exit 1; }
log() { printf '  %s\n' "$*"; }
warn() { printf '  [警告] %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------
[[ $# -lt 1 ]] && usage 1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scan)       MODE="scan"; shift ;;
    --plan)       MODE="plan"; shift ;;
    --apply)      MODE="apply"; shift ;;
    --verify)     MODE="verify"; shift ;;
    --code)       CODE="${2:-}"; shift 2 ;;
    --out)        OUT="${2:-}"; shift 2 ;;
    --stages)     STAGES="${2:-S1}"; shift 2 ;;
    --name)       PNAME="${2:-}"; shift 2 ;;
    --customer)   PCUSTOMER="${2:-}"; shift 2 ;;
    --platform)   PPLATFORM="${2:-}"; shift 2 ;;
    --owner)      POWNER="${2:-}"; shift 2 ;;
    --max-mb)     MAX_MB="${2:-50}"; shift 2 ;;
    --git-init)   WITH_GIT_INIT="1"; shift ;;
    --dry-run)    DRY="1"; shift ;;
    --yes)        ASSUME_YES="1"; shift ;;
    -h|--help)    usage 0 ;;
    -*)           die "未知参数 $1" ;;
    *)            [[ -z "$SRC" ]] && SRC="$1" || die "多余参数 $1"; shift ;;
  esac
done

[[ -z "$SRC" ]] && usage 1
[[ -d "$SRC" ]] || die "目录不存在: $SRC"
SRC="$(cd "$SRC" && pwd)"
[[ -z "$OUT" ]] && OUT="$SRC/.migration"

# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
# 遍历源目录文件（排除 .git 与迁移自身产物）
iter_files() {
  find "$SRC" -type f \
    -not -path "*/.git/*" -not -path "*/.migration/*" \
    -not -path "*/node_modules/*" -not -path "*/build/*" \
    -not -name ".DS_Store" -print0 2>/dev/null
}

# CSV 字段转义
csvq() {
  local s="$1"
  case "$s" in
    *,*|*\"*) printf '"%s"' "$(printf '%s' "$s" | sed 's/"/""/g')" ;;
    *)        printf '%s' "$s" ;;
  esac
}

# rel 同时把结果写入 REL_RESULT（调用方可用 "${REL_RESULT}" 免开子进程）
rel() {
  REL_RESULT="${1#"$SRC"/}"
  printf '%s' "$REL_RESULT"
}

# 迁移产物（映射建议、sidecar 草案）不属于项目资产：写入 info/exclude，
# 既不进基线提交，也不去污染项目自己的 .gitignore
exclude_migration() {
  local excl="$SRC/.git/info/exclude"
  [[ -d "$SRC/.git/info" ]] || return 0
  if [[ -f "$excl" ]] && grep -qxF '.migration/' "$excl" 2>/dev/null; then
    return 0
  fi
  printf '.migration/\n' >> "$excl"
}
# 大小写折叠用 bash 4+ 的内建 ${var,,}/${var^^}，避免每个文件 fork 一次 tr。
# 分类规则的输出与原先的 `tr '[:upper:]' '[:lower:]'` 完全一致（ASCII 文件名）。
extract_rev() {
  local b
  b="${1##*/}"
  if [[ "$b" =~ [vV]([0-9]+(\.[0-9]+)*) ]]; then
    printf 'v%s' "${BASH_REMATCH[1]}"
  elif [[ "$b" =~ [Rr][Ee][Vv][[:space:]_.-]?([A-Za-z])([^A-Za-z]|$) ]]; then
    local u="${BASH_REMATCH[1]}"
    printf 'Rev%s' "${u^^}"
  elif [[ "$b" =~ ([A-Z])版 ]]; then
    printf 'Rev%s' "${BASH_REMATCH[1]}"
  else
    printf 'v0.0'
  fi
}

is_binary_doc() {
  local l="${1,,}"
  case "$l" in
    *.pdf|*.doc|*.docx|*.xls|*.xlsx|*.ppt|*.pptx|*.vsd|*.vsdx) return 0 ;;
    *) return 1 ;;
  esac
}

is_hw_binary() {
  local l="${1,,}"
  case "$l" in
    *.schdoc|*.pcbdoc|*.sch|*.pcb|*.gbr|*.gerber|*.step|*.stp|*.igs|*.iges|*.dwg|*.dxf|*.zip) return 0 ;;
    *) return 1 ;;
  esac
}

is_code() {
  local l="${1,,}"
  case "$l" in
    *.c|*.h|*.cc|*.cpp|*.hpp|*.s|*.asm|*.ld|*.py|*.js|*.ts|*.cs|*.java|*.go|*.rs) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# 分类：输出 "kind|target|type|stage|confidence"
#   kind = doc / hw / code / unknown
# 规则见 docs/10 §4 P3 的判定表；项目专属关键词可通过 taxonomy.yml 后续扩展
# ---------------------------------------------------------------------------
# classify 把结果同时写入全局 CLS_RESULT，并照旧打印（保持向后兼容）。
# 热循环用 `classify "$f" >/dev/null; r="$CLS_RESULT"` 复用同进程结果，省去每文件一次 fork。
classify() {
  local base lower hit cls
  base="${1##*/}"                       # 等价于 basename "$1"，无子进程
  lower="${base,,}"                     # 等价于 tr '[:upper:]' '[:lower:]'，无子进程
  hit() { case "$lower" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
  # hitw：短英文缩写必须按"分隔符边界"匹配，否则 spc 会命中 spcp.c、eco 会命中 Recorder。
  # 中文关键词与长描述词仍走 hit（子串），因为中文没有空格分词。
  hitw() {
    local k="$1"
    case "$lower" in
      "$k"|"$k"[!a-z0-9]*|*[!a-z0-9]"$k"|*[!a-z0-9]"$k"[!a-z0-9]*) return 0 ;;
      *) return 1 ;;
    esac
  }

  # --- 文档：先匹配长关键词，避免短词误命中 ---
  if   hit "dfmea"                            ; then cls="doc|S2-产品设计|DFMEA|S2|high"
  elif hit "pfmea"                            ; then cls="doc|S3-过程设计|PFMEA|S3|high"
  elif hit "control_plan" || hit "control plan" || hit "控制计划" \
       || hit "controlplan" || hit "-cp-" || hit "_cp_" ; then cls="doc|S3-过程设计|CP|S3|high"
  elif hit "流程图" || hitw "pfc" || hit "process_flow" ; then cls="doc|S3-过程设计|PFC|S3|high"
  elif hitw "msa" || hitw "gage" || hitw "grr" ; then cls="doc|S4-验证|MSA|S4|high"
  elif hitw "spc" || hitw "cpk" || hitw "ppk" || hit "过程能力" ; then cls="doc|S4-验证|SPC|S4|high"
  elif hitw "ppap" || hitw "psw"               ; then cls="doc|S4-验证|PPAP|S4|high"
  elif hitw "8d"                              ; then cls="doc|S5-量产|8D|S5|high"
  elif hitw "ecn" || hitw "eco" || hitw "pcn" || hit "变更通知" ; then cls="doc|S5-量产|ECN|S5|high"
  elif hitw "sor" || hitw "rfq" || hitw "srs" || hit "技术要求" || hit "客户规范" ; then cls="doc|S1-策划|SRS|S1|high"
  elif hit "章程" || hit "charter"            ; then cls="doc|S1-策划|CHTR|S1|high"
  elif hit "apqp" || hit "项目计划" || hit "timing" ; then cls="doc|S1-策划|APQP|S1|high"
  elif hit "可行性" || hit "feasibility"      ; then cls="doc|S1-策划|FEAS|S1|medium"
  elif hitw "dvp" || hit "验证计划"            ; then cls="doc|S2-产品设计|DVP|S2|high"
  elif hit "特殊特性" || hit "关键特性" || hit "cc_sc" ; then cls="doc|S2-产品设计|SC|S2|medium"
  elif hit "试产" || hit "试作" || hit "pilot" || hit "run@rate" ; then cls="doc|S4-验证|TR|S4|medium"

  # --- 硬件 ---
  elif hitw "bom"                             ; then cls="hw|hardware/bom|bom||high"
  elif hit "原理图" || hit "schematic" || hit "schdoc" ; then cls="hw|hardware/schematic|schematic||high"
  elif hitw "pcb" || hit "gerber"              ; then cls="hw|hardware/pcb|pcb||high"
  elif hit "工装" || hit "治具" || hit "夹具" || hit "fixture" ; then cls="hw|hardware/fixture|fixture||medium"
  elif hit "datasheet" || hit "器件手册" || hit "规格书" ; then cls="hw|hardware/datasheet|datasheet||medium"
  elif hit "结构" || hit "外壳" || hit "mechanical" ; then cls="hw|hardware/mechanical|mechanical||medium"

  # --- 二进制硬件（靠扩展名兜底）---
  elif is_hw_binary "$base"                    ; then cls="hw|hardware|misc||medium"

  # --- 代码 ---
  elif is_code "$base"                         ; then
    case "$lower" in
      *.py|*.js|*.ts|*.cs|*.java) cls="code|software|src||medium" ;;
      *)                          cls="code|firmware|src||high" ;;
    esac

  # --- 二进制文档：只能靠扩展名，需要人工定位阶段 ---
  elif is_binary_doc "$base"                   ; then cls="doc|||unknown|low"

  else cls="unknown|||unknown|low"
  fi
  CLS_RESULT="$cls"
  printf '%s' "$cls"
}

# ---------------------------------------------------------------------------
# scan：只读盘点
# ---------------------------------------------------------------------------
do_scan() {
  local total=0 size=0 gitstate big=0 dhigh=0 dmed=0 dlow=0 ncode=0 nhw=0

  while IFS= read -r -d '' f; do
    total=$((total + 1))
    classify "$f" >/dev/null; local r="$CLS_RESULT"
    case "$r" in
      doc*high*)     dhigh=$((dhigh + 1)) ;;
      doc*medium*)   dmed=$((dmed + 1)) ;;
      doc*low*)      dlow=$((dlow + 1)) ;;
      hw*)           nhw=$((nhw + 1)) ;;
      code*)         ncode=$((ncode + 1)) ;;
    esac
  done < <(iter_files)

  size="$(du -sk "$SRC" 2>/dev/null | awk '{printf "%.1f", $1/1024}' || echo "?")"

  if [[ -d "$SRC/.git" ]]; then
    gitstate="是（分支 $(git -C "$SRC" branch --list 2>/dev/null | wc -l | tr -d ' ')，提交 $(git -C "$SRC" rev-list --count HEAD 2>/dev/null || echo 0)）"
    if [[ -n "$(git -C "$SRC" status --porcelain 2>/dev/null | head -1)" ]]; then
      gitstate="$gitstate，工作区有未提交改动"
    fi
  else
    gitstate="否"
  fi

  printf '\n源目录：%s\n' "$SRC"
  printf '文件数：%s   总体积：%s MB   Git：%s\n\n' "$total" "$size" "$gitstate"

  printf '扩展名分布（前 10）：\n'
  iter_files \
    | tr '\0' '\n' \
    | sed -n 's/.*\(\.[^./][^./]*\)$/\1/p' \
    | tr '[:upper:]' '[:lower:]' \
    | sort | uniq -c | sort -rn | head -10 \
    | while read -r n e; do printf '  %-10s %6s\n' "$e" "$n"; done

  printf '\n分类建议：\n'
  printf '  文档 高置信 %s / 中置信 %s / 无法定位 %s\n' "$dhigh" "$dmed" "$dlow"
  printf '  硬件 %s   代码 %s\n' "$nhw" "$ncode"

  # 大文件
  printf '\n超过 %s MB 的文件：\n' "$MAX_MB"
  big=0
  while IFS= read -r -d '' f; do
    if [[ $big -ge 20 ]]; then break; fi
    printf '  %s  (%s)\n' "$(rel "$f")" "$(du -h "$f" | cut -f1)"
    big=$((big + 1))
  done < <(find "$SRC" -type f -size "+${MAX_MB}M" -not -path "*/.git/*" -print0 2>/dev/null)
  [[ $big -eq 0 ]] && printf '  无\n'

  # 疑似密钥：覆盖 `KEY = "..."`、`key: "..."`、`#define API_KEY "..."` 三种常见写法
  printf '\n疑似凭据（命中即阻断，见 docs/10 §4 P1）：\n'
  local hits
  hits="$(grep -rIliE --exclude-dir=.git --exclude-dir=.migration --exclude-dir=node_modules \
      '(api[_-]?key|secret|passwd|password|access[_-]?key|token|private[_-]?key)[[:space:]]*[:=]?[[:space:]]*["'"'"'][A-Za-z0-9/+_.-]{12,}' \
      "$SRC" 2>/dev/null | head -20 || true)"
  if [[ -n "$hits" ]]; then
    printf '%s\n' "$hits" | while read -r f; do printf '  %s\n' "$(rel "$f")"; done
  else
    printf '  未发现\n'
  fi

  # 重名
  printf '\n重复文件名（不同目录，通常是多版本共存）：\n'
  local dups
  dups="$(find "$SRC" -type f \
      -not -path "*/.git/*" -not -path "*/.migration/*" -not -path "*/node_modules/*" \
      -printf '%f\n' 2>/dev/null | sort | uniq -d | head -10 || true)"
  if [[ -n "$dups" ]]; then printf '%s\n' "$dups" | sed 's/^/  /'; else printf '  无\n'; fi

  printf '\n下一步：--plan 生成映射建议（只读，不改源文件）\n'
}

# ---------------------------------------------------------------------------
# plan：生成 import-map 建议 + sidecar + 债务台账
# ---------------------------------------------------------------------------
do_plan() {
  local map="$OUT/import-map.proposed.csv"
  local debt="$OUT/legacy-debt.csv"
  declare -A SEQ=()
  declare -A SEEN=()
  local n_map=0 n_sc=0 n_debt=0 n_unclassified=0 n_meta=0 n_meta=0

  if [[ $DRY -eq 1 ]]; then
    log "[dry-run] 将在 $OUT 生成 import-map.proposed.csv / sidecars/ / legacy-debt.csv"
    return 0
  fi

  mkdir -p "$OUT/sidecars" "$SRC/docs/_index"
  printf 'oldPath,assetId,type,stage,status,note\n' > "$map"
  printf 'assetId,debtType,detail,owner,due,status\n' > "$debt"

  while IFS= read -r -d '' f; do
    local r kind target type stage conf rp id
    # 版本控制与平台元文件不是可追溯资产，不进映射表（也不进债务台账）
    case "${f##*/}" in
      .gitignore|.gitattributes|.gitmodules|.editorconfig|.DS_Store|*.meta.yml)
        n_meta=$((n_meta + 1)); continue ;;
    esac
    classify "$f" >/dev/null; r="$CLS_RESULT"
    kind="${r%%|*}";   r="${r#*|}"
    target="${r%%|*}"; r="${r#*|}"
    type="${r%%|*}";   r="${r#*|}"
    stage="${r%%|*}";  conf="${r#*|}"
    rel "$f" >/dev/null; rp="$REL_RESULT"

    case "$kind" in
      doc)
        if [[ -z "$stage" || "$stage" == "unknown" ]]; then
          # 二进制文档但无法定位阶段 → 不猜，进 unclassified
          printf '%s,,,,,%s\n' "$(csvq "$rp")" "无法定位阶段，见 legacy-debt" >> "$map"
          printf '%s,unclassified,二进制文档无阶段线索,%s,,\n' "$(csvq "$rp")" "" >> "$debt"
          n_unclassified=$((n_unclassified + 1))
          continue
        fi
        local key="${stage}-${type}"
        SEQ[$key]=$(( ${SEQ[$key]:-0} + 1 ))
        id="$(printf 'DOC-%s-%s-%03d' "$stage" "$type" "${SEQ[$key]}")"
        # 同名文件通常意味着多版本共存：不删除，提示人工判定权威版本
        local b bnote
        b="${f##*/}"
        if [[ -n "${SEEN[$b]:-}" ]]; then
          bnote="与 ${SEEN[$b]} 同名，疑似多版本，确认后标 obsolete 指向权威版本"
        elif [[ "$conf" == "high" ]]; then
          bnote="自动分类，待人工确认状态"
        else
          bnote="中置信，需人工确认"
        fi
        SEEN[$b]="$rp"
        printf '%s,%s,%s,%s,unknown,%s\n' "$(csvq "$rp")" "$id" "$type" "$stage" "$bnote" >> "$map"
        if is_binary_doc "$f"; then
          write_sidecar "$f" "$id" "$type" "$stage" "$conf"
          n_sc=$((n_sc + 1))
        fi
        [[ "$conf" != "high" ]] && { printf '%s,low-confidence,%s,%s,,\n' "$id" "仅凭路径/扩展名判定($conf)" "" >> "$debt"; n_debt=$((n_debt + 1)); }
        ;;
      hw)
        local hkey="${type}"
        SEQ["HW-$hkey"]=$(( ${SEQ["HW-$hkey"]:-0} + 1 ))
        id="$(printf 'HW-%s-%03d' "$type" "${SEQ["HW-$hkey"]}")"
        printf '%s,%s,%s,,unknown,%s\n' "$(csvq "$rp")" "$id" "$type" '权威标识见 hardware/manifest.yml（path+sha256）' >> "$map"
        ;;
      code)
        printf '%s,,,,,%s\n' "$(csvq "$rp")" '代码不分配资产 ID，用路径+commit 定位' >> "$map"
        ;;
      *)
        printf '%s,,,,,%s\n' "$(csvq "$rp")" '未分类，待指派' >> "$map"
        printf '%s,unclassified,无法按规则判定,%s,,\n' "$(csvq "$rp")" "" >> "$debt"
        n_unclassified=$((n_unclassified + 1))
        ;;
    esac
    n_map=$((n_map + 1))
  done < <(iter_files)

  printf '\n已生成：\n'
  log "映射建议  $map（$n_map 行）"
  log "sidecar   $OUT/sidecars/（$n_sc 份）"
  log "债务台账  $debt"
  log "未分类    $n_unclassified 份，需项目负责人指派"
  log "已跳过    $n_meta 份版本控制/平台元文件"
  printf '\n人工确认后，把 import-map.proposed.csv 改名放入 docs/_index/import-map.csv\n'
  printf '并用 --apply 把 sidecar 落到原文件旁边（不改原文件）\n'
}

write_sidecar() {
  local f="$1" id="$2" type="$3" stage="$4" conf="$5" rev
  local rp dir base
  rp="$(rel "$f")"
  dir="$OUT/sidecars/$(dirname "$rp")"
  base="$(basename "$f")"
  mkdir -p "$dir"
  rev="$(extract_rev "$f")"
  cat > "$OUT/sidecars/$rp.meta.yml" <<YAML
# sidecar 元数据（由 import-project.sh 生成，对应 docs/10 §4 P3）
# 原文件不改动：改名或改写会破坏哈希，而哈希是"这份就是当初交付那一版"的唯一证据
id: $id
type: $type
stage: $stage
status: unknown
# revision 取自文件名；v0.0 表示版本未知，不得臆造一个看起来合理的版本号
revision: $rev
owner: ""
source_file: $base
source_sha256: "$(sha256sum "$f" 2>/dev/null | cut -d' ' -f1)"
confidence: $conf
note: 迁移期生成，待人工确认后并入 documents.csv
YAML
}

# ---------------------------------------------------------------------------
# apply：加装骨架（只增不改）
# ---------------------------------------------------------------------------
do_apply() {
  local manifest="$OUT/manifest.txt"
  local n_add=0 n_conflict=0 n_skip=0

  [[ -z "$CODE" ]] && die "--apply 需要 --code（项目代号，2-8 位大写字母数字）"
  printf '%s' "$CODE" | grep -qE '^[A-Z][A-Z0-9]{1,7}$' || die "代号不合规：$CODE（须 2-8 位大写字母数字，首字符为字母）"

  # 所有参数在写入前校验完，避免加到一半才失败留下半成品
  local _s _stage_norm=()
  IFS=',' read -ra _SARR <<< "$STAGES"
  for _s in "${_SARR[@]}"; do
    _s="$(printf '%s' "$_s" | tr -d ' ' | tr '[:lower:]' '[:upper:]')"
    case "$_s" in
      S1|S2|S3|S4|S5) _stage_norm+=("$_s") ;;
      *) die "非法阶段：$_s（可选 S1..S5）" ;;
    esac
  done
  STAGES="$(IFS=','; printf '%s' "${_stage_norm[*]}")"

  log "源目录  $SRC"
  log "项目代号 $CODE"
  log "启用阶段 $STAGES"
  [[ $DRY -eq 1 ]] && log "[dry-run] 只打印，不写入"

  [[ $DRY -eq 0 ]] && { mkdir -p "$OUT"; : > "$manifest"; }

  # 0) 可选：无 Git 时先做 as-is 快照，保留原始状态可回溯
  if [[ ! -d "$SRC/.git" && "$WITH_GIT_INIT" == "1" ]]; then
    # 顺序很关键：先落 .gitattributes 再 git add，否则二进制以普通对象进历史，
    # 之后要转 LFS 就必须重写提交（docs/10 §4 P1）。此为唯一允许的例外写入。
    if [[ ! -e "$SRC/.gitattributes" && -f "$SCAFFOLD/.gitattributes" ]] && git lfs version >/dev/null 2>&1; then
      log "先落 .gitattributes（LFS 规则），保证快照中二进制走 LFS"
      [[ $DRY -eq 0 ]] && { cp "$SCAFFOLD/.gitattributes" "$SRC/.gitattributes"; printf '%s\n' ".gitattributes" >> "$manifest"; }
    elif ! git lfs version >/dev/null 2>&1; then
      warn "未安装 git-lfs：快照中的二进制将以普通对象入库，见 docs/10 §4 P1"
    fi
    log "初始化 Git 并做 as-is 快照提交"
    [[ $DRY -eq 0 ]] && {
      git -C "$SRC" init -q -b main 2>/dev/null || git -C "$SRC" init -q
      # 仓库级身份：不依赖全局 git config，避免快照提交因缺 user.name/email 失败。
      # 与 mvp/app/bootstrap.mjs 的取值保持一致。
      git -C "$SRC" config user.name "electronics-superagent"
      git -C "$SRC" config user.email "agent@example.com"
      exclude_migration
      git -C "$SRC" add -A
      git -C "$SRC" commit -q -m "chore(migration): ${CODE} 存量快照（原样，未整理）" \
        || warn "快照提交失败（缺 git 身份）。文件已暂存，请配好 user.name/user.email 后执行：
           git -C \"$SRC\" commit -m 'chore(migration): ${CODE} 存量快照（原样，未整理）'"
    }
  elif [[ ! -d "$SRC/.git" ]]; then
    warn "源目录不是 Git 仓库；建议加 --git-init 先做快照（docs/10 §2）"
  fi

  # 既有仓库同样把迁移产物排除在外（幂等）
  if [[ -d "$SRC/.git" && $DRY -eq 0 ]]; then exclude_migration; fi

  # 1) 骨架加装：只写缺失文件
  graft() {
    local src="$1" dst="$2"
    if [[ -e "$dst" ]]; then
      if cmp -s "$src" "$dst" 2>/dev/null; then
        n_skip=$((n_skip + 1))
      else
        local alt="${dst}.platform-new"
        log "冲突：$(rel "$dst") 已存在且内容不同 → 写 $(basename "$alt")"
        [[ $DRY -eq 0 ]] && { cp "$src" "$alt"; printf '%s\n' "${alt#"$SRC"/}" >> "$manifest"; }
        n_conflict=$((n_conflict + 1))
      fi
    else
      log "新增：${dst#"$SRC"/}"
      [[ $DRY -eq 0 ]] && { mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"; printf '%s\n' "${dst#"$SRC"/}" >> "$manifest"; }
      n_add=$((n_add + 1))
    fi
  }

  [[ $DRY -eq 0 ]] && mkdir -p "$SRC/docs/_index"

  while IFS= read -r -d '' f; do
    local rp dst
    rp="${f#"$SCAFFOLD"/}"
    # manifest.yml 需要替换代号，单独处理
    if [[ "$rp" == ".superagent/manifest.yml" ]]; then continue; fi
    dst="$SRC/$rp"
    graft "$f" "$dst"
  done < <(find "$SCAFFOLD" -type f -not -name ".gitkeep" -print0)

  # 2) manifest.yml：代号替换后写入
  if [[ -f "$SCAFFOLD/.superagent/manifest.yml" ]]; then
    local mtpl="$SCAFFOLD/.superagent/manifest.yml" mdst="$SRC/.superagent/manifest.yml"
    [[ $DRY -eq 0 ]] && mkdir -p "$SRC/.superagent"
    if [[ ! -e "$mdst" ]]; then
      log "新增：.superagent/manifest.yml（code=$CODE, stages=[$STAGES]）"
      [[ $DRY -eq 0 ]] && {
        local en_yaml name customer platform owner code_lower
        en_yaml="[$(printf '%s' "$STAGES" | sed 's/,/, /g')]"
        name="${PNAME:-$CODE}"
        customer="${PCUSTOMER:--}"
        platform="${PPLATFORM:-${CODE:0:3}}"
        owner="${POWNER:--}"
        code_lower="$(printf '%s' "$CODE" | tr '[:upper:]' '[:lower:]')"
        # 与 mvp/app/bootstrap.mjs 的占位符集合保持一致，避免遗留 {{NAME}} 之类的空模板
        sed -e "s/{{CODE}}/${CODE}/g" \
            -e "s/{{codeLower}}/${code_lower}/g" \
            -e "s/{{NAME}}/${name}/g" \
            -e "s/{{CUSTOMER}}/${customer}/g" \
            -e "s/{{PLATFORM}}/${platform}/g" \
            -e "s/{{OWNER_NAME}}/${owner}/g" \
            -e "s|^  enabled: .*|  enabled: ${en_yaml}                    # 按 APQP 实际进度增加，须与 docs/ 下已建阶段一致|" \
            "$mtpl" > "$mdst"
        printf '%s\n' ".superagent/manifest.yml" >> "$manifest"
      }
      n_add=$((n_add + 1))
    else
      warn ".superagent/manifest.yml 已存在，未覆盖；请手工核对 code 与 stages.enabled=[$STAGES]"
      n_skip=$((n_skip + 1))
    fi
  fi

  # 2) 文档模板副本：平台 templates/ → docs/_templates/（只读，随平台升级）
  local tpl_dir="$SCRIPT_DIR/../templates"
  if [[ -d "$tpl_dir" ]]; then
    local n_tpl=0
    while IFS= read -r -d '' tf; do
      local tbase tdst
      tbase="$(basename "$tf")"
      tdst="$SRC/docs/_templates/$tbase"
      if [[ ! -e "$tdst" ]]; then
        [[ $DRY -eq 0 ]] && { mkdir -p "$SRC/docs/_templates"; cp "$tf" "$tdst"; printf '%s\n' "${tdst#"$SRC"/}" >> "$manifest"; }
        n_tpl=$((n_tpl + 1))
      fi
    done < <(find "$tpl_dir" -maxdepth 1 -type f -name "*.md" -print0)
    [[ $n_tpl -gt 0 ]] && log "新增模板副本：$n_tpl 份 → docs/_templates/"
    n_add=$((n_add + n_tpl))
  fi

  # 3) 阶段目录（只建启用的）
  local s
  IFS=',' read -ra SARR <<< "$STAGES"
  for s in "${SARR[@]}"; do
    s="$(printf '%s' "$s" | tr -d ' ' | tr '[:lower:]' '[:upper:]')"
    case "$s" in
      S1) mkdirs="S1-策划/CHTR S1-策划/SRS S1-策划/APQP S1-策划/FEAS" ;;
      S2) mkdirs="S2-产品设计/DFMEA S2-产品设计/DVP S2-产品设计/SC" ;;
      S3) mkdirs="S3-过程设计/PFC S3-过程设计/PFMEA S3-过程设计/CP" ;;
      S4) mkdirs="S4-验证/MSA S4-验证/SPC S4-验证/TR S4-验证/PPAP S4-验证/TEST" ;;
      S5) mkdirs="S5-量产/8D S5-量产/ECN" ;;
      *)  die "非法阶段：$s（可选 S1..S5）" ;;
    esac
    for d in $mkdirs; do
      if [[ ! -d "$SRC/docs/$d" ]]; then
        [[ $DRY -eq 0 ]] && {
          mkdir -p "$SRC/docs/$d"
          touch "$SRC/docs/$d/.gitkeep"
          printf '%s\n' "docs/$d/.gitkeep" >> "$manifest"
        }
        log "新增目录：docs/$d"
      fi
    done
  done

  # 4) sidecar 落到原文件旁边（不改原文件）
  if [[ -d "$OUT/sidecars" ]]; then
    local n_sc=0
    while IFS= read -r -d '' sc; do
      local target
      target="$SRC/${sc#"$OUT/sidecars/"}"
      target="${target%.meta.yml}.meta.yml"
      if [[ ! -e "$target" ]]; then
        [[ $DRY -eq 0 ]] && { mkdir -p "$(dirname "$target")"; cp "$sc" "$target"; printf '%s\n' "${target#"$SRC"/}" >> "$manifest"; }
        n_sc=$((n_sc + 1))
      fi
    done < <(find "$OUT/sidecars" -type f -name "*.meta.yml" -print0 2>/dev/null)
    [[ $n_sc -gt 0 ]] && log "落位 sidecar：$n_sc 份"
  fi

  printf '\n加装结果：新增 %s / 冲突 %s / 已存在相同 %s\n' "$n_add" "$n_conflict" "$n_skip"
  [[ $n_conflict -gt 0 ]] && warn "有 $n_conflict 个冲突文件，请人工比对 *.platform-new 后决定保留哪份"
  printf '回滚依据：%s\n' "$manifest"
  printf '下一步：确认 import-map 后跑 --verify，再按 docs/10 §4 P4 建追溯\n'
}

# ---------------------------------------------------------------------------
# verify：校验加装与映射
# ---------------------------------------------------------------------------
do_verify() {
  local fail=0
  chk() { if [[ -e "$SRC/$1" ]]; then log "OK   $1"; else printf '  FAIL %s\n' "$1"; fail=1; fi; }

  printf '校验：%s\n' "$SRC"
  for p in .superagent/manifest.yml .superagent/rules.yml .superagent/taxonomy.yml \
           .gitattributes docs/_index/documents.csv docs/_index/traceability.csv \
           docs/_templates hardware/manifest.yml; do
    chk "$p"
  done

  # import-map：路径存在性 + assetId 唯一性
  local map="$SRC/docs/_index/import-map.csv"
  if [[ -f "$map" ]]; then
    local rows bad=0 dup=0
    rows=$(( $(wc -l < "$map") - 1 ))
    log "import-map：$rows 行"
    bad="$(tail -n +2 "$map" | awk -F',' 'NF>=1 && $1!="" {print $1}' | tr -d '"' | while IFS= read -r p; do
      if [[ -n "$p" && ! -e "$SRC/$p" ]]; then printf '%s\n' "$p"; fi
    done | wc -l | tr -d ' ')"
    dup="$(tail -n +2 "$map" | awk -F',' '$2!="" {print $2}' | tr -d '"' | sort | uniq -d | wc -l | tr -d ' ')"
    if [[ "$bad" -gt 0 ]]; then printf '  FAIL %s 条 oldPath 在磁盘上不存在\n' "$bad"; fail=1; else log "OK   全部 oldPath 存在"; fi
    if [[ "$dup" -gt 0 ]]; then printf '  FAIL %s 个 assetId 重复\n' "$dup"; fail=1; else log "OK   assetId 无重复"; fi
  else
    warn "未找到 docs/_index/import-map.csv（原地加装模式可忽略，纯新项目也无需此文件）"
  fi

  # 硬件二进制是否已在 LFS / manifest 中登记
  if [[ -f "$SRC/hardware/manifest.yml" ]] && command -v git >/dev/null 2>&1 && [[ -d "$SRC/.git" ]]; then
    if git -C "$SRC" lfs ls-files >/dev/null 2>&1; then
      local lfsn; lfsn="$(git -C "$SRC" lfs ls-files 2>/dev/null | wc -l | tr -d ' ')"
      [[ "$lfsn" -gt 0 ]] && log "OK   LFS 已跟踪 $lfsn 个文件" || warn "LFS 未跟踪任何文件，检查 .gitattributes 与 git add 顺序"
    fi
  fi

  printf '\nRESULT: %s\n' "$([[ $fail -eq 0 ]] && echo PASS || echo FAIL)"
  return $fail
}

case "$MODE" in
  scan)    do_scan ;;
  plan)    do_plan ;;
  apply)   do_apply ;;
  verify)  do_verify ;;
esac
