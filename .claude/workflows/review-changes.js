export const meta = {
  name: 'review-changes',
  description: '差分を複数次元で並列レビューし、敵対的検証を通った所見のみ報告',
  whenToUse:
    '実装後の差分レビュー。args: {base: "main"} で比較先ブランチを指定(省略時は config.baseBranch)、{config: {...}} で workflow config を直接渡せる。未コミット変更も含めてレビューする',
  phases: [
    { title: '準備', detail: 'workflow config の読み込みと Codex 利用可否の検出' },
    { title: 'レビュー', detail: '複数次元の並列レビュー' },
    { title: '検証', detail: '所見ごとの敵対的検証' },
  ],
}

// モデル使い分けの方針: レビュー = config.models.review / 敵対的検証・クラスタリング = config.models.verify /
// Codex の検出・実行 = config.models.codex / 変更マップ = config.models.bootstrap。既定と effort は modelAndEffort を参照。
//
// 'opus' 等のティア名エイリアスは Anthropic API では最新版に解決されるため、
// 特定バージョンに固定したい場合は config にエイリアスではなく完全なモデル名を指定する
// (https://code.claude.com/docs/ja/model-config#pin-models-for-third-party-deployments)。

// args は JSON 文字列で渡ってくる場合があるためパースする
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    input = { base: input }
  }
}
input = input || {}

/**
 * agent() に役割マーカーを付けて起動する。マーカー `[crw:role=<役割>]` は**プロンプト末尾**(可変部)に
 * 置くので、兄弟エージェントの前方一致キャッシュには影響しない。transcript から工程別の消費を集計する
 * engine/tools/usage-report.py がこれを読む(meta.json はランタイム所有で label を書き出せないため、
 * 従来はプロンプトのキーワード推測で役割を分けており、ガード検査を「Gate 0.5 audit」と誤分類していた)。
 */
// 実起動数。0.6.0 で全ワークフローが agentsUsed を返す設計にしたが、このファイルだけ実装が漏れており、
// run-release は「次元数 + 確定所見数」の推定で数えていた(Codex 1 本化で次元体を起動しない周は
// この推定が大きく外れる)。agent() は必ず roleAgent 経由で呼ぶ
let agentsUsed = 0
function roleAgent(prompt, opts) {
  agentsUsed += 1
  const { role, ...rest } = opts || {}
  return agent(`${prompt}\n\n[crw:role=${role || 'other'}]`, rest)
}

/**
 * 役割(config.models のキー)に対するモデルと effort を決め、agent() のオプションへ spread する形で返す。
 *
 * モデルは config.models[role] を優先し、無ければ下の既定表に倒す。effort も config.efforts[role] を優先する。
 * 判断が要る役割だけ opus + high にし、量の多い実装・調査・文書は sonnet、転記と実行だけの工程は haiku にする
 * (全部 opus にすると 1 リリースの費用が 3〜4 割増える一方、判断系だけなら数 % で済む)。
 * haiku 系には effort キー自体を付けない: API の Haiku 4.5 は effort を受け付けず、Workflow ランタイムは
 * 黙って落とすことを実測で確かめたが、完全 ID 指定時の挙動は未確認で、journal にも実態と違う値を残したくない。
 * workflow スクリプトは import できないため全ワークフローに同じ本文を複製し、バイト一致をテストで固定している。
 * 外側の変数を参照しないこと(テストが本文を切り出して単体で実行する)。
 *
 * @param {string} role 役割名。既定表に無い名前は打ち間違いとみなして throw する
 * @param {object} [models] config.models
 * @param {object} [efforts] config.efforts
 * @returns {{model: string, effort?: string}}
 */
function modelAndEffort(role, models, efforts) {
  const DEFAULTS = {
    design: ['opus', 'high'],
    verify: ['opus', 'high'],
    fix: ['opus', 'high'],
    review: ['opus', 'high'],
    implementHigh: ['opus', 'high'],
    implementMid: ['sonnet', 'medium'],
    explore: ['sonnet', 'medium'],
    docSync: ['sonnet', 'medium'],
    implementLow: ['sonnet', 'low'],
    codex: ['sonnet', 'low'],
    check: ['haiku', 'low'],
    bootstrap: ['haiku', 'low'],
  }
  const fallback = DEFAULTS[role]
  if (!fallback) throw new Error(`modelAndEffort: 未知の役割 ${role}`)
  const model = (models && models[role]) || fallback[0]
  const effort = (efforts && efforts[role]) || fallback[1]
  if (/(^|-)haiku(-|$)/.test(model)) return { model }
  return { model, effort }
}

phase('準備')

// config ブートストラップ: args.config を優先し、未指定時は .claude/workflow.config.json をエージェント経由で読む
let config = input.config
if (!config) {
  const loaded = await roleAgent(
    'カレントリポジトリの .claude/workflow.config.json を読んでください。存在すれば {exists: true, config: <ファイル内容そのまま>} を、無ければ {exists: false} を返すこと。内容の要約・省略・補完は禁止。',
    {
      label: 'config-bootstrap',
      role: 'config',
      phase: '準備',
      schema: {
        type: 'object',
        required: ['exists'],
        properties: {
          exists: { type: 'boolean' },
          config: { type: 'object' },
        },
      },
      model: 'haiku',
    }
  )
  if (!loaded || loaded.exists === false || !loaded.config) {
    throw new Error(
      'workflow.config.json が読めません。args.config を渡すか .claude/workflow.config.json を作成してください'
    )
  }
  config = loaded.config
}
if (config.configVersion !== 1) {
  throw new Error(
    `workflow.config.json の configVersion がエンジン要求版と一致しません (要求: 1, 実際: ${config.configVersion})`
  )
}

// レビュー次元は config.reviewDimensions から取得する(観点の増減はプロジェクト側の config で行う)
const DIMENSIONS = Array.isArray(config.reviewDimensions) ? config.reviewDimensions : []
if (DIMENSIONS.length === 0) {
  throw new Error('config.reviewDimensions が空です。レビュー次元を workflow.config.json に定義してください')
}

const MODELS = config.models || {}
const EFFORTS = config.efforts || {}

const base = input.base || config.baseBranch || 'main'

// diffPathScope: args.diffPathScope を最優先、未指定(null/undefined)時は config.diffPathScope を既定、
// 両方 null/未指定なら全差分。文字列は単一要素配列に正規化する。
let diffPathScope = input.diffPathScope !== undefined && input.diffPathScope !== null
  ? input.diffPathScope
  : config.diffPathScope
if (typeof diffPathScope === 'string') {
  diffPathScope = [diffPathScope]
}
if (!Array.isArray(diffPathScope) || diffPathScope.length === 0) {
  diffPathScope = null
}

