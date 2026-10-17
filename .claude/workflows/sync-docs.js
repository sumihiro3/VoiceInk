export const meta = {
  name: 'sync-docs',
  description: '実装差分をドキュメント (README/architecture 等) に同期する',
  whenToUse: '実装・レビュー完了後のドキュメント同期。args: {base: "main", release: "release-1", config: {...}} で差分の比較先・対象リリース・設定を指定(いずれも省略可。config 省略時は .claude/workflow.config.json を読む)',
  phases: [
    { title: '設定読込', detail: 'workflow.config.json の読込と検証', model: 'haiku' },
    { title: '差分把握', detail: '変更内容の要約と各同期対象の関連性判定', model: 'sonnet' },
    { title: '同期', detail: 'ドキュメントを並列更新', model: 'sonnet' },
  ],
}

// モデル使い分けの方針: 設定読込 = haiku / 差分要約と関連性の判定・ドキュメント化 = config.models.docSync(既定 sonnet)

// args は JSON 文字列で渡ってくる場合があるためパースする。
// パース失敗を {} へ潰すと base/release/config の指定が黙って消えるため、明示エラーにする
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    throw new Error(
      `sync-docs: args の JSON パースに失敗しました (${e.message})。{base, release, config} 形式の JSON を渡してください`
    )
  }
}
input = input || {}

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