// requirementsPaths: 要件ファイル(run-release が渡す)。要件書もレビュー対象だが、指摘の型と扱いを分ける:
// - 指摘は「要件同士の矛盾」「検証できない受け入れ基準」「実装との食い違い(実装側を対象に報告)」に限る。
//   「文面にその保証が書かれていない」型は出させない(導入先でこの型が要件書への指摘 10 件中 7 件を占め、
//   すべて検証で退けられたが、毎周出直して検証体を起動させていた)
// - 検証を通った指摘は confirmed ではなく requirementFindings で返す。修正ループには入れず人の判断へ回す
//   (修正体に渡すと要件書を書き換えて「解消」してしまう。別の導入先で発生)
// requirementsReviewed: 要件書はこの run で既にレビュー済みで、その後変わっていない(run-release のガードが
// 修正による書き換えを戻している)。この周は要件書への指摘を検証せずに数えるだけにする
const requirementsPaths = (Array.isArray(input.requirementsPaths) ? input.requirementsPaths : [])
  .map(p => String(p).trim().replace(/^\.\//, '').replace(/\/$/, ''))
  .filter(Boolean)
const requirementsReviewed = input.requirementsReviewed === true && requirementsPaths.length > 0

/**
 * ツール使用方針。**全エージェントプロンプトの先頭**に置く共有ブロック。
 *
 * 位置が重要な理由が 2 つある:
 * (1) 兄弟エージェントのプロンプト前方一致キャッシュに載せるため(可変部は必ず末尾へ置く)。
 * (2) 実行環境の permissions.defaultMode が "auto" の場合、ランタイムが全サブエージェントへ
 *     「ファイルは cat / sed -n で読み、検索は grep で」という方針を注入する。bash の tool_result は
 *     サイズ上限も読み込み追跡も無く**以後の全ターンへ再送され続ける**ため、ターン数の二乗で
 *     コンテキストが膨らむ。実測(190 エージェント)では Bash 3,718 回 9.80MB に対し Read は 306 回で、
 *     tool_result 総量の 81% が bash 由来だった。ここで方針を上書きして打ち消す。
 *
 * 導入先の settings.json で defaultMode を変えるのは**やってはいけない** — プロジェクト設定は
 * ユーザー設定に優先するため、auto を外すと無人実行中の検査コマンドが許可プロンプトで停止する。
 */
const TOOL_POLICY = `## ツール使用方針(このワークフロー固有。他の既定方針より優先する)

- ファイル内容の取得は **Read ツール**を使う。cat / head / tail / sed -n でファイルを標準出力へ出さない
- コード検索は **Grep ツール**、ファイル一覧は **Glob ツール**を使う。bash の grep / find / ls で代替しない
- Bash は git 操作・検査コマンド・ビルドなど「実行そのものが目的」の場合に限る
- Bash を使う場合も出力は必ず絞る(\`--stat\` / \`--name-only\` / \`| head -50\` 等)。全文を標準出力へ出さない

理由: bash の出力はサイズ上限も重複読み込みの追跡も無く、以後の全ターンへ再送され続ける。

`

/**
 * エンジンの内部の言い方 → 読者(PR のレビュアー・既知課題を読む人・次のリリースの要件を詰める人)に通じる言い方。
 * 執筆規則(WRITING_POLICY)と機械検査(lintProse)が同じ表を使う。README と development-workflow.md.tmpl の
 * 用語集にも同じ語を載せる(テストで固定)。known-issues の書式語(起票日・場所・現象・対応方針・由来)は正規の語なので入れない。
 * 文章を書く体があるワークフローに同じ本文を複製し、バイト一致をテストで固定している。
 */
const INTERNAL_TERMS = [
  // 検出はエンジン特有の言い回しに絞る(「残存リスク」「次の周期」「署名済み」「数値計算の収束」「バックグラウンド」など
  // 普通の日本語に当てないため。導入先 9 件の known-issues と PR 本文で較正した)
  ['残存', /残存(所見|指摘)|試行後も残存|失敗(のまま|が)残存|[・(（]残存[)）]|未検証で残存/, '修正されずに残った'],
  ['収束不能・収束しない', /収束不能|収束しませんでした|収束せず/, '同じ失敗が繰り返されたので自動修正を打ち切った'],
  ['Gate 0', /Gate ?0(?![.\d])/, '開始前の事前検査'],
  ['Gate 0.5', /Gate ?0\.5/, '実装結果と実際の差分の突き合わせ'],
  ['Gate 1', /Gate ?1/, '検査と修正の繰り返し'],
  ['Gate 2', /Gate ?2/, 'レビューと修正の繰り返し'],
  ['失敗署名', /失敗署名|失敗の署名|同一署名/, '失敗の中身(検査名と失敗箇所)'],
  ['周', /(\d+ ?周目|(前|次|この|同じ)の?周|した周)(?![期回辺波知年囲到])/, '(レビューの)回'],
  ['ラウンド', /((前|次|この|各|同じ)の?ラウンド|\d+ ?ラウンド|ラウンド ?\d)(?!トリップ)/, '(レビューの)回'],
  ['修正体・修正エージェント', /修正体|修正エージェント/, '自動修正'],
  ['検証体・検証エージェント', /検証体|検証エージェント/, '指摘の裏取り'],
  ['block / fixOnce / backlogOnly', /\bblock 所見|\bfixOnce\b|\bbacklogOnly\b/, '必ず直す指摘 / 1 回だけ直す指摘 / 起票だけする指摘'],
  [
    '戻り値のフィールド名',
    /\b(residualFindings|fixWaived|draftReasons|reportMaterial|prMaterial|carriedBlock|unverifiableDimensions|requirementEdits|requirementIssues|manualPendingAcs|unmetAcs|syncUnverified|reviewPrecision|severityChanges)\b/,
    'その中身を表す日本語(例: 修正されずに残った指摘)',
  ],
]

/**
 * 文章を書く体(PR 本文・既知課題の起票・文書同期・コミットメッセージ・レビューの指摘・修正の申告理由)に付ける執筆規則。
 * TOOL_POLICY の直後、可変部より前に置く(前方一致キャッシュに載せるため)。望む水準を条件と確かめ方で書く。
 */
const WRITING_POLICY = `## 文章の書き方(読む人が、この文書だけで状況を把握し次の行動を決められるように)

- 対象は実名で書く: 相対パス・関数名・設定キー・コマンド。「関連箇所」「当該処理」で済ませない
- 最初の 1 文で、どの条件で起きるのか(成り立つのか)を書く。背景や経緯は後に回す
- 数値は「何をして → 何が → どれだけ」の形にする(例: 「npm test を実行すると 3 件が timeout で失敗する」)
- 専門用語は初出で 1 句の言い換えを添える
- 指示語(これ・この・それ・当該・上記)は、直前の文の名詞を指す場合だけ使う。節の最初の文では使わない
- 評価語(問題ない・適切・改善した)だけの文にしない。何を確かめたからそう言えるのかを書く
- 「該当なし」(調べて無かった)と「取得できず」(調べられなかった)を区別する
- 推測を書くときは「推測:」と付け、根拠を添える
- ワークフローの内部の言い方を使わない。次の言い換えを使う:
${INTERNAL_TERMS.map(([term, , plain]) => `  - ${term} → ${plain}`).join('\n')}

`

/**
 * 読者向けの文章を機械的に検査し、違反の一覧を返す(空配列なら違反なし)。規則は WRITING_POLICY の一部だけを、
 * 誤検出が少ない形で持つ: 内部語(全種別)/ 節の最初の文の宙に浮いた指示語(title 以外)/ 既知課題の「現象」に
 * パス・コマンド・バッククォートのどれも無い(known-issue のみ)。外側の変数は INTERNAL_TERMS だけを参照する。
 *
 * @param {string} text 検査する文章
 * @param {'pr'|'known-issue'|'doc'|'title'} kind 文章の種類
 * @returns {{rule: string, excerpt: string, hint: string}[]}
 */
function lintProse(text, kind) {
  const out = []
  const src = String(text || '')
  // コードブロックとインラインコードの中は検査しない(設定キーやコマンドとしての言及は正当)
  const prose = src
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
  const lines = prose.split('\n')
  for (const [term, re, plain] of INTERNAL_TERMS) {
    const hit = lines.find(l => re.test(l))
    if (hit) out.push({ rule: 'internal-term', excerpt: hit.trim().slice(0, 120), hint: `「${term}」→「${plain}」` })
  }
  if (kind !== 'title') {
    // 節の最初の文(文書の先頭、または見出しの直後の最初の本文行)だけを見る。文中の「この」は普通の日本語
    let expectFirst = true
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      if (/^#{1,6} /.test(line) || /^\|/.test(line)) {
        expectFirst = /^#{1,6} /.test(line)
        continue
      }
      if (expectFirst) {
        const body = line.replace(/^([-*]|\d+\.)\s+/, '')
        if (/^((これ|この|それ|その)(?!ぞれ|他|の他|まで|周期)|当該|上記)/.test(body)) {
          out.push({ rule: 'dangling-reference', excerpt: line.slice(0, 120), hint: '節の最初の文では、指す対象を実名で書く' })
        }
        expectFirst = false
      }
    }
  }
  if (kind === 'known-issue') {
    for (const m of src.matchAll(/^- 現象: (.*)$/gm)) {
      const body = m[1]
      if (!/`|[\w.-]+\/[\w./-]+|\b[\w-]+\.[a-z]{1,5}\b|\b[a-z]+[A-Z]\w*\b|\b[a-z]+_[a-z_]+\b|\b(npm|pnpm|yarn|npx|node|git|gh|cargo|go|python3?|make|bash)\b/.test(body)) {
        out.push({ rule: 'no-concrete-target', excerpt: body.slice(0, 120), hint: '現象に、ファイルのパス・コマンド・コードの名前のどれかを書く' })
      }
    }
  }
  return out
}

// 変更マップの返り値。hunk ヘッダは 0.7.0 で外した — 79 ファイル分の hunk を並べた目次が 21.6k 字になり、
// レビュー・検証の全プロンプトに毎ターン再送されていた。hunk の位置は patch を Read すれば分かる
const CHANGEMAP_SCHEMA = {
  type: 'object',
  required: ['dir', 'manifest', 'consistent', 'trackedCount', 'untrackedCount'],
  properties: {
    dir: { type: 'string', description: '生成物を置いた絶対パス' },
    consistent: {
      type: 'boolean',
      description: 'manifest の追跡ファイル集合が git diff --name-only と一致したか',
    },
    untracked: { type: 'array', items: { type: 'string' } },
    trackedCount: { type: 'number', description: 'スクリプトが数えた追跡ファイルの変更件数(manifest の照合に使う)' },
    untrackedCount: { type: 'number', description: 'スクリプトが数えた未追跡ファイルの件数(manifest の照合に使う)' },
    manifest: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'patchPath'],
        properties: {
          path: { type: 'string' },
          added: { type: ['number', 'null'] },
          deleted: { type: ['number', 'null'] },
          patchPath: { type: 'string', description: 'このファイル単独の差分を書き出した絶対パス' },
          untracked: { type: 'boolean', description: '未追跡(新規)ファイルなら true' },
        },
      },
    },
  },
}

/**
 * 変更マップ生成スクリプト。__DIR__(出力先のシェル式)と __BASE__(基底ブランチ)を差し替えて使う。
 *
 * **1 回の bash 呼び出しで完結させる**のが要点。従来は手順書きで渡していたため、エージェントが
 * 1 ファイル 1 コマンドで回し、再生成を兼ねるガード検査が平均 67 ターン・最大 108 ターン(7 体で 52M)、
 * 初回生成も 46 ターンを消費していた。
 *
 * 未追跡(新規)ファイルは `git diff --no-index /dev/null <f>` で patch 化して diff.patch へ連結する。
 * intent-to-add(`git add -N`)は `git stash create` を壊す(実測: "Cannot save the current worktree state")ので
 * index には触れない。`--no-index` は差分があると exit 1 を返すため `set -e` の下では回さない。
 * run-release.js と同一内容(テストでバイト一致を固定)。
 */
const CHANGE_MAP_SCRIPT = String.raw`DIR=__DIR__
BASE=__BASE__
mkdir -p "$DIR/by-file" && rm -f "$DIR"/by-file/*.patch
MB=$(git merge-base "$BASE" HEAD 2>/dev/null) || MB=$(git merge-base "origin/$BASE" HEAD 2>/dev/null) || MB=""
if [ -z "$MB" ]; then
  printf '{"dir":"%s","consistent":false,"untracked":[],"trackedCount":0,"untrackedCount":0,"manifest":[]}\n' "$DIR" > "$DIR/manifest.json"
  echo "merge-base unresolved (consistent=false). manifest: $DIR/manifest.json"
  exit 0
fi
G="git -c core.quotePath=false"
$G diff --no-renames "$MB" > "$DIR/diff.patch"
$G ls-files --others --exclude-standard > "$DIR/untracked.txt"
$G diff --name-only --no-renames "$MB" > "$DIR/tracked.txt"
: > "$DIR/manifest-paths.txt"
jstr() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
jnum() { case "$1" in ''|*[!0-9]*) printf 'null';; *) printf '%s' "$1";; esac; }
i=0
{
  printf '{"dir":"%s","untracked":[' "$(jstr "$DIR")"
  first=1
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ $first -eq 1 ] || printf ','
    first=0
    printf '"%s"' "$(jstr "$p")"
  done < "$DIR/untracked.txt"
  printf '],"manifest":['
  first=1
  while IFS=$'\t' read -r added deleted path; do
    [ -n "$path" ] || continue
    i=$((i+1))
    $G diff --no-renames "$MB" -- "$path" > "$DIR/by-file/$i.patch"
    printf '%s\n' "$path" >> "$DIR/manifest-paths.txt"
    [ $first -eq 1 ] || printf ','
    first=0
    printf '{"path":"%s","added":%s,"deleted":%s,"patchPath":"%s"}' "$(jstr "$path")" "$(jnum "$added")" "$(jnum "$deleted")" "$(jstr "$DIR/by-file/$i.patch")"
  done < <($G diff --numstat --no-renames "$MB")
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    i=$((i+1))
    if [ "$(wc -c < "$p" | tr -d ' ')" -gt 1000000 ]; then
      printf '(patch omitted: %s exceeds 1MB)\n' "$p" > "$DIR/by-file/$i.patch"
      lines=null
    else
      $G diff --no-index -- /dev/null "$p" > "$DIR/by-file/$i.patch"
      lines=$(wc -l < "$p" | tr -d ' ')
    fi
    cat "$DIR/by-file/$i.patch" >> "$DIR/diff.patch"
    [ $first -eq 1 ] || printf ','
    first=0
    printf '{"path":"%s","added":%s,"deleted":0,"patchPath":"%s","untracked":true}' "$(jstr "$p")" "$lines" "$(jstr "$DIR/by-file/$i.patch")"
  done < "$DIR/untracked.txt"
  printf '],"trackedCount":%s,"untrackedCount":%s' "$(wc -l < "$DIR/tracked.txt" | tr -d ' ')" "$(wc -l < "$DIR/untracked.txt" | tr -d ' ')"
  if cmp -s "$DIR/manifest-paths.txt" "$DIR/tracked.txt"; then printf ',"consistent":true}\n'; else printf ',"consistent":false}\n'; fi
} > "$DIR/manifest.json"
echo "manifest: $DIR/manifest.json (tracked $(wc -l < "$DIR/tracked.txt" | tr -d ' ') / untracked $(wc -l < "$DIR/untracked.txt" | tr -d ' '))"
`

/** スクリプトの出力先と基底ブランチを差し替える。dirExpr はシェル式(クォート込み)、base はブランチ名。 */
function changeMapScript(dirExpr, base) {
  return CHANGE_MAP_SCRIPT.replace('__DIR__', dirExpr).replace('__BASE__', JSON.stringify(base))
}

/**
 * 変更マップ体の戻り値を検証し、使ってよいものだけを返す。run-release.js と同一内容(テストでバイト一致を固定)。
 *
 * エージェントの申告をそのまま信じない理由(いずれも導入先で発生):
 * - dir にリポジトリのルートが返り、それを出力先に使った Codex の結果がリポジトリ直下へ書かれた
 * - manifest を読み切れずに転記し、存在しないファイルを含む manifest を consistent: true で返した
 *
 * @param cm 変更マップ体の戻り値。
 * @param expectedDir エンジンが指定した出力先の絶対パス。シェル式で渡して値が分からないときは null。
 * @param reasons 使えなかった理由の書き出し先(配列)。
 * @returns 使ってよければ cm、使えなければ null。
 */
function validChangeMap(cm, expectedDir, reasons) {
  const why = []
  if (!cm || cm.consistent !== true || !Array.isArray(cm.manifest)) {
    why.push('consistent が true でない、または manifest が配列でない')
  } else {
    const dir = typeof cm.dir === 'string' ? cm.dir.trim().replace(/\/+$/, '') : ''
    if (!dir.startsWith('/') || /["'`$\\\n]/.test(dir)) {
      why.push(`dir が引用符等を含まない絶対パスではない(${String(cm.dir)})`)
    } else if (expectedDir && dir !== String(expectedDir).replace(/\/+$/, '')) {
      why.push(`dir(${dir})がエンジンの指定した出力先(${expectedDir})と違う`)
    } else if (cm.manifest.some((m) => !m || typeof m.patchPath !== 'string' || !m.patchPath.startsWith(`${dir}/by-file/`))) {
      why.push(`patchPath が ${dir}/by-file/ 配下を指していないエントリがある`)
    }
    const tracked = cm.manifest.filter((m) => m && m.untracked !== true).length
    const untracked = cm.manifest.filter((m) => m && m.untracked === true).length
    if (cm.trackedCount !== tracked || cm.untrackedCount !== untracked) {
      why.push(
        `manifest の件数(追跡 ${tracked} / 未追跡 ${untracked})がスクリプトの数えた件数(追跡 ${cm.trackedCount} / 未追跡 ${cm.untrackedCount})と一致しない`
      )
    }
  }
  if (why.length === 0) return cm
  if (Array.isArray(reasons)) reasons.push(...why)
  return null
}

/** 変更マップ生成の依頼文。スクリプトを分割実行させない・結果を手で組み立てさせないことが要点。 */
function changeMapAsk(script) {
  return (
    TOOL_POLICY +
    '変更マップを生成してください。カレント作業ディレクトリ(=リポジトリルート)で、次のスクリプトを**改変せず、そのまま 1 回の bash 呼び出しで**実行すること(手順に分けて実行しない・コマンドを推測で補わない・出力ファイルはリポジトリ外)。\n\n' +
    '```bash\n' +
    script +
    '```\n\n' +
    '実行後、スクリプトが最後に出力する「manifest: <絶対パス>」の manifest.json を Read し、その JSON をそのまま返すこと(内容の要約・省略・補完は禁止)。スクリプトが失敗した場合は consistent: false、manifest: [] で返すこと。'
  )
}

/**
 * 変更マップを 1 回だけ作る。差分の所在を各エージェントが独立に発見し直すのをやめさせるための土台。
 *
 * **diff の本文は返り値に含めない。** 巨大なペイロードは構造化出力の経路で切り詰められるため、
 * 本文はファイルへ書き出し、返すのはパスと目次(manifest)だけにする。
 * 生成物をリポジトリ内へ置かないのは、run-release の Gate0(クリーンツリー検査)と
 * implement-feature の捏造検知(未追跡ファイル走査)を壊さないため。
 */
async function buildChangeMap(tag) {
  const dirExpr = `"\${TMPDIR:-/tmp}/claude-release-workflow/$(basename "$(git rev-parse --show-toplevel)")/${tag}"`
  return await roleAgent(changeMapAsk(changeMapScript(dirExpr, base)), {
    label: `変更マップ:${tag}`,
    role: 'changemap',
    phase: '準備',
    schema: CHANGEMAP_SCHEMA,
    ...modelAndEffort('bootstrap', MODELS, EFFORTS),
  })
}

// 変更マップは args から受け取るのを優先する(run-release が工程間で使い回す)。単体実行時は自前で作る。
// consistent: false(照合に失敗した = 目次が信用できない)場合は使わず、従来どおり各エージェントに
// git diff を叩かせるほうへ倒す — 古い・不完全な目次を渡すと存在しない hunk を見に行かせてしまう。
const changeMapRejects = []
let changeMap = input.changeMap ? validChangeMap(input.changeMap, null, changeMapRejects) : null
if (input.changeMap && !changeMap) {
  log(`渡された変更マップは使いません: ${changeMapRejects.join(' / ')}`)
}
if (!changeMap) {
  changeMapRejects.length = 0
  changeMap = validChangeMap(await buildChangeMap('review'), null, changeMapRejects)
  if (!changeMap) {
    log(
      `変更マップを使えません(${changeMapRejects.join(' / ') || '結果なし'}) — 各エージェントが従来どおり git diff で差分を特定します`
    )
  }
}

/** manifest を表形式のテキストへ。差分の目次であって本文ではない(本文は patchPath の先にある)。 */
function renderManifest(cm) {
  const rows = cm.manifest.map(
    m => `- ${m.path}${m.untracked ? ' (新規)' : ''} (+${m.added ?? '?'} -${m.deleted ?? '?'}) → ${m.patchPath}`
  )
  // 旧版の変更マップ(未追跡ファイルを名前だけ持つもの)との互換: manifest に無い名前だけ補足する
  const extra = (Array.isArray(cm.untracked) ? cm.untracked : []).filter(
    u => !cm.manifest.some(m => m.path === u)
  )
  const untracked = extra.length > 0 ? `\n新規未追跡ファイル(patch なし): ${extra.join(', ')}` : ''
  return `全差分: ${cm.dir}/diff.patch\n変更ファイル ${cm.manifest.length} 件(新規ファイルの本文も patch に含む):\n${rows.join('\n')}${untracked}`
}

/** 変更マップの共有ブロック。無い場合は空文字(＝従来どおり各自が git diff を叩く)。 */
const CHANGE_MAP_BLOCK = changeMap
  ? `## 変更マップ(この run の差分。git diff を叩き直す必要はない)

${renderManifest(changeMap)}

各 patch は Read で読むこと。**差分の外にある呼び出し元・関連実装まで辿ってよい(むしろ辿ること)** —
この目次は差分の所在を示すだけで、調査範囲を差分内に限定するものではない。

`
  : ''

/** 所見の file("path:line" / "path:start-end" / "path")から、対応する manifest エントリを引く。 */
function manifestEntryFor(file) {
  if (!changeMap) return null
  const raw = String(file || '').split(':')[0].replace(/^\.\//, '')
  if (!raw) return null
  return (
    changeMap.manifest.find(m => m.path === raw) ||
    changeMap.manifest.find(m => m.path.endsWith(`/${raw}`) || raw.endsWith(`/${m.path}`)) ||
    null
  )
}

const DIFF = diffPathScope
  ? `カレント作業ディレクトリ(=リポジトリルート)でレビューする。レビュー対象は「${base} との差分 + 未コミットの変更」のうち、次のパスに限定する: ${diffPathScope.join(', ')}。git diff ${base}... -- ${diffPathScope.join(' ')} と、git status / git diff(未コミット分)も同じパスに絞って確認すること。`
  : `カレント作業ディレクトリ(=リポジトリルート)でレビューする。レビュー対象は「${base} との差分 + 未コミットの変更」。git diff ${base}... と git status / git diff で対象を確認すること。`

// Codex 連携の対象判定: config.codexReview.enabled のときは常に対象。
//
// 以前は「diffPathScope が非 null なら対象外」としていた(Codex CLI に --scope <path> 相当が
// 無いため)。しかし run-release の Gate2 は 2 巡目以降**必ず** diffPathScope を渡すので、
// 構造的に「round 1 だけ Codex・round 2 以降は全次元とも自力レビュー」という非一貫な状態に
// なっていた(実測: round 1 は 6/6 次元 Codex、round 2〜7 は 36 体すべて自力)。
// スコープが渡らない制約は「Codex には全差分を見せ、返ってきた所見をこちら側でパスで濾す」で
// 回避できる。絞り込みはエージェント側の指示とエンジン側のフィルタで二重化する。
const codexEligible = Boolean(config.codexReview && config.codexReview.enabled === true)
// run-release が「前の周で利用枠切れを検出した」と伝えてきた周は、検出も実行も省く。枠切れ自体は
// 即時に返る(実測: 中央値 4 秒)が、検出体 1 + 実行体 1 の起動の床(約 34k × 2)を毎周払う理由がない
const codexDisabled = input.codexDisabled === true

// Codex 利用可否の検出は準備フェーズの専用エージェント 1 回に集約する。従来は各次元プロンプト末尾の
// 任意手順だったため、(1)「作業ツリーがクリーン」前提により、コミットが最終工程まで発生しない
// run-release Gate2 では構造的に一度も Codex が使われず、(2) 任意のため各エージェントが正当に
// スキップでき、(3) 未試行と試行失敗が区別できなかった。検出失敗・利用不可は全次元自力レビューへの
// フォールバックであってエラーではない。
// 検出するのはプラグインが使えるか(run の途中では変わらない)だけ。作業ツリー・ブランチの状態は周ごとに
// 変わるので、実行体のスクリプトがシェルで判定する(0.8.x までは検出体に申告させていた)。
// run-release は最初の周の検出結果(戻り値の codexDetected)を以降の周へ渡し、検出体を毎周起動しない
const passedDetect =
  input.codexDetected &&
  typeof input.codexDetected === 'object' &&
  typeof input.codexDetected.available === 'boolean' &&
  (input.codexDetected.available !== true ||
    (typeof input.codexDetected.companionPath === 'string' && input.codexDetected.companionPath.length > 0))
    ? input.codexDetected
    : null
let codexDetect = null
if (codexEligible && !codexDisabled && passedDetect) {
  codexDetect = passedDetect
} else if (codexEligible && !codexDisabled) {
  codexDetect = await roleAgent(
    TOOL_POLICY +
    'OpenAI Codex CLI プラグインの利用可否を機械的に検出してください。読み取りと setup 実行のみで、リポジトリ・設定への変更は一切禁止。以下の手順の各コマンドは必ず実際に bash で実行し、実行していないコマンドの結果を推測・補完してはならない。手順:\n' +
      '0. Claude Code の設定ディレクトリは環境変数で切り替わる場合があるため、以降のパスは必ず bash の `"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"` 展開で解決すること(未設定なら ~/.claude)\n' +
      '1. `cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"` の enabledPlugins に "codex@<マーケットプレイス名>": true 形式のキーを探す(マーケットプレイス名は環境により異なるため固定文字列で照合しない)。無ければ {available: false, reason: "プラグイン未導入"} で終了\n' +
      '2. `cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json"` の plugins["codex@<マーケットプレイス名>"] から installPath を得る(値が配列なら最初の要素の installPath)。ファイルが無い・読めない・エントリが無い場合は `ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/<マーケットプレイス名>/codex/"*/ 2>/dev/null | sort -V | tail -1` で代替する。どちらでも得られなければ {available: false, reason: "インストールディレクトリ不明"}\n' +
      '3. <installPath>/scripts/codex-companion.mjs の存在を確認する。無ければ {available: false, reason: "codex-companion.mjs 不在"}\n' +
      '4. `node "<installPath>/scripts/codex-companion.mjs" setup --json` を実行する(この bash 呼び出しには明示的にタイムアウトを指定すること。目安 30000ms)。終了コード 0 かつ標準出力 JSON の .ready === true なら available: true、それ以外(タイムアウト・パース不能含む)は available: false とし reason に失敗内容を書く\n' +
      'available: true の場合は companionPath に codex-companion.mjs の絶対パスを返すこと。',
    {
      label: 'codex検出',
      role: 'codex-detect',
      phase: '準備',
      schema: {
        type: 'object',
        required: ['available', 'reason'],
        properties: {
          available: { type: 'boolean' },
          companionPath: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      // 機械タスクだが haiku ではなく codex 役割(既定 sonnet)を使う: 実測で haiku は手順を省き、
      // git status の表示を流用して状態を捏造した(0.8.x の branchState)
      ...modelAndEffort('codex', MODELS, EFFORTS),
    }
  )
}
const codexAvailable = Boolean(
  codexDetect &&
    codexDetect.available === true &&
    typeof codexDetect.companionPath === 'string' &&
    codexDetect.companionPath.length > 0
)
/** codexEligible なのに委譲しない場合の理由(log と戻り値の両方で使う)。利用可能時は null。 */
const codexUnavailableReason = codexAvailable
  ? null
  : codexDisabled
    ? typeof input.codexDisabledReason === 'string' && input.codexDisabledReason
      ? input.codexDisabledReason
      : '前のレビューの回で Codex の利用枠切れを検出したので、この run では以降の回で Codex を使わない'
    : !codexDetect
      ? '検出エージェントが結果を返しませんでした'
      : codexDetect.reason || '利用不可'
// モードは実行体のスクリプトがシェルで決める(CODEX_MODE_SCRIPT)。companion の working-tree モードは未コミット差分のみ、
// --base モードは merge-base 起点のコミット済み差分のみを見る排他仕様で、両方を 1 回でカバーする呼び出しは
// 存在しない(--base 指定は --scope より優先されるため併記も不可。--scope auto はクリーン時に config.baseBranch
// ではなく main/master/trunk を自動検出するため使わない)。レビュー契約は「base との差分 + 未コミットの変更」の
// 両方なので、両者が併存する場合は両モードを並列に実行して所見を統合する:
//   dirty && ahead → both / dirty && none → working-tree / クリーン → base
// merge-base が解決できない(shallow clone・base 未フェッチ等)ときは Codex を使わず自力レビューへ倒す —
// 「先行コミット無し」と取り違えると、コミット済み差分が所見ゼロのままレビューを素通りするため。
// 0.8.x まではこの状態を検出体(LLM)に申告させてエンジンで決めていたが、申告の誤り(haiku による捏造の前例あり)が
// そのまま片側差分の脱落になるので、コマンドの結果だけで決まるシェルへ移した。
// committedReviewed: コミット済みの差分はこの run の最初の周でレビュー済み(run-release は run の途中でコミットしない)。
// 2 周目以降の再レビューで --base も回すと、作業ツリーで直した箇所をコミット済みの旧い文面から再指摘する
// (導入先で観測)。作業ツリーに差分があるなら working-tree だけにする
const committedReviewed = input.committedReviewed === true
/** 実際に走ったモード(実行体が CRW_CODEX_MODE= の行から申告する)。走らなかった周は null。 */
let codexMode = null
if (codexEligible) {
  log(
    codexAvailable
      ? 'Codex 検出: 利用可能(モードは作業ツリーとブランチの状態から実行時に決める)'
      : `Codex 検出: 利用不可 — 全次元とも自力レビュー(理由: ${codexUnavailableReason})`
  )
}

const CODEX_RUN_SCHEMA = {
  type: 'object',
  required: ['mode', 'status', 'findings'],
  properties: {
    mode: {
      type: 'string',
      enum: ['both', 'working-tree', 'base', 'unknown'],
      description: 'スクリプト出力の CRW_CODEX_MODE= の値(そのまま写す)',
    },
    status: {
      type: 'string',
      enum: ['ok', 'quota_exhausted', 'failed'],
      description: 'ok=全コマンドの JSON から findings を取り出せた / quota_exhausted=利用枠切れ / failed=それ以外の失敗',
    },
    reason: { type: 'string', description: 'ok 以外のときの根拠(エラー文言の要点)' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        // failureScenario は必須にしない: 変換体が 1 件落としただけでスキーマ違反になり、その周の Codex 全体が失敗扱いになるため
        required: ['title', 'file', 'detail', 'severity'],
        properties: {
          title: { type: 'string' },
          file: { type: 'string', description: 'file:line 形式' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          failureScenario: { type: 'string', description: 'どういう条件で何が起きるか(body から抜き出す)' },
        },
      },
    },
  },
}

/**
 * Codex 実行体に渡すシェルスクリプト。モードの決定(上のコメント参照)と、両モードの並列実行までをシェルで行う。
 * 両モードを逐次に回すと 600 秒の上限に当たって自力レビューへ落ちることがあったので `&` と `wait` で並べる。
 * `__FOCUS__` は呼び出し側で観点の本文に置き換える(ヒアドキュメントなので展開されない)。
 * 外側の変数を参照しないこと(テストが本文を切り出して bash で実走させる)。
 *
 * @param {string} outDir 出力先のシェル式(引用符込み)
 * @param {string} companionPath codex-companion.mjs の絶対パス
 * @param {string} base 比較対象のブランチ
 * @param {boolean} committedReviewed コミット済み差分を最初の周でレビュー済みか(true なら dirty 時に --base を回さない)
 */
function codexModeScript(outDir, companionPath, base, committedReviewed) {
  const node = `node ${JSON.stringify(companionPath)} adversarial-review --json`
  return [
    `OUT=${outDir}`,
    // 前回の出力を消す: 残った codex-base.err の "usage limit" で、base を走らせない周まで枠切れと誤判定しうる
    'mkdir -p "$OUT" && rm -f "$OUT"/codex-*.json "$OUT"/codex-*.err',
    // 観点の本文はファイルへ書いてから読む。`FOCUS=$(cat <<'EOF' …)` の形は、本文に対にならない ' や ` があると
    // bash 3.2(macOS 標準)が構文エラーにする(0.7.0〜0.8.x。棄却理由や観点の文面にアポストロフィが入るだけで Codex が落ちた)
    `cat > "$OUT/codex-focus.txt" <<'CODEX_FOCUS_EOF'`,
    '__FOCUS__',
    'CODEX_FOCUS_EOF',
    'FOCUS=$(cat "$OUT/codex-focus.txt")',
    `BASE=${JSON.stringify(base)}`,
    'DIRTY=$(git status --porcelain | head -c 1)',
    'MB=$(git merge-base "$BASE" HEAD 2>/dev/null || git merge-base "origin/$BASE" HEAD 2>/dev/null)',
    'if [ -z "$MB" ]; then AHEAD=unknown; elif [ -n "$(git log --oneline "$MB"..HEAD | head -c 1)" ]; then AHEAD=yes; else AHEAD=no; fi',
    'RUN_WT=; RUN_BASE=',
    `if [ -n "$DIRTY" ]; then RUN_WT=1; if [ "$AHEAD" = yes ] && [ ${committedReviewed ? 1 : 0} = 0 ]; then RUN_BASE=1; fi; else RUN_BASE=1; fi`,
    'if [ "$AHEAD" = unknown ]; then',
    '  echo "CRW_CODEX_MODE=unknown"',
    'else',
    `  [ -n "$RUN_WT" ] && { ${node} --scope working-tree "$FOCUS" > "$OUT/codex-wt.json" 2> "$OUT/codex-wt.err"; echo "working-tree exit=$?"; } &`,
    `  [ -n "$RUN_BASE" ] && { ${node} --base "$BASE" "$FOCUS" > "$OUT/codex-base.json" 2> "$OUT/codex-base.err"; echo "base exit=$?"; } &`,
    '  wait',
    '  if [ -n "$RUN_WT" ] && [ -n "$RUN_BASE" ]; then echo "CRW_CODEX_MODE=both"; elif [ -n "$RUN_WT" ]; then echo "CRW_CODEX_MODE=working-tree"; else echo "CRW_CODEX_MODE=base"; fi',
    'fi',
    'head -c 600 "$OUT"/codex-*.err 2>/dev/null || true',
  ].join('\n')
}

/**
 * Codex の一次レビューを **1 周 1 体・1〜2 コマンド**で実行する(0.7.0 M2)。
 *
 * 従来は次元ごとの opus レビュー体が各自で Codex を呼んでおり(6 次元 × wt+base = 12 回/周)、
 * Codex 側は同じ差分を 12 回読んで利用枠を 1 周目で使い切り、2 周目以降は全次元が自力レビュー
 * (59〜109 ターン/体)へ倒れていた。Codex は差分全体を 1 回読んで多観点で指摘するほうが得意で、
 * 次元分割は Claude 側の並列化の都合にすぎない。全次元の観点を 1 つの focus text に連結して渡し、
 * 所見の次元付けはクラスタリング体に同居させる。
 *
 * 成否は **stdout の JSON が parse でき `.result.findings` が配列か**で決める。companion は codex 側の
 * 終了コードをそのまま返すため、正常に所見を返しても exit 1 になることがある(実測)。利用枠切れは
 * `.parseError` に "You've hit your usage limit" として現れ、`.result` は null になる。
 * 作業ツリーモードは未追跡ファイルも読む(実測: "Reviewing 0 staged, 76 unstaged, and 103 untracked file(s)")。
 */
async function runCodex() {
  // 出力先はリポジトリ外。変更マップがあればそのディレクトリ(validChangeMap で引用符等を含まない絶対パスと
  // 確認済みなので、展開を止めるシングルクォートで囲める)、無ければ単体実行用の既定の場所
  const outDir = changeMap
    ? `'${changeMap.dir.trim().replace(/\/+$/, '')}'`
    : `"\${TMPDIR:-/tmp}/claude-release-workflow/$(basename "$(git rev-parse --show-toplevel)")/review"`
  const script = codexModeScript(outDir, codexDetect.companionPath, base, committedReviewed)
  const focus = REJECTED_BLOCK + REQUIREMENTS_NOTE + DIMENSIONS.map(d => `## 観点: ${d.key}\n${d.prompt}`).join('\n\n')
  const prompt =
    TOOL_POLICY +
    WRITING_POLICY +
    'OpenAI Codex CLI による一次レビューを実行してください(機械的な作業。レビュー内容の判断・補完はしない)。次のスクリプトを**改変せず、そのまま 1 回の bash 呼び出しで**実行すること。bash 呼び出しには明示的にタイムアウト 600000ms を指定する(Codex は数十秒〜数分かかる。バックグラウンド実行にせず完了を待つこと)。' +
    'スクリプトは作業ツリーとブランチの状態を見て、未コミット差分とコミット済みブランチ差分の必要なほうを(両方なら並列に)レビューする。\n\n' +
    '```bash\n' +
    // 置換文字列を関数で渡す: 文字列で渡すと focus 中の $' や $& が置換パターンとして解釈され、スクリプトが壊れる
    script.replace('__FOCUS__', () => focus) +
    '\n```\n\n' +
    '実行後、出力の `CRW_CODEX_MODE=` の値を mode として返すこと。\n' +
    '- mode が unknown なら(base との merge-base を解決できず、コミット済み差分の有無を判定できない)何も Read せず status: "failed"、reason: "base との merge-base を解決できない" とする\n' +
    '- それ以外は、mode に応じた出力(working-tree → $OUT/codex-wt.json、base → $OUT/codex-base.json、both → その両方)を Read し、次の規則で判定して返すこと:\n' +
    '- **成否は終了コードでは判定しない**(companion は Codex 側の終了コードをそのまま返すため、所見を正しく返しても exit 1 になることがある)。JSON が parse でき `.result.findings` が配列であれば、そのコマンドは成功\n' +
    '- いずれかの JSON の `.parseError` / `.codex.stderr` / `.codex.stdout`、または .err ファイルに "usage limit" / "rate limit" / "hit your usage" を含むなら status: "quota_exhausted"(reason にその文言)\n' +
    '- それ以外で 1 つでも失敗(ファイルが無い・parse 不能・`.result` が null・`.result.findings` が配列でない)なら status: "failed"(reason に要点)\n' +
    '- 全コマンド成功なら status: "ok" とし、全コマンドの `.result.findings` を次の対応で findings に変換して返す(同一ファイル・同一内容の重複は 1 件にまとめる。件数の取捨選択・要約・補完はしない):\n' +
    '  - severity・title → そのまま(severity が critical/high/medium/low 以外なら medium)\n' +
    '  - file → line_start === line_end なら "<file>:<line_start>"、異なれば "<file>:<line_start>-<line_end>"\n' +
    '  - detail → body。recommendation があれば末尾に改行して「対応案: <recommendation>」を追記する\n' +
    '  - failureScenario → body から「どういう入力・状態のときに何が起きるか」を 1〜3 文で抜き出す(書かれていなければ body の要点をそのまま)\n' +
    '- status が ok 以外のときは findings: [] を返す'
  return await roleAgent(prompt, {
    label: 'codex一次レビュー',
    role: 'codex-runner',
    phase: 'レビュー',
    schema: CODEX_RUN_SCHEMA,
    // 機械的な変換だが haiku は使わない: 手順の省略・結果の捏造を実測で起こしている(codex検出と同じ判断)
    ...modelAndEffort('codex', MODELS, EFFORTS),
  })
}

/** 所見が要件ファイル(requirementsPaths)を指しているか。絶対パスで報告された所見(Codex に多い)は末尾一致も見る。 */
function isRequirementPath(f) {
  if (requirementsPaths.length === 0) return false
  const path = String((f && f.file) || '').split(':')[0].replace(/^\.\//, '')
  const abs = path.startsWith('/')
  return requirementsPaths.some(
    p => path === p || path.startsWith(`${p}/`) || (abs && (path.endsWith(`/${p}`) || path.includes(`/${p}/`)))
  )
}

/** diffPathScope が指定されているとき、所見がスコープ内かを判定する(Codex 側の絞り込み漏れの受け皿)。 */
function inScope(f) {
  if (!diffPathScope) return true
  const path = String((f && f.file) || '').split(':')[0].replace(/^\.\//, '')
  return diffPathScope.some(p => {
    const scope = String(p).replace(/\/$/, '')
    return path === scope || path.startsWith(`${scope}/`)
  })
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'file', 'detail', 'severity', 'failureScenario'],
        properties: {
          title: {
            type: 'string',
            description:
              '何が・どの条件で・どうなるかを 1 行で(例: 「空配列を渡すと calcAverage が NaN を返す」)。「問題」「修正が必要」だけの見出しにしない。' +
              '行番号・日付・回数を入れない(次の回のレビューとの照合に使うので、同じ問題には同じ書き方をする)',
          },
          file: { type: 'string', description: 'file:line 形式' },
          detail: {
            type: 'string',
            description: '問題の内容と根拠。読んだコード(パス・関数名)や実行したコマンドの結果を具体的に書く',
          },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          failureScenario: {
            type: 'string',
            description:
              'どういう入力・状態・操作のときに、どのコード経路を通って、何が起き、本来どうあるべきか(1〜3 文)。具体的に書けないなら報告しないこと',
          },
          supersedes: {
            type: 'string',
            description:
              '既知・追跡済みとして提示された所見のうち、この所見が置き換えるものの ID。severity がより高い / 機序が異なる / 修正済みのはずが解消していない(回帰)のいずれかに該当する場合のみ設定する',
          },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['isReal', 'reason'],
  properties: {
    isReal: { type: 'boolean', description: '実在する問題なら true' },
    reason: {
      type: 'string',
      description: '判定の根拠。たどったコードの経路(パス・関数名)と、その入力・状態に到達できる/できない理由を書く',
    },
    severity: {
      type: 'string',
      enum: ['critical', 'high', 'medium', 'low'],
      description:
        '実在する場合のみ、あなた自身の評価による深刻度。critical=データ損失・セキュリティ侵害・全体停止 / high=主要機能が誤動作する / medium=限られた条件でのみ誤動作する / low=体裁・保守性',
    },
  },
}

/**
 * 敵対的検証の作法。**証拠を先・主張を後**に置く順序そのものが設計の一部で、
 * 「レビュアーの結論は誤りうる一次情報ではない」ことを明示してアンカリングを弱める。
 *
 * 検証者へ渡すのは**生の差分**だけであって、レビュアーの推論過程・他の検証者の verdict・
 * severity は渡さない(渡すと isReal: true 側へ引っ張られる)。
 */
const VERIFY_CRAFT = `## 検証の作法

- 下の「証拠」は差分そのもの＝一次資料。「主張」はレビュアーの結論であって、**誤っている可能性がある**
- 証拠と実コードのみを根拠に判定し、主張の言い回しに引きずられないこと
- 所見が誤りである可能性を積極的に探すこと。誤検出と思われる場合や再現根拠が弱い場合は isReal: false にする
- **主張の「失敗シナリオ」を実際にたどること。** その入力・状態が本当に到達可能か(呼び出し元が弾いていないか、型や設定で起こりえないか)、
  その経路で本当にそう動くかをコードで確かめる。シナリオが到達不能・具体性が無い場合は isReal: false
- 実在する場合は、主張とは独立に自分で深刻度を評価して severity に書く(主張の深刻度は渡していない)
- **証拠の hunk は調査の起点であって範囲ではない。** 呼び出し元・関連関数・テストまで辿って判断すること
  (差分の中だけを見て「呼び出し側が保証しているはず」と仮定しない)

`

/** 全 verify 兄弟で 1 バイトも違わない共有ブロック。前方一致キャッシュに載せるため必ず先頭に置く。 */
const VERIFY_SHARED = TOOL_POLICY + CHANGE_MAP_BLOCK + VERIFY_CRAFT

/**
 * 所見 1 件の敵対的検証。証拠(該当ファイルの差分の所在)をプロンプトへ同梱し、
 * 「差分がどこにあるか」を毎回発見し直す探索ターンを消す。hunk の位置は patch 内の @@ 行で分かる。
 * 変更マップが無い場合は従来どおり自力で差分を特定させる。
 */
function verifyEvidence(f) {
  const entry = manifestEntryFor(f.file)
  return entry
    ? `## 証拠(${entry.path} の差分${entry.untracked ? '。新規ファイル' : ''})

このファイル単独の差分: ${entry.patchPath}
まずこの patch を Read で読むこと(hunk の位置は patch 内の @@ 行にある)。全差分が要る場合は ${changeMap.dir}/diff.patch を読む。

`
    : `## 証拠

この所見の対象ファイルは変更マップに見当たらない。\`git diff $(git merge-base ${base} HEAD) -- <対象ファイル>\` で
差分を確認すること(差分外のファイルを指す所見は、それ自体が誤検出の可能性がある)。

`
}

/** 要件ファイルへの指摘の確かめ方。コードの不具合とは確かめ方が違う(可変部に置くので前方一致キャッシュは崩れない)。 */
function requirementCheckFor(f) {
  return isRequirementPath(f)
    ? `## 要件ファイルへの指摘の確かめ方

この指摘は要件ファイルを対象にしている。次の 3 種類のどれに当たるかを特定し、該当する箇所
(要件の行・他の要件の行・実装の行)を実際に読んで、具体的に成り立つかを確かめること。
(a) 要件同士の矛盾 (b) 検証できない受け入れ基準 (c) 実装と要件の食い違い。
どれにも当たらないもの(書かれていないこと自体・書き方の好み・より詳しく書くべきという意見)は isReal: false。
reason には、成り立つ場合はどの種類かと根拠の行を、成り立たない場合はその理由を書くこと。

`
    : ''
}

function verifyAgent(f, dimensionKey) {
  const evidence = verifyEvidence(f)
  const requirementCheck = requirementCheckFor(f)
  const priorRejection = f.rejectedHint
    ? `## 前の周の判定

同じファイル・同じタイトルの所見を、前の周の検証で次の理由により退けた: ${f.rejectedHint}
今回の所見に同じ理由が当たるか(同じ箇所・同じ機序か)、それとも別の箇所・別の経路の問題かを確かめること。

`
    : ''
  return roleAgent(
    VERIFY_SHARED +
      evidence +
      requirementCheck +
      priorRejection +
      `## 主張(${dimensionKey} 次元のレビュアーによる。誤りうる)

${f.title}
対象: ${f.file}
${f.detail}${f.failureScenario ? `\n失敗シナリオ: ${f.failureScenario}` : ''}`,
    { label: `verify:${f.file}`, role: 'verify', phase: '検証', schema: VERDICT_SCHEMA, ...modelAndEffort('verify', MODELS, EFFORTS) }
  )
}

/** 同じファイルの所見をまとめて検証する体 1 体あたりの上限。多すぎると 1 体のターン数が伸び、費用が二乗で効く。 */
const VERIFY_BATCH_MAX = 3
const BATCH_VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'isReal', 'reason'],
        properties: { index: { type: 'integer', description: '主張の番号(0 始まり。「### 主張 N」の N をそのまま)' }, ...VERDICT_SCHEMA.properties },
      },
    },
  },
}

/**
 * 同じファイルを指す所見(クラスタリング後の代表)を 1 体でまとめて検証する。証拠(そのファイルの patch)と
 * 要件書の確かめ方は共通なので 1 回で済む。ほかの所見の存在は実在側への偏りになりうるので、各主張を独立に
 * 判定させ、ほかの主張の成否を根拠にさせない。前の周の判定(rejectedHint)は主張ごとに付ける。
 *
 * @returns 主張の並び順どおりの判定の配列。返らなかった主張は null(呼び出し側が 1 件ずつ取り直す)
 */
async function verifyBatch(items) {
  const claims = items
    .map(
      (f, k) => `### 主張 ${k}(${f.dimension} 次元のレビュアーによる。誤りうる)
${f.rejectedHint ? `前の周の判定: 同じファイル・同じタイトルの所見を、前の周の検証で次の理由により退けた: ${f.rejectedHint}\n今回の所見に同じ理由が当たるか(同じ箇所・同じ機序か)、それとも別の箇所・別の経路の問題かを確かめること。\n` : ''}
${f.title}
対象: ${f.file}
${f.detail}${f.failureScenario ? `\n失敗シナリオ: ${f.failureScenario}` : ''}`
    )
    .join('\n\n')
  const r = await roleAgent(
    VERIFY_SHARED +
      verifyEvidence(items[0]) +
      requirementCheckFor(items[0]) +
      `## 主張(同じファイルへの ${items.length} 件。レビュアーによる。誤りうる)

各主張を**独立に**判定すること。ほかの主張が実在するかどうかを判定の根拠にしない(同じファイルに所見が
多いことは、個々の所見が実在する根拠にならない)。verdicts に主張の番号(index)ごとの判定を必ず全件返すこと。

${claims}`,
    {
      label: `verify:${String(items[0].file).split(':')[0]}(${items.length}件)`,
      role: 'verify',
      phase: '検証',
      schema: BATCH_VERDICT_SCHEMA,
      ...modelAndEffort('verify', MODELS, EFFORTS),
    }
  )
  const list = r && Array.isArray(r.verdicts) ? r.verdicts : []
  // 番号の振り方がずれていたら(1 始まり等)判定が隣の主張に付くので、全件を 1 件ずつ取り直す側に倒す
  const outOfRange = list.some(v => !v || !Number.isInteger(v.index) || v.index < 0 || v.index >= items.length)
  if (outOfRange) return items.map(() => null)
  return items.map((_, k) => list.find(v => v.index === k && typeof v.isReal === 'boolean') || null)
}

// ---- 既知・追跡済み所見の台帳(再発見の抑制) ----
// 実測: 1 リリースで挙がった 75 件の所見のうち 45 件(60%)が既出テーマの再発見だった。
// 同一テーマが最大 13 回、しかも次元をまたいで(arch / bugs / content-data / determinism が
// 別々に)再検出されていた。起票済みで対応方針が決まっている所見を「再報告するな」として渡す。
//
// 台帳がプロンプトに乗るコストは「バイト数 × ターン数」で効くため、無制限には積まない。
// 上限を超える場合は severity の高い順に切る。
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 }
const knownFindingsLimit =
  config.automation && Number.isInteger(config.automation.knownFindingsLimit)
    ? config.automation.knownFindingsLimit
    : 60
const knownFindings = (Array.isArray(input.knownFindings) ? input.knownFindings : [])
  .filter(k => k && (k.title || k.file))
  .slice()
  .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9))
  .slice(0, knownFindingsLimit)

const KNOWN_FINDINGS_BLOCK =
  knownFindings.length > 0
    ? `## 既知・追跡済みの所見(再報告しないこと)

${knownFindings
  .map(
    k => `- ${k.id ? `${k.id} | ` : ''}${k.file || '対象不明'} | ${k.title || ''} | ${k.severity || 'medium'}`
  )
  .join('\n')}

これらは起票済みで、対応方針が別途決まっている。**同じ機序・同じ箇所の再報告は不要**。
ただし次のいずれかに当たる場合は新規所見として報告し、supersedes に上記の ID を書くこと:
- 記録より severity が高いと判断した場合
- 同じ箇所だが**機序が異なる**場合
- 修正が入ったはずなのに解消していない場合(回帰)

`
    : ''

// ---- 検証で誤検出と判定済みの所見(run-release が周をまたいで渡す) ----
// 退けた所見は次の周でも同じ言い回しで再報告され、そのたびに検証体が起動していた。レビュアーへ渡して
// 再報告を抑え、エンジン側でも完全一致(ファイル+タイトル)で濾す。上限は既知課題の台帳と同じ考え方
const rejectedFindings = (Array.isArray(input.rejectedFindings) ? input.rejectedFindings : [])
  .filter(k => k && (k.title || k.file))
  .slice(-knownFindingsLimit)
const REJECTED_BLOCK =
  rejectedFindings.length > 0
    ? `## 検証で誤検出と判定済みの所見(再報告しないこと)

${rejectedFindings.map(k => `- ${k.file || '対象不明'} | ${k.title || ''}${k.reason ? ` — 退けた理由: ${String(k.reason).slice(0, 160)}` : ''}`).join('\n')}

前の周の検証で、実コードをたどった結果これらは成り立たないと判定した。同じ機序の再報告は不要。
退けた理由が当たらない新しい根拠(別の入力経路で実際に起きる等)がある場合だけ、その根拠を failureScenario に書いて報告すること。

`
    : ''

/** レビュー次元プロンプトの共有プレフィックス。可変部(d.prompt)は必ず末尾へ置く(前方一致キャッシュ)。 */
/** 要件ファイルへの指摘の型。レビュアーと Codex の両方に渡す。 */
const REQUIREMENTS_NOTE =
  requirementsPaths.length === 0
    ? ''
    : requirementsReviewed
      ? `**要件ファイル(${requirementsPaths.join(', ')})はこの run で既にレビュー済みで、その後変わっていない。要件ファイル自体への指摘は報告しないこと**(実装が要件と食い違う場合は、実装側のファイルを対象として報告する)。\n\n`
      : `**要件ファイル(${requirementsPaths.join(', ')})への指摘は次の 3 種類に限る**: ` +
        '(a) 要件同士の矛盾(同じ入力に対して 2 つの AC が異なる結果を求める等) ' +
        '(b) 検証できない受け入れ基準(合否を判定する観測手段が無い) ' +
        '(c) 実装と要件の食い違い — (c) は要件ファイルではなく実装側のファイルを対象として報告する。' +
        '「文面にその保証が書かれていない」「もっと詳しく書くべき」だけの指摘は報告しないこと(要件は網羅的な仕様書ではない)。\n\n'

const REVIEW_SHARED =
  TOOL_POLICY +
  WRITING_POLICY +
  CHANGE_MAP_BLOCK +
  KNOWN_FINDINGS_BLOCK +
  REJECTED_BLOCK +
  REQUIREMENTS_NOTE +
  // 変更マップがあるときは DIFF(「git diff で対象を確認せよ」)を並べない。0.8.x までは目次の「git diff を
  // 叩き直す必要はない」と矛盾する指示が同じプロンプトに並んでいた
  (changeMap
    ? diffPathScope
      ? `**今回のレビュー対象は次のパスに限定する**: ${diffPathScope.join(', ')}。これらの外にある所見は報告しないこと。\n\n`
      : ''
    : `${DIFF}\n\n`)

phase('レビュー')
// Codex が使えるなら、一次レビューは 1 体の実行体に任せて次元エージェント(config.models.review × 次元数)は
// 起動しない。0.2.0 の契約「一次生成を Codex へ委譲する」どおりで、従来も Codex 成功時の次元体は変換係
// だった(実測 33〜43 ターン)。実行体が枠切れ・失敗を返した周だけ、従来どおり全次元の自力レビューへ倒す
let codexRun = null
if (codexAvailable) {
  codexRun = await runCodex()
  codexMode = codexRun && ['both', 'working-tree', 'base'].includes(codexRun.mode) ? codexRun.mode : null
  if (codexMode) {
    log(
      `Codex 一次レビュー: ${
        codexMode === 'both'
          ? `併用モード(作業ツリー差分 + ブランチ差分 base: ${base})`
          : codexMode === 'working-tree'
            ? '作業ツリー差分モード'
            : `ブランチ差分モード(base: ${base})`
      }`
    )
  }
}
// mode が unknown・欠落のまま ok と申告されても使わない(どちらの差分を見たか分からない)
const codexOk = Boolean(codexRun && codexRun.status === 'ok' && codexMode && Array.isArray(codexRun.findings))
/** Codex 委譲の結末。run-release は quota_exhausted を見て以降の周の試行を省く。 */
const codexStatus = !codexEligible
  ? 'not-eligible'
  : codexDisabled
    ? 'disabled'
    : !codexAvailable
      ? 'unavailable'
      : codexOk
        ? 'used'
        : codexRun && codexRun.status === 'quota_exhausted'
          ? 'quota_exhausted'
          : 'failed'
if (codexAvailable && !codexOk) {
  log(
    `Codex 一次レビューが使えませんでした(${codexStatus}${codexRun && codexRun.reason ? `: ${codexRun.reason}` : ''}) — 全次元とも自力レビューへ倒します`
  )
}

// pipeline() ではなく parallel() のバリアにする。次元ごとに即座に検証へ流すと、次元をまたいだ
// 重複(実測では同一バグを 4 次元が別々に報告していた)を**検証前に**潰せないため。
// Gate2 は次の修正工程でどのみち全次元の結果を待つので、パイプライン全体のクリティカルパスは
// 伸びない — 伸びるのは review-changes を単体実行したときの体感だけ。
const reviews = codexOk
  ? null
  : await parallel(
      DIMENSIONS.map(
        d => () =>
          roleAgent(`${REVIEW_SHARED}${d.prompt}`, {
            label: `review:${d.key}`,
            role: 'review',
            phase: 'レビュー',
            schema: FINDINGS_SCHEMA,
            ...modelAndEffort('review', MODELS, EFFORTS),
          })
      )
    )

// filter(Boolean) によるサイレント消失はさせない:
// 欠落した次元・検証エージェントが結果を返さなかった所見は unverifiable として明示報告する
const unverifiable = []
const dimensionsRun = []
const dimEngines = {}
/** 全次元の所見を一本化したもの。以降の重複排除はこの配列の index で参照する。 */
const flat = []
/**
 * `inScope()` で落とした所見(0.7.2)。**フィルタで捨てるものは必ず数える** —
 * 数えないと要約の「所見 0 件」が「レビューが何も見つけなかった」と「見つけたものを全部捨てた」を
 * 区別できず、スコープを誤った周のレビューが丸ごと空振りしても正常に見える(実測: 導入先の
 * release-10 で Codex が返した high 2 件を含む 3 件が無記録で消えた)。
 */
const scopeExcluded = []
/** 要件書をレビュー済みの周に出た、要件書への指摘(検証せずに数えるだけ)。 */
const requirementsSkipped = []
/** `inScope()` を通しつつ、落としたものを {@link scopeExcluded}・{@link requirementsSkipped} へ退避する。 */
function keepInScope(findings) {
  return findings.filter(f => {
    if (isRequirementPath(f)) {
      if (requirementsReviewed) {
        requirementsSkipped.push(f)
        return false
      }
      // 要件書は diffPathScope の外でも初回はレビュー対象
      return true
    }
    if (inScope(f)) return true
    scopeExcluded.push(f)
    return false
  })
}

if (codexOk) {
  // 1 本化した Codex 呼び出しは全次元の観点を含むので、全次元を実行済みとみなす。
  // 所見の次元(dimension)は後段のクラスタリング体が付ける(null のまま渡す)
  DIMENSIONS.forEach(d => {
    dimensionsRun.push(d.key)
    dimEngines[d.key] = 'codex'
  })
  // Codex は全差分を見るため、スコープ指定時はエンジン側で所見を濾す
  keepInScope(codexRun.findings).forEach(f => flat.push({ ...f, dimension: null, engine: 'codex' }))
} else {
  // engine はエンジン側で決める: Codex を試みて使えなかった周は claude-fallback、対象外なら claude
  const engine = codexAvailable ? 'claude-fallback' : 'claude'
  DIMENSIONS.forEach((d, i) => {
    const review = reviews && reviews[i]
    if (!review || !Array.isArray(review.findings)) {
      unverifiable.push({
        dimension: d.key,
        reason: 'この次元のレビューエージェントが結果を返さなかったため検証不能(再実行を推奨)',
      })
      return
    }
    dimensionsRun.push(d.key)
    dimEngines[d.key] = engine
    keepInScope(review.findings).forEach(f => flat.push({ ...f, dimension: d.key, engine }))
  })
}

if (scopeExcluded.length > 0) {
  const bySeverity = {}
  scopeExcluded.forEach(f => {
    const sev = String((f && f.severity) || 'unknown')
    bySeverity[sev] = (bySeverity[sev] || 0) + 1
  })
  const paths = [...new Set(scopeExcluded.map(f => String((f && f.file) || '').split(':')[0]))]
  log(
    `スコープ外として除外: ${scopeExcluded.length} 件(` +
      Object.keys(bySeverity)
        .map(sev => `${sev} ${bySeverity[sev]}`)
        .join(' / ') +
      `) — ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` ほか ${paths.length - 5} パス` : ''}` +
      `。レビュー対象パス: ${(diffPathScope || []).join(', ')}`
  )
}

/** 完全一致の重複キー。次元が違っても同一ファイル・同一タイトルなら同じ所見とみなす。 */
function exactKey(f) {
  return `${String(f.file || '').trim()}::${String(f.title || '').trim()}`
}
/** 台帳との照合キー。file は "path:line" 形式なので、行番号を落としたパスでも照合する。 */
function ledgerKeys(f) {
  const file = String(f.file || '').split(':')[0].replace(/^\.\//, '')
  return [exactKey(f), `${file}::${String(f.title || '').trim()}`]
}

const seenExact = new Set()
const deduped = []
let exactDuplicates = 0
flat.forEach(f => {
  const k = exactKey(f)
  if (seenExact.has(k)) {
    exactDuplicates++
    return
  }
  seenExact.add(k)
  deduped.push(f)
})

// 台帳ヒットの抑制。supersedes が付いていれば「既知だが状況が変わった」という主張なので抑制しない
const ledgerIndex = new Set()
knownFindings.forEach(k => {
  const file = String(k.file || '').split(':')[0].replace(/^\.\//, '')
  ledgerIndex.add(`${String(k.file || '').trim()}::${String(k.title || '').trim()}`)
  ledgerIndex.add(`${file}::${String(k.title || '').trim()}`)
})
let ledgerSuppressed = 0
// 完全一致(行番号まで同じ)だけを検証せずに落とす。ファイルとタイトルだけの一致は別の箇所の本物の所見でありうるので、
// 前に退けた理由を添えて検証し直す(rejectedHint)
const rejectedIndex = new Set()
const rejectedLoose = new Map()
rejectedFindings.forEach(k => {
  const file = String(k.file || '').split(':')[0].replace(/^\.\//, '')
  rejectedIndex.add(`${String(k.file || '').trim()}::${String(k.title || '').trim()}`)
  rejectedLoose.set(`${file}::${String(k.title || '').trim()}`, k.reason || '')
})
let rejectedSuppressed = 0
const fresh = deduped.filter(f => {
  if (f.supersedes) return true
  const hit = ledgerKeys(f).some(k => ledgerIndex.has(k))
  if (hit) {
    ledgerSuppressed++
    return false
  }
  // 前の周で誤検出と判定した所見の再報告(同じファイル・同じタイトル)は検証し直さない
  if (rejectedIndex.has(exactKey(f))) {
    rejectedSuppressed++
    return false
  }
  const looseHit = rejectedLoose.get(ledgerKeys(f)[1])
  if (looseHit !== undefined) f.rejectedHint = looseHit || '(理由の記録なし)'
  return true
})

const CLUSTER_SCHEMA = {
  type: 'object',
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        required: ['representative', 'members'],
        properties: {
          representative: { type: 'number', description: 'このグループを代表する所見の index' },
          members: { type: 'array', items: { type: 'number' } },
          reason: { type: 'string' },
        },
      },
    },
    // Codex 由来の所見(次元が未定)にだけ求める。既存の次元は上書きしない
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'dimension'],
        properties: {
          index: { type: 'number' },
          dimension: { type: 'string', description: '最も近い観点の key。該当が無ければ "codex"' },
        },
      },
    },
  },
}

/**
 * クラスタリング結果を正規化する。**所見を捨てないこと**が最優先の不変条件で、
 * どのグループにも入らなかった index は単独グループへ差し戻す。
 * クラスタリングエージェントが null を返した場合は全件が単独グループ = 従来どおり全件検証。
 */
function normalizeGroups(raw, n) {
  const assigned = new Set()
  const out = []
  if (Array.isArray(raw)) {
    raw.forEach(g => {
      const members = (Array.isArray(g.members) ? g.members : []).filter(
        i => Number.isInteger(i) && i >= 0 && i < n && !assigned.has(i)
      )
      if (members.length === 0) return
      members.forEach(i => assigned.add(i))
      const rep =
        Number.isInteger(g.representative) && members.includes(g.representative)
          ? g.representative
          : members[0]
      out.push({ representative: rep, members })
    })
  }
  for (let i = 0; i < n; i++) {
    if (!assigned.has(i)) out.push({ representative: i, members: [i] })
  }
  return out
}

phase('検証')
// 意味的クラスタリング: 完全一致では落ちない「同じバグを別の言い回しで報告したもの」をまとめ、
// 代表 1 件だけを検証する。入力は index/file/title/severity だけなので、この 1 体は小さく済む。
// Codex 由来の所見(次元が未定)があるときは、同じ 1 体に次元付けも同居させる(追加エージェント無し)。
// 所見が CLUSTER_MIN_FINDINGS 件未満ならまとめない: 統合で減る検証体は多くても 2 体で、クラスタリング体 1 体の
// 起動費(約 34k トークンの床)と相殺され、統合しすぎて実在する所見を巻き込む危険だけが残る
const CLUSTER_MIN_FINDINGS = 4
const needsDimension = fresh.some(f => !f.dimension)
let clusterGroups = null
if (fresh.length >= CLUSTER_MIN_FINDINGS || needsDimension) {
  const c = await roleAgent(
    TOOL_POLICY +
      '次のレビュー所見リストから、**同一の実体を指している所見**をグループにまとめてください。\n\n' +
      '統合してよいのは次の 3 条件を**すべて**満たす場合のみです:\n' +
      '1. 同一ファイルを指している\n' +
      '2. 行範囲が重なる(または一方が他方を含む)\n' +
      '3. **同じ機序**である(同じ原因で同じ壊れ方をする)\n\n' +
      '場所が同じでも機序が違えば別グループにすること。**判断に迷ったら分けること**' +
      '(統合しすぎると実在する所見が代表 1 件の判定に巻き込まれて消える)。\n' +
      '**すべての index がちょうど 1 つのグループに属すること。** 1 件だけのグループも作ってよい。\n' +
      'representative には、そのグループで最も具体的で再現根拠が明確な所見の index を選ぶこと。\n' +
      (needsDimension
        ? '\nあわせて、dimension が null の所見それぞれについて、最も近い観点の key を dimensions に {index, dimension} で付けること。観点の候補:\n' +
          DIMENSIONS.map(d => `- ${d.key}: ${String(d.prompt).slice(0, 80)}`).join('\n') +
          '\nどの観点にも当たらなければ "codex" とする。dimension が既に付いている所見は対象外。\n'
        : '') +
      '\n' +
      JSON.stringify(
        fresh.map((f, idx) => ({
          index: idx,
          file: f.file,
          title: f.title,
          severity: f.severity,
          dimension: f.dimension || null,
          ...(needsDimension && !f.dimension ? { detail: String(f.detail || '').slice(0, 200) } : {}),
        })),
        null,
        2
      ),
    { label: '所見クラスタリング', role: 'cluster', phase: '検証', schema: CLUSTER_SCHEMA, ...modelAndEffort('verify', MODELS, EFFORTS) }
  )
  clusterGroups = c && Array.isArray(c.groups) ? c.groups : null
  if (needsDimension) {
    const allowed = new Set(DIMENSIONS.map(d => d.key))
    ;(c && Array.isArray(c.dimensions) ? c.dimensions : []).forEach(x => {
      if (x && Number.isInteger(x.index) && fresh[x.index] && !fresh[x.index].dimension && allowed.has(x.dimension)) {
        fresh[x.index].dimension = x.dimension
      }
    })
  }
}
// 次元付けが得られなかった Codex 所見は "codex" とする(known-issues の categoryMap では defaultCategory に落ちる)
fresh.forEach(f => {
  if (!f.dimension) f.dimension = 'codex'
})
const groups = normalizeGroups(clusterGroups, fresh.length)