// 起動したエージェント数を数える薄いラッパ。呼び出し時点で加算するため、parallel に渡した
// サムの中から呼ばれても、条件分岐でスキップされた分を数えてしまうこともない。
// 役割マーカー `[crw:role=<役割>]` をプロンプト末尾(可変部)へ付ける — engine/tools/usage-report.py が
// transcript から工程別の消費を集計するための目印
let agentsUsed = 0
function countedAgent(prompt, options) {
  agentsUsed++
  const { role, ...rest } = options || {}
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

// config ブートストラップ: args.config 優先、未指定なら .claude/workflow.config.json を読む
phase('設定読込')
let config = input.config
if (!config) {
  const loaded = await countedAgent(
    TOOL_POLICY +
    'カレントリポジトリの .claude/workflow.config.json を読み、存在すれば {exists: true, config: <ファイル内容そのまま>}、無ければ {exists: false} を返してください。内容の要約・省略・補完は禁止。',
    {
      label: 'config読込',
      role: 'config',
      phase: '設定読込',
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
  if (!loaded || loaded.exists !== true || !loaded.config) {
    throw new Error(
      'workflow.config.json が読めません。args.config を渡すか .claude/workflow.config.json を作成してください'
    )
  }
  config = loaded.config
}
if (config.configVersion !== 1) {
  throw new Error(
    `workflow.config.json の configVersion (${config.configVersion}) がエンジン要求版 (1) と一致しません`
  )
}

const base = input.base || config.baseBranch || 'main'
const release = input.release || ''
const MODELS = config.models || {}
const EFFORTS = config.efforts || {}
const CWD = TOOL_POLICY + 'カレント作業ディレクトリ(リポジトリルート)で作業すること。'
// 文書を書く体だけに執筆規則を付ける(差分要約は中間の材料なので付けない)
const CWD_WRITING = TOOL_POLICY + WRITING_POLICY + 'カレント作業ディレクトリ(リポジトリルート)で作業すること。'

// 変更マップ(呼び出し元が既に作った差分の目次)を受け取れたら、差分要約エージェントに git diff を
// 叩き直させない。consistent: true 以外・目次が空・dir 欠落のものは使わない — 古い/不完全な目次を
// 渡すと存在しない差分を見に行かせることになるため、従来どおり自前で git diff させるほうへ倒す。
const changeMap =
  input.changeMap &&
  input.changeMap.consistent === true &&
  typeof input.changeMap.dir === 'string' &&
  input.changeMap.dir.length > 0 &&
  Array.isArray(input.changeMap.manifest) &&
  input.changeMap.manifest.length > 0
    ? input.changeMap
    : null

/** 変更マップを目次テキストへ。差分の本文ではなく所在だけを渡す(本文は patchPath の先にある)。 */
function renderChangeMap(cm) {
  const rows = cm.manifest.map(m => `- ${m.path} (+${m.added ?? '?'} -${m.deleted ?? '?'}) → ${m.patchPath}`)
  // 未追跡ファイルは git status の代替。changeMap 経路では git status を叩かせないため必ず渡す
  const untracked =
    Array.isArray(cm.untracked) && cm.untracked.length > 0
      ? `\n新規未追跡ファイル: ${cm.untracked.join(', ')}`
      : ''
  return `全差分: ${cm.dir}/diff.patch\n変更ファイル ${cm.manifest.length} 件(ファイル別の patch は各行の → の先):\n${rows.join('\n')}${untracked}`
}

// 同期先・凍結・除外はすべて config.syncDocs から取得する(本文にプロジェクト固有の文書名を置かない)
const syncDocs = config.syncDocs || {}
const targets = Array.isArray(syncDocs.targets) ? syncDocs.targets : []
if (targets.length === 0) {
  throw new Error(
    'config.syncDocs.targets が空です。同期先ドキュメント {path, instruction} を workflow.config.json に定義してください'
  )
}
const untouchable = [
  ...(Array.isArray(syncDocs.frozen) ? syncDocs.frozen : []),
  ...(Array.isArray(syncDocs.excluded) ? syncDocs.excluded : []),
]
const untouchableNote =
  untouchable.length > 0
    ? `\n次の文書は凍結・除外指定のため、内容の乖離があっても変更しないこと: ${untouchable.join(', ')}`
    : ''

phase('差分把握')
// 差分の要約と同期対象ごとの関連性の判定を 1 体で行う(0.8.x までは要約体と軽量モデルのトリアージ体の 2 体で、
// トリアージは要約を読み直すだけだった)。判定が曖昧・不明なもの、判定が欠けたものは誤スキップを避けて
// 起動側に倒す(AC-2, AC-3)
const SUMMARY_ASK = `今回の変更内容を要約し、summary として返してください: 追加・変更されたモジュール/機能、ユーザーに見える変更、開発環境の変更(依存関係・ビルドコマンド)。ドキュメント更新の判断材料になる粒度で。${release ? `対象リリース: ${release}` : ''}`
const TRIAGE_ASK =
  `\n\nあわせて、次の同期対象ドキュメントそれぞれについて、この差分がその文書の記述対象と関係するかを判定し judgements として返すこと。` +
  `判定に確信が持てない場合や境界的なケースは、必ず relevant: true にすること(見落としより過剰起動を優先する)。` +
  `judgements の path は下記の一覧の値をそのまま使うこと。\n\n## 同期対象\n${targets.map(t => `- ${t.path}: ${t.instruction}`).join('\n')}`
const summaryResult = await countedAgent(
  (changeMap
    ? `${CWD}${SUMMARY_ASK}

## 変更マップ(この run の差分。git diff を叩き直す必要はない)

${renderChangeMap(changeMap)}

各 patch は Read で読むこと。全差分が要る場合は ${changeMap.dir}/diff.patch を読む。`
    : `${CWD}git diff ${base}... と git status / git diff(未コミット分)を確認し、${SUMMARY_ASK}`) + TRIAGE_ASK,
  {
    label: '差分要約',
    role: 'doc-summary',
    phase: '差分把握',
    schema: {
      type: 'object',
      required: ['summary'],
      properties: {
        summary: {
          type: 'string',
          description: '変更の要約。追加・変更したモジュール(パス)、利用者に見える変更、開発環境の変更(依存・コマンド)を具体名で',
        },
        judgements: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'relevant', 'reason'],
            properties: {
              path: { type: 'string' },
              relevant: {
                type: 'boolean',
                description: '差分がこの文書の記述対象と明確に無関係なら false。曖昧・不明なら true。',
              },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
    ...modelAndEffort('docSync', MODELS, EFFORTS),
  }
)
const diffSummary = summaryResult && typeof summaryResult.summary === 'string' && summaryResult.summary.trim() ? summaryResult.summary : null
if (!diffSummary) {
  throw new Error('差分要約エージェントが失敗しました。差分要約なしでは同期できないため中断します')
}
const triageResult = summaryResult

// 関連性の判定(judgements)が欠けていた場合は判定材料なしとみなし、全 targets を起動する(AC-3)
const judgements =
  triageResult && Array.isArray(triageResult.judgements) ? triageResult.judgements : null

const skipped = []
let targetsToRun = targets
if (judgements) {
  const judgementByPath = new Map(judgements.map(j => [j.path, j]))
  targetsToRun = targets.filter(t => {
    const j = judgementByPath.get(t.path)
    // 判定が無い(パス不一致含む)・relevant が明示的な false 以外はすべて起動側に倒す
    if (j && j.relevant === false) {
      skipped.push({ path: t.path, reason: j.reason || '関連性トリアージにより無関係と判定' })
      return false
    }
    return true
  })
}
if (skipped.length > 0) {
  log(`トリアージで無関係と判定しスキップ: ${skipped.map(s => s.path).join(', ')}`)
}

phase('同期')
const updates = await parallel(
  targetsToRun.map(
    t => () =>
      countedAgent(
        `${CWD_WRITING}以下の変更要約をもとにドキュメントを同期してください。${untouchableNote}` +
          '書き換えた箇所の本文を changedSections に返すこと(1 箇所 1500 字まで。書き換えなければ [])。書いた後の機械検査に使う。' +
          `\n\n## 同期指示\n${t.instruction}\n\n## 変更要約\n${diffSummary}`,
        {
          label: `${t.path}更新`,
          role: 'doc-sync',
          phase: '同期',
          schema: {
            type: 'object',
            required: ['changedSections'],
            properties: {
              changedSections: { type: 'array', items: { type: 'string' }, description: '書き換えた箇所の本文(1 箇所 1500 字まで)' },
              note: { type: 'string', description: '判断に迷った点(あれば)' },
            },
          },
          ...modelAndEffort('docSync', MODELS, EFFORTS),
        }
      ).then(r => ({ path: t.path, result: r }))
  )
)

// 書き換えた箇所を機械検査し(内部語のみ。切り出しは節の区切りと一致しないので指示語の規則は当てない)、
// 違反のある文書は該当箇所だけを直す体を起動する。1 回の同期で DOC_FIX_MAX 体まで(超えた分は件数だけ返す)
const DOC_FIX_MAX = 2
const flaggedDocs = updates
  .filter(u => u && u.result && Array.isArray(u.result.changedSections))
  .map(u => ({ path: u.path, violations: u.result.changedSections.flatMap(t => lintProse(t, 'title')) }))
  .filter(d => d.violations.length > 0)
let proseViolations = 0
for (const [i, d] of flaggedDocs.entries()) {
  if (i >= DOC_FIX_MAX) {
    proseViolations += d.violations.length
    continue
  }
  log(`${d.path} の書き換えた箇所に ${d.violations.length} 件の違反 — 該当箇所だけを直させます`)
  const fix = await countedAgent(
    `${CWD_WRITING}文書 ${d.path} のうち、いま書き換えた箇所の文章に次の問題がある。該当する箇所だけを直し、ほかの箇所には触れないこと。${untouchableNote}` +
      '直した箇所の本文を changedSections に返すこと。\n\n' +
      d.violations.map(v => `- ${v.hint}(該当: ${v.excerpt})`).join('\n'),
    {
      label: `${d.path}更新(文章の手直し)`,
      role: 'doc-sync',
      phase: '同期',
      schema: { type: 'object', required: ['changedSections'], properties: { changedSections: { type: 'array', items: { type: 'string' } } } },
      ...modelAndEffort('docSync', MODELS, EFFORTS),
    }
  )
  proseViolations +=
    fix && Array.isArray(fix.changedSections) ? fix.changedSections.flatMap(t => lintProse(t, 'title')).length : d.violations.length
}
if (proseViolations > 0) log(`文書同期の機械検査: 手直し後も ${proseViolations} 件の違反が残っています`)

// parallel は入力順を保つため、updates[i] は targetsToRun[i] に対応する
const failedTargets = updates
  .map((u, i) => (u && u.result ? null : (u && u.path) || targetsToRun[i].path))
  .filter(Boolean)
log(
  failedTargets.length === 0
    ? `${targetsToRun.length} 件の同期先を処理完了(スキップ ${skipped.length} 件)`
    : `同期エージェント失敗: ${failedTargets.join(', ')}`
)

return {
  diffSummary,
  updates,
  failedTargets,
  skipped,
  agentsUsed,
  proseViolations,
}