// 代表のみ検証する。**クラスタ内の他の所見の存在は verify へ渡さない** —
// 「他の次元も同じ箇所を指摘している」という事実は isReal: true 側へのバイアスになるため
// 同じファイルの代表は VERIFY_BATCH_MAX 件ずつまとめて 1 体で検証する(証拠の patch を読むのが 1 回で済む)。
// 1 件だけのファイルは従来の 1 件検証。まとめた体から判定が返らなかった主張は 1 件ずつ取り直す
const byFile = new Map()
groups.forEach((g, gi) => {
  const f = fresh[g.representative]
  const entry = manifestEntryFor(f.file)
  const key = entry ? entry.path : String(f.file || '').split(':')[0].replace(/^\.\//, '')
  if (!byFile.has(key)) byFile.set(key, [])
  byFile.get(key).push(gi)
})
const batches = []
for (const gis of byFile.values()) {
  for (let i = 0; i < gis.length; i += VERIFY_BATCH_MAX) batches.push(gis.slice(i, i + VERIFY_BATCH_MAX))
}
const verdicts = new Array(groups.length).fill(null)
await parallel(
  batches.map(gis => async () => {
    const reps = gis.map(gi => fresh[groups[gi].representative])
    const got = gis.length === 1 ? [await verifyAgent(reps[0], reps[0].dimension)] : await verifyBatch(reps)
    const retry = await Promise.all(
      got.map((v, k) => (v || gis.length === 1 ? v : verifyAgent(reps[k], reps[k].dimension)))
    )
    retry.forEach((v, k) => {
      verdicts[gis[k]] = v
    })
  })
)

const confirmed = []
/** 検証で誤検出と判定した所見(グループの全員)。呼び出し元は持ち越しから外し、次の周のレビューへ渡す。 */
const rejected = []
/** 観点ごとの検証結果の内訳(精度を見る材料。棄却が多い観点は指示を直す余地がある)。 */
const precision = {}
/** 検証体の独立評価で深刻度を改めた所見。 */
const severityCorrected = []
const SEVERITIES = ['critical', 'high', 'medium', 'low']
function tally(dimension, key) {
  const d = dimension || 'codex'
  precision[d] = precision[d] || { verified: 0, rejected: 0, severityCorrected: 0 }
  precision[d][key] += 1
}
groups.forEach((g, gi) => {
  const rep = fresh[g.representative]
  const v = verdicts && verdicts[gi]
  if (!v) {
    unverifiable.push({
      dimension: rep.dimension,
      reason: `指摘「${rep.title || '(タイトル不明)'}」(${rep.file || '対象不明'}) の裏取りが結果を返さなかった`,
    })
    return
  }
  // isReal: false は誤検出として破棄する(グループ全体)。黙って捨てず rejected で返す — 呼び出し元が持ち越し中の
  // 同じ所見を修正体へ再投入し続けないように(導入先で、誤検出と判定された所見に修正体が投入され続けた)
  if (!v.isReal) {
    tally(rep.dimension, 'rejected')
    g.members.forEach(i =>
      rejected.push({ dimension: fresh[i].dimension, file: fresh[i].file, title: fresh[i].title, reason: v.reason })
    )
    return
  }
  tally(rep.dimension, 'verified')
  // 深刻度は検証体の独立評価を採る(検証体には主張の深刻度を見せていない。実コードをたどった評価のほうが確か)
  let severity = rep.severity
  if (SEVERITIES.includes(v.severity) && v.severity !== rep.severity) {
    severityCorrected.push({ file: rep.file, title: rep.title, from: rep.severity, to: v.severity })
    tally(rep.dimension, 'severityCorrected')
    severity = v.severity
  }
  const mergedFrom = g.members
    .filter(i => i !== g.representative)
    .map(i => ({ dimension: fresh[i].dimension, title: fresh[i].title, file: fresh[i].file }))
  confirmed.push({
    dimension: rep.dimension,
    severity,
    title: rep.title,
    file: rep.file,
    detail: rep.detail,
    ...(rep.failureScenario ? { failureScenario: rep.failureScenario } : {}),
    verifiedReason: v.reason,
    engine: rep.engine,
    ...(rep.supersedes ? { supersedes: rep.supersedes } : {}),
    ...(mergedFrom.length > 0 ? { mergedFrom } : {}),
  })
})

// 確定した指摘の件名を機械検査する。件名は数が多いので出し直させず、違反件数を数えてログと戻り値に出す
// (件名は既知課題の見出しと次の回の照合キーにもなるので、内部語が混ざっていれば観点の指示を直す材料になる)
const titleViolations = confirmed.reduce((n, f) => n + lintProse(f.title, 'title').length, 0)
if (titleViolations > 0) log(`確定した指摘の件名に、読者に通じない言い方が ${titleViolations} 件あります(出し直しはしません)`)

// 検証を通った要件書への指摘は修正ループに入れず、requirementFindings として分けて返す(人が判断する)
const requirementFindings = confirmed.filter(isRequirementPath)
const codeFindings = confirmed.filter(f => !isRequirementPath(f))

const codexUsedCount = codexOk ? dimensionsRun.length : 0
const codexFallbackCount = codexAvailable && !codexOk ? dimensionsRun.length : 0
/** 戻り値・ログ用の理由。使えた周は null。 */
const codexReason = !codexEligible
  ? null
  : codexOk
    ? null
    : codexAvailable
      ? `${codexStatus}${codexRun && codexRun.reason ? `: ${codexRun.reason}` : ''}`
      : codexUnavailableReason
/** 重複排除の内訳。何をどれだけ潰したかが見えないと、抑制が効きすぎていても気づけない。 */
const dedup = {
  rawFindings: flat.length,
  scopeExcluded: scopeExcluded.length,
  rejectedSuppressed,
  rejected: rejected.length,
  severityCorrected: severityCorrected.length,
  requirementsSkipped: requirementsSkipped.length,
  requirementFindings: requirementFindings.length,
  exactDuplicates,
  ledgerSuppressed,
  clustered: fresh.length - groups.length,
  verified: groups.length,
}
log(
  `確定所見: ${codeFindings.length} 件 / 検証不能: ${unverifiable.length} 件 / 実行次元: ${dimensionsRun.length}/${DIMENSIONS.length}` +
    ` / 所見 ${dedup.rawFindings} 件 → 検証 ${dedup.verified} 件(完全一致重複 ${exactDuplicates} / 既知として抑制 ${ledgerSuppressed} / 誤検出と判定済みで抑制 ${rejectedSuppressed} / クラスタ統合 ${dedup.clustered})` +
    ` / 検証で棄却 ${rejected.length} 件${severityCorrected.length > 0 ? ` / 深刻度を改めた ${severityCorrected.length} 件` : ''}` +
    (scopeExcluded.length > 0 ? ` / スコープ外で除外 ${scopeExcluded.length} 件` : '') +
    (requirementFindings.length > 0 ? ` / 要件書への指摘(検証済み・人の判断へ) ${requirementFindings.length} 件` : '') +
    (requirementsSkipped.length > 0 ? ` / 要件書はレビュー済みのため指摘 ${requirementsSkipped.length} 件を検証せず除外` : '') +
    (codexEligible
      ? ` / Codex: ${codexOk ? `使用(1 本化、${DIMENSIONS.length} 次元分)` : `不使用(${codexReason})`}`
      : '') +
    ` / 起動 ${agentsUsed} 体`
)

return {
  confirmed: codeFindings,
  unverifiable,
  dimensionsRun,
  diffPathScope,
  // 検証を通った要件書への指摘。confirmed には含めない(修正ループに入れず、呼び出し元が人の判断へ回す)
  requirementFindings,
  // 検証で誤検出と判定した所見(呼び出し元は持ち越しから外し、次の周の rejectedFindings に渡す)
  rejected,
  // 観点ごとの検証結果の内訳と、深刻度を改めた所見
  precision,
  severityCorrected,
  // 重複排除の内訳。抑制が効きすぎていないか(確定所見が不自然に減っていないか)を run 後に検証できるようにする
  dedup,
  // Codex 委譲の観測性(N11 対応で追加、0.7.0 で status を追加): run ログだけでなく戻り値からも
  // 「非対象/無効化/利用不可/使用/枠切れ/失敗(理由)」を判別できるようにする
  titleViolations,
  // Codex の検出結果(プラグインの可否)。run-release は次の周からこれを codexDetected として渡し、検出体を省く
  codexDetected: codexDetect
    ? {
        available: codexDetect.available === true,
        ...(codexDetect.available === true ? { companionPath: codexDetect.companionPath } : {}),
        reason: codexDetect.reason || '',
      }
    : null,
  codex: {
    eligible: codexEligible,
    available: codexAvailable,
    mode: codexMode,
    status: codexStatus,
    reason: codexReason,
    usedCount: codexUsedCount,
    fallbackCount: codexFallbackCount,
    // base との merge-base を解決できなかった(shallow clone・base 未フェッチ等)。run の途中では直らないので、
    // run-release は以降の周で実行体を起動しない
    baseUnresolved: Boolean(codexRun && codexRun.mode === 'unknown'),
  },
  // 実起動数(run-release の予算カウントに使う)
  agentsUsed,
  summary:
    (codeFindings.length === 0
      ? '確定した所見はありません'
      : `severity 順に対応を検討してください(${codeFindings.length} 件)`) +
    (unverifiable.length > 0 ? `。検証不能 ${unverifiable.length} 件あり(内容は unverifiable を参照)` : ''),
}
