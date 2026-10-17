export const meta = {
  name: 'run-release',
  description:
    '要件確定済みリリースの実装→検査→レビュー→起票→文書同期→コミット→PR 作成を全自動実行する統括ワークフロー',
  whenToUse:
    '壁打ちで要件を確定したリリースの全自動実行。args: {release: "release-1", config: {...}, autoApprove: true|false}。autoApprove 省略時は config.automation.autoApprove に従う。false の場合はコミット直前で停止し、コミット分割案と PR 本文案を返す。config.automation.createPr=false なら PR を作成せず push まで実行し、PR タイトル・本文案を返す',
  phases: [
    { title: '準備', detail: 'config 読込と入力検証', model: 'haiku' },
    { title: 'Gate0 事前検査', detail: '作業ツリー・ブランチ・要件・config 版数の照合(読み取り専用)', model: 'haiku' },
    { title: 'Gate1 検査ループ', detail: 'release-check と修正の反復(失敗署名による収束判定つき)' },
    { title: 'Gate2 レビューループ', detail: 'review-changes と severity 別の修正・Gate1 再実行' },
    { title: 'PR準備', detail: 'AC 充足検証と PR 本文の生成' },
    { title: 'コミット', detail: '論理単位コミット(autoApprove=false はここで停止)' },
    { title: 'PR作成', detail: 'push と PR 作成(critical 残存時は作成しない。createPr=false は push のみ)' },
    { title: '通知', detail: '完了・停止の push 通知' },
  ],
}

// モデル使い分けの方針: 状態保存・スナップショット・変更マップ・push・PR 作成・通知 = config.models.bootstrap /
// 修正 = config.models.fix / 検証系(ガード・解決判定・AC 照合)= config.models.verify /
// 文書・PR 本文・コミット分割 = config.models.docSync。既定と effort は modelAndEffort を参照。
// config 読込体だけは config を読む前なので 'haiku' 直書き(鶏と卵)

const ENGINE_CONFIG_VERSION = 1

// args は JSON 文字列で渡ってくる場合があるためパースする(パース失敗は明示エラー)
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    throw new Error(
      `run-release: args の JSON パースに失敗しました (${e.message})。{release, config, autoApprove} 形式の JSON を渡してください`
    )
  }
}
input = input || {}

const release = input.release
if (!release || typeof release !== 'string') {
  throw new Error('args.release を指定してください(例: {release: "release-1"})')
}

// ---- エージェント起動数の通算カウンタ(AC-5)と消費サマリー ----
// サブワークフロー内の起動数はエンジンから観測できないため、戻り値からの概算(下限)を加算する
let totalAgents = 0
let checkRunsTotal = 0
const consumption = {}

/** フェーズ別の消費カウンタに n を加算し、通算カウンタにも反映する。 */
function addConsumption(key, n) {
  consumption[key] = (consumption[key] || 0) + n
  totalAgents += n
}

/** 通算エージェント起動数が上限に達したか(超過は収束不能と同じ停止経路に入る)。 */
function budgetExceeded() {
  return totalAgents >= maxAgentInvocations
}

/**
 * 予算の 8 割に達したか。ここから先は「任意工程」(文書同期・既知課題の解決判定など)を
 * 省いて、PR 作成までは必ずたどり着かせる。予算切れで PR も本文も出ないまま終わるのが最悪。
 */
function budgetNearLimit() {
  return totalAgents >= Math.floor(maxAgentInvocations * 0.8)
}

/**
 * 子ワークフローが実際に起動したエージェント数。
 * 旧版の子ワークフロー(agentsUsed を返さない)が混在しても壊れないよう、欠落時は従来の推定へ倒す。
 */
function agentsUsedOf(r, fallback) {
  return r && Number.isInteger(r.agentsUsed) && r.agentsUsed > 0 ? r.agentsUsed : fallback
}

/**
 * agent() を消費カウント付きで起動する。
 * 役割マーカー `[crw:role=<役割>]` をプロンプト末尾(可変部)へ付ける — engine/tools/usage-report.py が
 * transcript から工程別の消費を集計するための目印。meta.json はランタイム所有で label を書き出せないため、
 * 従来はプロンプトのキーワード推測で役割を分けており、ガード検査を「Gate 0.5 audit」と誤分類していた。
 * 末尾に置くので兄弟エージェントの前方一致キャッシュには影響しない。
 */
function trackedAgent(key, prompt, opts) {
  addConsumption(key, 1)
  const { role, ...rest } = opts || {}
  return agent(`${prompt}\n\n[crw:role=${role || key}]`, rest)
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

// config ブートストラップ: args.config 優先、未指定なら .claude/workflow.config.json を読む。
// 不存在は exists: false で報告させ、値の捏造を防いだうえで明示 throw する
let config = input.config
if (typeof config === 'string') {
  try {
    config = JSON.parse(config)
  } catch (e) {
    throw new Error('args.config を JSON として解釈できません')
  }
}
if (!config) {
  const loaded = await trackedAgent(
    'bootstrap',
    'カレントリポジトリの .claude/workflow.config.json を読み、存在すれば {exists: true, config: <ファイル内容そのまま>}、無ければ {exists: false} を返してください。内容の要約・省略・補完は禁止。',
    {
      label: 'config読込',
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
  if (!loaded || loaded.exists !== true || !loaded.config) {
    throw new Error(
      'workflow.config.json が読めません。args.config を渡すか .claude/workflow.config.json を作成してください'
    )
  }
  config = loaded.config
}
// 注: configVersion の照合は共通パターンでは throw だが、run-release は FR-06 AC-1 により
// 「違反時は何も変更せず通知して return」が必要なため、Gate 0 の違反項目として扱う

const automation = config.automation || {}
const maxFixIterationsCheck = automation.maxFixIterationsCheck ?? 5
const maxFixIterationsReview = automation.maxFixIterationsReview ?? 3
const maxGate1RerunsPerReviewFix = automation.maxGate1RerunsPerReviewFix ?? 2
const maxTotalCheckRuns = automation.maxTotalCheckRuns ?? 10
const maxAgentInvocations = automation.maxAgentInvocations ?? 80
// 修正エージェント 1 体に渡す所見の上限。Cost(T) = T·B + g·T²/2 の二次項を分割で 1/k にする狙い
// (実測では 1 体に全件渡した結果 208 ターン・44.6M を消費し、その 81% が二次項だった)。
// 再オリエンテーションの費用を差し引いても、T ≒ 37 ターンを超える見込みなら分割が得になる。
// 既定は 0.7.0 で 4 → 2。上限 4 でも 4 件グループが 256 ターン(68.8M)・3 件が 208 ターン(29.9M)を消費し、
// 1 件あたりの重さの差(数倍)を件数上限では吸収できなかった(導入先の実測)
const maxFindingsPerFix = automation.maxFindingsPerFix ?? 2
// 修正エージェント 1 体のツール呼び出しの目安(超えたら引き継ぎ)。0 で無効
const maxToolCallsPerAgent = Number.isInteger(automation.maxToolCallsPerAgent)
  ? automation.maxToolCallsPerAgent
  : 60
// 1 修正グループあたりの引き継ぎ回数の上限。超えても partial なら申告済みの所見だけを結果とし、
// 未申告の block 所見は次ラウンドへ持ち越される(M1 の持ち越し)
const maxAgentContinuations = Number.isInteger(automation.maxAgentContinuations)
  ? automation.maxAgentContinuations
  : 2
const gateRaw = automation.severityGate || {}
const severityGate = {
  block: Array.isArray(gateRaw.block) ? gateRaw.block : ['critical', 'high'],
  fixOnce: Array.isArray(gateRaw.fixOnce) ? gateRaw.fixOnce : ['medium'],
  backlogOnly: Array.isArray(gateRaw.backlogOnly) ? gateRaw.backlogOnly : ['low'],
}
const autoApprove =
  typeof input.autoApprove === 'boolean' ? input.autoApprove : automation.autoApprove === true
const baseBranch = config.baseBranch || 'main'
const MODELS = config.models || {}
const EFFORTS = config.efforts || {}
const reqPath = (config.requirementsPath || 'docs/releases/{release}/requirements.md').replace(
  '{release}',
  release
)

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

/**
 * 作業方針。実装・修正エージェント共通の第 2 の共有ブロックで、TOOL_POLICY の直後に置く
 * (TOOL_POLICY はバイト一致テストで固定しているため触らない)。implement-feature.js と同一内容(テストで固定)。
 *
 * 導入先の実測(+18,500 行のリリース、実装 16 体): tool_result の 65% が Read で、全文 Read が部分 Read の
 * 2.5 倍、最長の体はブラウザ MCP を 37 回呼んで dev サーバを立てて画面確認していた。
 */
const WORK_POLICY = `## 作業方針(実装・修正エージェント共通)

- 500 行を超えるファイルは全文 Read しない。Grep で当たりを付けてから offset / limit で必要な範囲だけ読む
- テストは変更対象(ファイル・ディレクトリ)に絞って実行する。全体実行は完了報告の直前に 1 回だけ
- 作業項目・所見が明示的に求めない限り、ブラウザ操作・dev サーバ起動・プレビュー系ツール(preview_start / navigate / computer 等)は使わない。動作確認は検査コマンドと後工程の検証が担う
`

/**
 * ツール呼び出しのソフト上限。ランタイムに maxTurns 相当は無いので、エージェント自身に「約 n 回で切り上げて
 * 残作業を報告する」よう指示し、続きは別の体が引き継ぐ。1 体の会話が伸びるほど毎ターンのコストが二乗で
 * 増える(実測: 4 件の修正で 256 ターン・68.8M)。n が 0 なら指示しない。
 * 遵守率は実測で確かめること(usage-report.py の turns/agent)。
 */
function softCapInstruction(n) {
  return n > 0
    ? `- ツール呼び出しがおおよそ ${n} 回に達したら、キリのよいところ(編集が整合した状態)で作業を止め、status: "partial" として残作業を remaining に書いて報告する(変更したファイルも報告する)。続きは別のエージェントが引き継ぐので、無理に 1 体で完走しないこと\n`
    : ''
}

// ---- 通知(AC-11): 失敗してもパイプラインを止めない ----
// agent() は失敗時に throw せず null を返すため、結果を検査してログするだけでよい

/** push 通知を送る。bark 送信スクリプトが無ければ osascript にフォールバックする。 */
async function notify(title, message) {
  const r = await trackedAgent(
    'notify',
    TOOL_POLICY +
    'push 通知を bash で送信してください。手順:\n' +
      '1. ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/hooks/" で名前に bark を含む送信スクリプトを探す(CLAUDE_CONFIG_DIR 未設定なら ~/.claude)\n' +
      '2. あればスクリプト本体を読んで入力仕様(stdin の JSON キー・引数等)を把握し、それに従って呼び出して通知を送る\n' +
      '3. スクリプトが無い・必要な入力を揃えられない・送信に失敗した場合は、osascript -e \'display notification "<本文>" with title "<タイトル>"\' にフォールバックする\n' +
      '4. どの手段も失敗した場合も異常終了せず sent: false で報告する\n' +
      `\n通知タイトル: ${title}\n通知本文: ${message}`,
    {
      label: '通知送信',
      role: 'notify',
      phase: '通知',
      schema: {
        type: 'object',
        required: ['sent'],
        properties: {
          sent: { type: 'boolean' },
          method: { type: 'string', description: '使用した送信手段(bark/osascript 等)' },
        },
      },
      ...modelAndEffort('bootstrap', MODELS, EFFORTS),
    }
  )
  if (!r || r.sent !== true) {
    log(`通知の送信に失敗しましたが処理は継続します: ${title}`)
  }
}

// ---- 起票(AC-6): record-known-issues は新設のため scriptPath 指定で起動する ----
// 注意: workflow() の相対 scriptPath の解決基準は親の起動方法によって変わる(いずれも実測):
// - 親を相対パスで起動 → 親スクリプトのディレクトリ基準。ファイル名単独指定が正しく解決される
// - 親を絶対パスで resume 起動 → cwd(リポジトリルート)基準に切り替わり、ファイル名単独指定は
//   <repo>/record-known-issues.js に解決されて file not found になる
// そのため cwd 基準のフルパスを先に試し、「script file not found」のときのみファイル名単独へ
// フォールバックする二段構えとする。catch を広げすぎると子ワークフローの業務エラーまで拾って
// 誤パス再試行し、本来のエラーを file not found で上書きしてしまうためメッセージ判定で絞る
const filedIssues = []
let resolvedLogProposal = null
// requirements.md が FR に明記した既知課題 ID を実際に解決済みログへ移動した結果(能動的工程。後述)。
// resolvedLogProposal(record-known-issues 由来の受動的・opportunistic な提案)とは別枠で扱う
const resolvedKnownIssues = []
// 周ごとの Codex 委譲の実態(review-changes の戻り値 codex)。PR 本文・戻り値・state.json へ載せる。
// 従来は run-release がこの値を捨てていたため、Codex 層が枠切れや分類器遮断で欠落しても
// 「Codex 併用で通った」ように見えた(導入先 2 プロジェクトで計 3 回観測)
const codexRounds = []
// 修正エージェントが 2 ラウンド続けて「修正不要(skipped)」と申告した block 所見(理由つき)。
// 黙って落とさず PR 本文で開示する
const fixWaived = []
// 解説レポート(/explain-release)の材料。工程が進むたびに差し替え、どの終了経路でもその時点の最新を
// 戻り値へ載せる: 実装前の停止は null、実装後は implementation のみ、prMaterial 構築後はその全体、
// PR 作成分岐の後は isDraft・draftReasons も(未確定の経路では省く)。従来 prMaterial は PR 本文生成
// エージェントへ渡すだけで、戻り値には prBodyDraft に要約された形でしか残らなかった
let reportMaterial = null

/**
 * 戻り値に載せる reportMaterial。totalAgents は prMaterial 構築時点の値なので、終了時点の値へ差し替える
 * (差し替えないとコミット・PR 作成・通知ぶんだけ consumption の合計と食い違う)。
 */
function reportMaterialNow() {
  return reportMaterial && Object.prototype.hasOwnProperty.call(reportMaterial, 'totalAgents')
    ? { ...reportMaterial, totalAgents }
    : reportMaterial
}

/** 所見を record-known-issues ワークフローで起票し、結果を filedIssues に集約する。 */
async function fileKnownIssues(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return
  let r
  try {
    r = await workflow({ scriptPath: '.claude/workflows/record-known-issues.js' }, { config, findings })
  } catch (e) {
    if (!/script file not found/i.test(String(e && e.message))) throw e
    r = await workflow({ scriptPath: 'record-known-issues.js' }, { config, findings })
  }
  addConsumption('triage', agentsUsedOf(r, 1))
  if (r && Number.isInteger(r.proseViolations)) proseLint.knownIssues += r.proseViolations
  if (r && Number.isInteger(r.unlinted)) proseLint.knownIssuesUnchecked += r.unlinted
  if (!r) {
    log('record-known-issues が結果を返さなかったため、起票結果を確認できませんでした')
    return
  }
  if (Array.isArray(r.filed)) filedIssues.push(...r.filed)
  if (Array.isArray(r.appendedTo)) filedIssues.push(...r.appendedTo)
  if (r.resolvedLogProposal) resolvedLogProposal = r.resolvedLogProposal
}

/** 停止・完了時の共通処理: 通知を送り、契約どおりの戻り値を組み立てる。 */
async function finishWith(status, stopReason, extra) {
  await notify(`run-release: ${status}`, `${release}: ${stopReason || '完了'}`)
  return {
    status,
    stopReason,
    filedIssues,
    resolvedLogProposal,
    resolvedKnownIssues,
    consumption,
    codexReview: codexRounds,
    proseLint,
    fixWaived,
    reportMaterial: reportMaterialNow(),
    ...(extra || {}),
  }
}

// ---- 収束判定(AC-3): 失敗署名 = check キー + 正規化済み failedItems のソート済み JSON ----

/** release-check の失敗 1 件から収束判定用の署名を作る。 */
function failureSignature(f) {
  const items = Array.isArray(f.failedItems) ? f.failedItems.map((s) => String(s).trim()) : []
  return `${String(f.check || '').trim()}::${JSON.stringify([...items].sort())}`
}

// ---- テスト不変ガード付き修正(maker/checker 分離) ----
const guardViolations = [] // ガード違反の起票用(復元済みでも記録は残す)
/** 検査失敗の修正で「直した」と申告された検査(PR 本文へ)。0.8.1 までは Gate1 の修正結果を捨てていた。 */
const checkFixed = []
/**
 * 読者向けの文章の機械検査(lintProse)で見つかった違反の件数。prBody は出し直し後の PR 本文、knownIssues・docs は
 * 子ワークフローが出し直し後に数えた件数、reviewTitles はレビューの指摘の件名(出し直さず数えるだけ)。
 */
const proseLint = { prBody: null, knownIssues: 0, knownIssuesUnchecked: 0, docs: 0, reviewTitles: 0 }
/**
 * 修正エージェントが要件ファイルを書き換えたので元に戻した記録(PR 本文へ)。要件は人が壁打ちで確定したもので、
 * 修正の都合で無人で変えてはいけない(導入先で、所見に対してコードを変えず要件だけ書き換えて fixed を返し、
 * その変更が文書同期のコミットに混ざって承認なしで入った)。
 */
const requirementEdits = []

// ---- このリリースが作ったファイル(run の途中で人が足したファイルと区別する) ----
/**
 * このリリースの工程が作った・変えたファイル(リポジトリルート相対)。null は判定不能で、区別をしない。
 * 実装直後の差分照合の結果から始め、修正のたびに「修正の前後で増えた未追跡ファイル」と修正体の申告を足す。
 * 区別が要る理由(導入先で発生): run の途中で人が追加したモック HTML を lint が拾い、修正体が 17 回の Edit で
 * 書き換えた。そのまま進めばリリースのコミットにも混ざっていた。
 */
let ownedFiles = null
/** リリース外と判定した未追跡ファイル。修正体には触らせず、コミットにも入れない。 */
const foreignFiles = new Set()
/**
 * 直前の修正の前後で未追跡ファイルの一覧が取れず、その修正が作ったファイルを特定できなかったか。
 * 立っていたら、次の修正の直前に見えた未追跡ファイルを所有扱いにする(リリースのファイルを誤って
 * リリース外にしてコミットから漏らすより、人の追加ファイルを取り込むほうを選ぶ)。
 */
let untrackedGap = false
/** リポジトリルートの絶対パス(preflight が返す)。エージェントが絶対パスで報告したときに剥がす。 */
let repoRootAbs = null
/**
 * 人の判断が要る要件書への指摘(PR 本文へ)。レビューが要件ファイルを指し検証を通った所見(review-changes の
 * requirementFindings)と、修正エージェントが「要件の変更が必要」と判断した所見の 2 種類。
 * どちらも修正ループには入れない — 要件の変更は壁打ちで確定した内容の変更なので、無人で決めない。
 */
const requirementIssues = []

/** パスの表記ゆれ(前後空白・リポジトリルートの接頭辞・先頭の ./)を照合用に正規化する。 */
function normPath(p) {
  const t = String(p || '').trim()
  const rel = repoRootAbs && t.startsWith(`${repoRootAbs}/`) ? t.slice(repoRootAbs.length + 1) : t
  return rel.replace(/^\.\//, '')
}

/** シェルのシングルクォートで囲む(パスに ' が含まれても壊れないように)。 */
function shq(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`
}

/**
 * 作業ツリーの内容の指紋(40 桁の 16 進)を出すシェルコマンド。run-release は「最後に通った検査の直前の指紋」と
 * 「最終検査の直前の指紋」が一致したら最終検査を省く。追跡ファイル(index と作業ツリー)は `git stash create` の
 * tree で、未追跡ファイルは名前と内容のハッシュで数える。どちらも内容だけで決まるので、時間を空けても同じ値になる。
 * release-check と run-release に同じ本文を置き、バイト一致をテストで固定している。
 */
const TREE_FINGERPRINT_CMD =
  '{ s=$(git stash create); git rev-parse "${s:-HEAD}^{tree}"; git ls-files --others --exclude-standard; ' +
  'git ls-files --others --exclude-standard -z | xargs -0 git hash-object --; } | git hash-object --stdin'

/**
 * 本文生成体が書いた PR 本文ファイルを `<file>.final` へ複製し、エンジンが足す節(draft 理由・コミットしなかった
 * ファイル)を追記するシェルコマンド。元ファイルへ直接追記しないのは、再実行で節が二重に付かないようにするため。
 */
function prBodyCommand(file, suffix, then) {
  const final = shq(`${file}.final`)
  // 前の run の .final を残さない・途中で失敗したら then(gh pr create)まで進まない
  const copy = `rm -f ${final} && cp ${shq(file)} ${final}`
  if (!suffix) return `${copy} && ${then}`
  return `${copy} && cat >> ${final} <<'CRW_PR_BODY_EOF' && ${then}\n${suffix}\nCRW_PR_BODY_EOF`
}

/** このリリースのファイルとして記録する。既にリリース外と判定したファイルは記録しない(ログだけ出す)。 */
function noteOwned(paths) {
  if (!ownedFiles || !Array.isArray(paths)) return
  paths.map(normPath).filter(Boolean).forEach((p) => {
    if (foreignFiles.has(p)) {
      log(`注: リリース外と判定したファイル ${p} を修正エージェントが変更したと申告しました(コミットには含めません)`)
      return
    }
    ownedFiles.add(p)
  })
}

/** 未追跡ファイル一覧のうち、このリリースのものでないファイルをリリース外として記録し、その一覧を返す。 */
function noteForeign(untracked) {
  if (!ownedFiles || !Array.isArray(untracked)) return []
  const found = untracked.map(normPath).filter((p) => p && !ownedFiles.has(p))
  found.forEach((p) => foreignFiles.add(p))
  return found
}

/** 変更マップからリリース外のファイルを除く(レビュー・文書同期に見せない)。変更マップが無ければ null。 */
function withoutForeign(cm) {
  if (!cm || foreignFiles.size === 0) return cm
  const manifest = cm.manifest.filter((m) => !foreignFiles.has(normPath(m.path)))
  // 件数も揃える(受け取り側の validChangeMap が件数で照合するため)
  return {
    ...cm,
    manifest,
    untracked: (Array.isArray(cm.untracked) ? cm.untracked : []).filter((p) => !foreignFiles.has(normPath(p))),
    trackedCount: manifest.filter((m) => m.untracked !== true).length,
    untrackedCount: manifest.filter((m) => m.untracked === true).length,
  }
}

/** 修正プロンプトに付けるリリース外ファイルの注意書き(該当が無ければ空文字)。 */
function foreignFilesBlock(list) {
  if (!list || list.length === 0) return ''
  const shown = list.slice(0, 50)
  return (
    '\n\n## リリース外のファイル(編集・削除しないこと)\n' +
    '次の未追跡ファイルはこのリリースの工程が作ったものではない(run の途中で人が追加した可能性がある)。' +
    '読むのはよいが、編集・削除しないこと。これらが原因の検査失敗・所見は直さずに status: "not-fixed" とし、' +
    'reason を「リリース外のファイルが原因:」で始めてパスを書くこと。' +
    '一覧に無くても、所見・検査の失敗箇所と関係のない未追跡ファイルは編集しないこと。\n' +
    shown.map((p) => `- ${p}`).join('\n') +
    (list.length > shown.length ? `\n- ほか ${list.length - shown.length} 件` : '')
  )
}

/**
 * 修正エージェントの戻り値。**渡した項目ごとの status を必須**にする。
 *
 * 導入先の実測では、担当 4 件を渡された修正エージェントが 1 件だけ直して
 * "My fix is complete." と自由文で報告し、エンジンは戻り値が非 null であることだけを「試行済み」の
 * 根拠にしていたため、残り 3 件(high の TOCTOU を含む)が黙って次周へ流れた。件ごとの申告を求めれば、
 * 少なくとも「直していない」ことがエンジンに見える(申告の正しさは M4 の修正検証で裏を取る)。
 */
const FIX_SCHEMA = {
  type: 'object',
  required: ['results', 'summary'],
  properties: {
    results: {
      type: 'array',
      description: '渡された項目(所見タイトル / 検査 key)ごとの結果。**渡された項目はすべて含めること**',
      items: {
        type: 'object',
        required: ['title', 'status'],
        properties: {
          id: { type: 'string', description: '渡された所見の ID(「ID: 」の後ろの文字列をそのまま。照合に使う)。検査失敗の修正では省略してよい' },
          title: {
            type: 'string',
            description: '渡された所見のタイトル(ID が無いときの照合に使う)。検査失敗の修正なら check の key',
          },
          status: {
            type: 'string',
            enum: ['fixed', 'not-fixed', 'skipped'],
            description:
              'fixed=修正した / not-fixed=修正を試みたが直せなかった(reason 必須) / skipped=修正不要と判断した(reason 必須。既に解消済み・誤検出など)',
          },
          reason: {
            type: 'string',
            description:
              '直した・直さなかった根拠。対象(パス・関数名)と確かめた方法(実行したコマンドとその結果、読んだコード)を書く。「対応済み」「問題なし」だけにしない',
          },
          changedFiles: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    summary: {
      type: 'string',
      description: '直したファイルごとに何をどう変えたか、判断に迷った点と選んだ理由(推測は「推測:」と根拠)',
    },
    status: {
      type: 'string',
      enum: ['done', 'partial'],
      description: 'done=担当分を処理し終えた / partial=ツール呼び出しの上限で切り上げた(remaining 必須。続きは別の担当が引き継ぐ)',
    },
    remaining: {
      type: 'string',
      description: 'partial のとき、残作業を次の担当がそのまま着手できる粒度で(どの所見のどこまで済んだか)',
    },
  },
}

/**
 * 修正エージェント(maker)を起動し、fix 前スナップショットとの増分 diff で
 * テストの skip 化・期待値改変・削除がないかを checker に検査させる。
 * 違反したテストファイルはスナップショットから復元する。
 *
 * @param instruction 修正内容の指示文。
 * @param phaseName ログ用のフェーズ名。
 * @param phaseKey 消費カウンタのキー。
 * @returns {fixed, results, guard, snapshotRef, changedFiles, changeMap} — fixed は修正エージェントが結果を
 *   返したか。results は項目ごとの申告(FIX_SCHEMA.results。取れなければ null)。snapshotRef は
 *   取得した fix 前スナップショット参照(取得失敗時 null。呼び出し元での差分スコープ算出に使う)。
 */
async function fixWithGuard(instruction, phaseName, phaseKey, opts) {
  const withScope = Boolean(opts && opts.withScope)
  const changeMapTag = opts && typeof opts.changeMapTag === 'string' ? opts.changeMapTag : null
  // 修正を複数グループに分割したとき、変更ファイル一覧は**最初のグループの**スナップショット起点で
  // 取らないと先行グループの変更が抜け落ちる(各 fixWithGuard は自分の直前でスナップショットを取るため)。
  // ガード検査自体は各グループの増分に対して行うので、こちらは自分の snapshotRef のままでよい
  const scopeBaseRef = opts && typeof opts.scopeBaseRef === 'string' ? opts.scopeBaseRef : null
  // 直前のグループのガード体が取った「次のスナップショット」があれば使う(同じ修正バッチ内で、間に
  // 何も走っていないときだけ呼び出し元が渡す)。無ければ自分で取る
  const given =
    opts && opts.snapshot && typeof opts.snapshot.ref === 'string' && opts.snapshot.ref.trim() && Array.isArray(opts.snapshot.untracked)
      ? opts.snapshot
      : null
  const wantsNextSnapshot = Boolean(opts && opts.wantsNextSnapshot)
  // fix 前スナップショット参照の取得(git stash create は作業ツリーを変更しない)
  const snap = given || await trackedAgent(
    phaseKey,
    TOOL_POLICY +
    'git stash create を実行し、出力されたコミット ID を ref として返してください。出力が空(未コミット変更なし)の場合は git rev-parse HEAD の出力を ref として返すこと。' +
      'あわせて git ls-files --others --exclude-standard の出力を、1 行 1 パスの配列 untracked として返すこと(加工・省略しない。無ければ [])。' +
      'リポジトリの状態を変更するコマンド(stash push/apply/pop、add、checkout 等)は実行禁止。',
    {
      label: 'fix前スナップショット',
      role: 'snapshot',
      phase: phaseName,
      schema: {
        type: 'object',
        required: ['ref', 'untracked'],
        properties: {
          ref: { type: 'string' },
          untracked: { type: 'array', items: { type: 'string' }, description: '修正前の未追跡ファイル' },
        },
      },
      ...modelAndEffort('bootstrap', MODELS, EFFORTS),
    }
  )
  const snapshotRef = snap && typeof snap.ref === 'string' ? snap.ref.trim() : null
  // 修正前の未追跡ファイル。修正後の一覧との差がこの修正で作られたファイル、所有集合に無いものがリリース外
  const untrackedBefore = snap && Array.isArray(snap.untracked) ? snap.untracked.map(normPath).filter(Boolean) : null
  if (untrackedBefore && untrackedGap) {
    // 前の修正が作ったファイルを特定できなかった: いま見えている未追跡ファイルは所有扱いにする
    log('注: 直前の修正で未追跡ファイルの前後比較ができなかったため、現在の未追跡ファイルをリリースのファイルとして扱います')
    noteOwned(untrackedBefore)
    untrackedGap = false
  }
  const foreignNow = untrackedBefore ? noteForeign(untrackedBefore) : [...foreignFiles]
  if (foreignNow.length > 0) {
    log(`リリース外の未追跡ファイル ${foreignNow.length} 件を修正対象から外します: ${foreignNow.slice(0, 5).join(', ')}${foreignNow.length > 5 ? ' ほか' : ''}`)
  }

  // 前置きは TOOL_POLICY → WORK_POLICY → ソフト上限 → 指示の順(共有部を先頭に置いて前方一致キャッシュに載せる)。
  // 最後の引き継ぎ先(finisher)はソフト上限を外して完走させる — 上限は最適化であって、
  // 所見が未申告のまま持ち越し・残存へ転がる理由にしてはいけない
  const fixBody = `\n${instruction}\n\n制約:\n- あなたは修正の実施者(maker)であり、修正後の合否判定はしない(再検査は別工程が行う)\n- テストの skip 化・既存期待値の意図的な書き換え・テスト削除によって検査を回避することは禁止\n- 修正は必要最小限にすること\n- 要件ファイル ${reqPath} は編集しないこと(要件は人が確定したもの)。所見を解消するには要件の変更が必要だと判断した場合は、コードも要件も変えずに status: "skipped" とし、reason を「要件の変更が必要:」で始めて、どの FR・AC をどう変える必要があるかを書く\n- **渡された項目はすべて results に載せること。** 直せなかった項目は not-fixed、修正不要と判断した項目は skipped とし、いずれも reason に根拠を書く。id には所見の「ID: 」の後ろの文字列を、title には渡されたタイトルをそのまま書く(照合に使うため)。results に無い項目は「未着手」として扱われ、次ラウンドで再度修正対象になる\n- 処理し終えたら status: "done"、切り上げたら status: "partial"(その時点までの申告を results に、残りを remaining に)`
  const fixPromptCapped = `${TOOL_POLICY}${WORK_POLICY}${WRITING_POLICY}${softCapInstruction(maxToolCallsPerAgent)}${fixBody}`
  const fixPromptUncapped = `${TOOL_POLICY}${WORK_POLICY}${WRITING_POLICY}${fixBody}`
  // partial で切り上げた体の申告・残作業を次の体へ渡す(床からの再スタートなので二次項が 1/k になる)。
  // 申告は title で統合し、後の体の申告が前の体のものを上書きする
  let fixed = null
  const mergedResults = new Map()
  let handoff = null
  for (let k = 0; ; k++) {
    const finisher = k >= maxAgentContinuations
    const handoffBlock = handoff
      ? `\n\n## 引き継ぎ(前の担当がツール呼び出しの上限で切り上げた。ここから続けること。済んだ修正をやり直さない)\n前の担当の申告: ${JSON.stringify(handoff.results)}\n前の担当の報告: ${handoff.summary}\n残作業: ${handoff.remaining}${
          finisher
            ? '\n\nあなたはこの修正の最後の担当。ツール呼び出しの目安は適用しないので、切り上げずに担当分すべての申告(status: "done")まで進めること'
            : ''
        }`
      : ''
    fixed = await trackedAgent(phaseKey, `${finisher ? fixPromptUncapped : fixPromptCapped}${foreignFilesBlock(foreignNow)}${handoffBlock}`, {
      label: k === 0 ? '修正' : `修正(引き継ぎ ${k})`,
      role: 'fix',
      phase: phaseName,
      schema: FIX_SCHEMA,
      ...modelAndEffort('fix', MODELS, EFFORTS),
    })
    if (!fixed) break
    ;(Array.isArray(fixed.results) ? fixed.results : []).forEach((x) => {
      if (!x) return
      const k = typeof x.id === 'string' && x.id.trim() ? `id:${x.id.trim()}` : typeof x.title === 'string' ? `t:${x.title.trim()}` : null
      if (!k) return
      // 後の担当の申告で上書きする: ID の有無が前の担当と違っても、同じタイトルの申告は置き換える
      const title = typeof x.title === 'string' ? x.title.trim() : ''
      // ただし双方が別々の ID を持つなら別の所見(同じタイトルの所見が同じグループにある)なので消さない
      const hasId = typeof x.id === 'string' && x.id.trim() !== ''
      if (title) {
        for (const [key, v] of mergedResults) {
          const vHasId = v && typeof v.id === 'string' && v.id.trim() !== ''
          if (key !== k && v && typeof v.title === 'string' && v.title.trim() === title && (!hasId || !vHasId)) mergedResults.delete(key)
        }
      }
      mergedResults.set(k, x)
    })
    if (fixed.status !== 'partial') break
    if (finisher) {
      log('修正の最後の担当も未完のまま切り上げました — 未申告の所見は次ラウンドへ持ち越します')
      break
    }
    log(`修正の引き継ぎ(${k + 1}/${maxAgentContinuations}): ${String(fixed.remaining || '').slice(0, 120)}`)
    handoff = {
      results: [...mergedResults.values()].map((x) => ({ id: x.id, title: x.title, status: x.status })),
      summary: typeof fixed.summary === 'string' ? fixed.summary : '',
      remaining: typeof fixed.remaining === 'string' ? fixed.remaining : '',
    }
  }
  const fixResults = mergedResults.size > 0 ? [...mergedResults.values()] : fixed && Array.isArray(fixed.results) ? fixed.results : null
  // 途中の体が失敗しても、先行する体の申告があれば「修正が走った」とみなす
  const fixRan = fixed !== null || mergedResults.size > 0

  // 修正体が申告した変更ファイルはこのリリースのもの(リリース外と判定済みのものを除く)
  noteOwned((fixResults || []).flatMap((x) => (x && Array.isArray(x.changedFiles) ? x.changedFiles : [])))

  if (!snapshotRef) {
    log('fix 前スナップショットが取得できなかったため、テスト不変ガードは検査不能として続行します')
    untrackedGap = true
    return {
      fixed: fixRan,
      results: fixResults,
      guard: { violation: false, files: [], detail: 'スナップショット取得失敗によりガード検査不能' },
      snapshotRef: null,
      changedFiles: null,
      changedTracked: null,
      changeMap: null,
      requirementsChanged: false,
    }
  }

  // ガード検査・変更ファイル一覧・変更マップ再生成はいずれも「この修正による増分差分」を起点にする
  // 同じ読み取りなので 1 体にまとめる(エージェント 1 体の起動には約 34k トークンの床がある)。
  // ただし戻り値のスキーマは分けておき、片方が欠落しても他方は使えるようにする — 統合したことで
  // 3 つの機能が同時に落ちるのを避けるため
  const wantsChangeMap = Boolean(changeMapTag && runDir)
  // 判定 → 復元 → 復元後の読み取り、の順に 1 体で行う(0.8.x までは復元を別の体に任せていた)。
  // 復元が返ってこなかったぶんだけ、後で従来どおり別の体で戻す
  const guard = await trackedAgent(
    phaseKey,
    TOOL_POLICY +
      `テスト不変ガードの検査です。git diff ${snapshotRef} で直前の fix 作業による増分差分を確認し、そのうちテストファイル(プロジェクトのテスト命名規則・テストディレクトリから自分で判別すること)への変更に、検査を通すことだけを目的とした次の改変が含まれていないか検査してください: (a) テストの skip 化(skip/only の付与・無効化) (b) 既存の期待値の改変 (c) テストケースの削除。実装変更に正当に追随する期待値更新や新規テストの追加は違反ではない。判定基準はこの増分差分のみとし、それ以外の差分は対象外。` +
      `\n\nあわせて \`git diff --name-only ${snapshotRef} -- ${shq(reqPath)}\` の出力が空でなければ requirementsChanged: true、空なら false を返すこと(要件ファイルが修正で書き換えられたかの確認)。` +
      `\n\n**判定のあと、次を修正前の状態に戻すこと**: 違反と判定したテストファイル(files に挙げたもの)と、requirementsChanged が true なら要件ファイル ${reqPath}。` +
      `1 ファイルずつ \`git checkout ${snapshotRef} -- '<パス>'\` を実行し(まとめて 1 コマンドにしない。1 つ失敗しても残りは続ける)、戻せたパスを restored に、失敗したパスを restoreFailed に入れる(パスは files の表記、要件ファイルは ${reqPath} の表記のまま)。` +
      'それ以外のファイルには触れないこと。戻すものが無ければ restored: []、restoreFailed: []。' +
      '\n\n**以下は戻したあとの状態で行うこと。** `git ls-files --others --exclude-standard` の出力を 1 行 1 パスの配列 untracked として返す(加工・省略しない。無ければ [])。' +
      (withScope
        ? `\n\nあわせて、\`git diff --name-only ${scopeBaseRef || snapshotRef}\` と \`git ls-files --others --exclude-standard\` の両方を実行し、` +
          '出力パスを結合して重複を除いた一覧を changedFiles として返してください' +
          '(前者は直前の修正で変更・削除された追跡ファイル、後者は未追跡ファイル。' +
          '後者はスナップショットに含まれないため必須)。該当が無ければ changedFiles: [] を返すこと。' +
          '**あわせて、前者(`git diff --name-only` の出力)だけを changedTracked として別に返すこと**' +
          '(該当が無ければ changedTracked: [])。`git ls-files --others` は増分を返さず未追跡ファイルを' +
          '全件列挙するため、結合した changedFiles だけでは「直前の修正が追跡ファイルを1件も変えていない」' +
          'ことを呼び出し側が判定できない。'
        : '') +
      (wantsChangeMap
        ? `\n\nさらに、変更マップを再生成して changeMap として返してください。次のスクリプトを**改変せず、そのまま 1 回の bash 呼び出しで**実行し(手順に分けて実行しない・コマンドを推測で補わない・出力ファイルはリポジトリ外)、最後に出力される「manifest: <絶対パス>」の manifest.json を Read して、その JSON をそのまま changeMap に入れること(内容の要約・省略・補完は禁止。失敗時は consistent: false、manifest: [])。\n\n` +
          '```bash\n' +
          changeMapScript(`"${runDir}/${changeMapTag}"`, baseBranch) +
          '```'
        : '') +
      (wantsNextSnapshot
        ? '\n\n最後に、次の修正のためのスナップショットとして `git stash create` を実行し、出力されたコミット ID を nextSnapshotRef として返すこと' +
          '(出力が空なら `git rev-parse HEAD` の出力)。stash push/apply/pop・add など状態を変えるコマンドは実行しないこと。'
        : ''),
    {
      label: withScope || wantsChangeMap ? 'テスト不変ガード+差分把握' : 'テスト不変ガード',
      role: 'guard',
      phase: phaseName,
      schema: {
        type: 'object',
        required: ['violation', 'files', 'detail', 'requirementsChanged', 'untracked'],
        properties: {
          violation: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' }, description: '違反があったテストファイル' },
          detail: { type: 'string' },
          changedFiles: { type: 'array', items: { type: 'string' } },
          changedTracked: {
            type: 'array',
            items: { type: 'string' },
            description: '直前の修正で変更・削除された追跡ファイルのみ(git diff --name-only の出力)',
          },
          changeMap: CHANGEMAP_SCHEMA,
          requirementsChanged: { type: 'boolean', description: `要件ファイル ${reqPath} が修正で書き換えられたか` },
          untracked: { type: 'array', items: { type: 'string' }, description: '修正後(復元後)の未追跡ファイル' },
          restored: { type: 'array', items: { type: 'string' }, description: '修正前の状態に戻せたファイル' },
          restoreFailed: { type: 'array', items: { type: 'string' }, description: '戻そうとして失敗したファイル' },
          nextSnapshotRef: { type: 'string', description: '頼まれたときだけ: 復元後の git stash create の出力' },
        },
      },
      ...modelAndEffort('verify', MODELS, EFFORTS),
    }
  )

  // 修正の前後で増えた未追跡ファイルは、この修正が作ったもの = このリリースのファイル
  const untrackedAfter = guard && Array.isArray(guard.untracked) ? guard.untracked.map(normPath).filter(Boolean) : null
  if (untrackedBefore && untrackedAfter) {
    const before = new Set(untrackedBefore)
    noteOwned(untrackedAfter.filter((p) => !before.has(p)))
  } else {
    untrackedGap = true
  }

  const restoreFiles = []
  if (guard && guard.violation === true) {
    const files = Array.isArray(guard.files) ? guard.files : []
    guardViolations.push({
      source: 'check',
      checkKey: 'test-guard',
      severity: 'high',
      title: '自動修正がテストを改変したので修正前に戻した(skip 化・期待値の書き換え・テストの削除のいずれか)',
      detail: `${guard.detail}${files.length > 0 ? `(対象: ${files.join(', ')}。修正前の状態に戻した)` : ''}`,
    })
    if (files.length > 0) {
      log(`テスト不変ガード違反: ${files.join(', ')} — fix 前の状態に復元します`)
      restoreFiles.push(...files)
    }
  }
  const requirementsChanged = Boolean(guard && guard.requirementsChanged === true)
  if (requirementsChanged) {
    log(`修正エージェントが要件ファイル ${reqPath} を書き換えたため、修正前の状態に戻します(要件の変更は人が判断する)`)
    restoreFiles.push(reqPath)
  }
  // ガード体が戻したと申告したもの。戻っていないもの(申告が無い・失敗)だけを別の体でもう一度戻す
  const restoredByGuard = new Set(guard && Array.isArray(guard.restored) ? guard.restored.map(normPath) : [])
  const restoreLeft = restoreFiles.filter((p) => !restoredByGuard.has(normPath(p)))
  const restoredList = [...restoredByGuard]
  if (restoreLeft.length > 0) {
    // 1 パスずつ戻させる: まとめて 1 コマンドにすると、1 つのパスが一致しないだけで全体が止まり要件ファイルも戻らない
    const again = await trackedAgent(
      phaseKey,
      TOOL_POLICY +
      '次のファイルを修正前の状態に戻してください。ファイルごとに 1 コマンドずつ実行し、それ以外のファイルには触れないこと。' +
        '戻せたファイルを restored に、失敗したファイルを failed に入れて返すこと(パスは下の一覧の表記のまま)。\n' +
        restoreLeft.map((p) => `- git checkout ${snapshotRef} -- ${shq(p)}`).join('\n'),
      {
        label: 'テスト復元',
        role: 'guard',
        phase: phaseName,
        schema: {
          type: 'object',
          required: ['restored', 'failed'],
          properties: {
            restored: { type: 'array', items: { type: 'string' } },
            failed: { type: 'array', items: { type: 'string' } },
          },
        },
        ...modelAndEffort('bootstrap', MODELS, EFFORTS),
      }
    )
    if (again && Array.isArray(again.restored)) restoredList.push(...again.restored.map(normPath))
  }
  if (requirementsChanged) {
    const ok = restoredList.includes(normPath(reqPath))
    requirementEdits.push({ phase: phaseName, file: reqPath, restored: ok })
    if (!ok) {
      log(`要件ファイル ${reqPath} を修正前に戻せませんでした(PR 本文と起票で明示します)`)
      guardViolations.push({
        source: 'check',
        checkKey: 'requirements-guard',
        severity: 'high',
        title: `自動修正が書き換えた要件ファイル ${reqPath} を元に戻せなかった`,
        detail: `「${plainPhase(phaseName)}」で ${reqPath} に差分が出たため git checkout ${snapshotRef} で戻そうとしたが、成功を確認できなかった。要件の差分を目視で確認し、意図しない変更なら手で戻すこと`,
      })
    }
  }
  // 部分欠落の個別フォールバック: changedFiles が取れなければ次回は全差分レビュー、
  // changeMap が取れなければ下流は従来どおり自分で git diff を叩く
  const changedFiles =
    guard && Array.isArray(guard.changedFiles) ? guard.changedFiles.filter(Boolean) : null
  // 取れなければ null(= 旧挙動へフォールバック)。空配列 [] は「追跡ファイルの変更が 1 件も無い」
  // という意味を持つので null と区別する
  const changedTracked =
    guard && Array.isArray(guard.changedTracked) ? guard.changedTracked.filter(Boolean) : null
  const changeMapRejects = []
  const changeMap =
    wantsChangeMap && guard && guard.changeMap
      ? validChangeMap(guard.changeMap, `${runDir}/${changeMapTag}`, changeMapRejects)
      : null
  if (changeMapRejects.length > 0) {
    log(`再生成した変更マップは使いません(次のレビューは各自が git diff で差分を特定します): ${changeMapRejects.join(' / ')}`)
  }
  // 次のグループのスナップショット。形が崩れていれば渡さない(次のグループが自分で取る)
  const nextRef = guard && typeof guard.nextSnapshotRef === 'string' ? guard.nextSnapshotRef.trim() : ''
  const nextSnapshot =
    // 復元体が後から戻したファイルがあると、ガード体が取った参照は「戻す前」の状態を指す(使うと次のグループの
    // ガードが戻した差分を改変とみなし、書き換えられた要件やテストを作業ツリーへ戻してしまう)
    wantsNextSnapshot && restoreLeft.length === 0 && /^[0-9a-f]{7,40}$/i.test(nextRef) && untrackedAfter
      ? { ref: nextRef, untracked: untrackedAfter }
      : null
  return {
    fixed: fixRan,
    results: fixResults,
    guard: guard || { violation: false, files: [], detail: 'ガード検査エージェントが結果を返しませんでした' },
    snapshotRef,
    changedFiles,
    changedTracked,
    changeMap,
    requirementsChanged,
    nextSnapshot,
  }
}

/**
 * 工程名(進捗表示と state.json の再開判定に使う内部名)を、PR 本文・既知課題に書く読者向けの名前にする。
 * 保存する値は内部名のまま(再開判定が `startsWith('Gate2')` で見ている)で、表示するときだけ変換する。
 */
/** 工程別の起動数を、読者向けの工程名をキーにした形へ写す(PR 本文・解説レポートの材料用。戻り値の consumption は内部名のまま)。 */
function plainConsumption(c) {
  const NAMES = {
    bootstrap: '設定の読み込み',
    gate0: '開始前の事前検査・進捗の保存',
    implement: '実装',
    gate1: '実装後の検査と修正',
    gate2: 'レビューと修正',
    triage: '既知課題の起票',
    docs: '文書同期',
    finalCheck: '最終検査',
    pr: '受け入れ基準の照合・既知課題の解決済みログ移動・PR 本文・PR 作成',
    commit: 'コミット',
    notify: '通知',
  }
  const out = {}
  for (const [k, n] of Object.entries(c || {})) out[NAMES[k] || k] = (out[NAMES[k] || k] || 0) + n
  return out
}

function plainPhase(name) {
  const n = String(name || '')
  if (n.startsWith('Gate1')) return '実装後の検査と修正'
  if (n.startsWith('Gate2')) return 'レビューの指摘の修正'
  if (n === 'PR準備') return '最終検査の修正'
  return n
}

// ---- Gate1 検査ループ(AC-3。最終検査の別枠ループ・レビュー後の再実行にも再利用する) ----

/** 最後に走った release-check が通ったときの {fingerprint, check}。失敗した検査が走ったら null に戻す。 */
let lastPassedTree = null

/**
 * release-check → 失敗なら修正 → 再検査を繰り返す。
 * 収束不能条件: 同一失敗署名の 2 回連続出現 / 修正回数上限 / 通算検査回数上限 / エージェント予算超過。
 *
 * @param maxFixes 修正イテレーションの上限回数。
 * @param phaseName ログ用のフェーズ名。
 * @param phaseKey 消費カウンタのキー。
 * @param contextNote 収束不能理由に付記する文脈ラベル。
 * @param fixOpts 修正ごとの fixWithGuard オプション(Gate2 からの再実行で、再レビュースコープと変更マップを取り直すのに使う)。
 * @returns {passed, nonConvergence, reason?, lastCheck, lastFix} — lastCheck は最後の release-check 結果、
 *   lastFix はこのループで最後に走った修正の fixWithGuard の戻り値(修正が走らなければ null)。
 */
async function gate1Loop(maxFixes, phaseName, phaseKey, contextNote, fixOpts) {
  let prevSignatures = null
  let lastCheck = null
  let lastFix = null
  // 最終検査のために 1 回ぶんを残す(0.8.1 までは Gate2 で使い切ると最終検査が一度も走らなかった)
  // 上限が 2 以下のときは確保しない(確保すると Gate2 の修正後の再検査が即座に上限到達になる)
  const runCap = phaseKey === 'finalCheck' || maxTotalCheckRuns < 3 ? maxTotalCheckRuns : maxTotalCheckRuns - 1
  // 修正体が「直した」と申告した検査。次の検査で実際に通ったものだけを checkFixed に載せる
  let pendingFixed = []
  for (let attempt = 0; ; attempt++) {
    if (checkRunsTotal >= runCap) {
      return {
        passed: false,
        nonConvergence: true,
        reason: `release-check の通算実行回数が上限(${runCap}${runCap < maxTotalCheckRuns ? '。最終検査の 1 回を残した値' : ''})に達しました`,
        lastCheck,
        lastFix,
      }
    }
    if (budgetExceeded()) {
      return {
        passed: false,
        nonConvergence: true,
        reason: `エージェント起動数が上限(${maxAgentInvocations})を超過しました`,
        lastCheck,
        lastFix,
      }
    }
    checkRunsTotal++
    const check = await workflow('release-check', { config })
    addConsumption(
      phaseKey,
      agentsUsedOf(check, check && Array.isArray(check.results) ? check.results.length : 1)
    )
    if (!check) {
      return { passed: false, nonConvergence: true, reason: 'release-check が結果を返しませんでした', lastCheck, lastFix }
    }
    lastCheck = check
    // 最後に走った検査が通っていて、その直前の指紋が取れているときだけ覚える(最終検査を省けるかの判定材料)
    lastPassedTree =
      check.passed === true && typeof check.treeFingerprint === 'string' && /^[0-9a-f]{40}$/.test(check.treeFingerprint)
        ? { fingerprint: check.treeFingerprint, check }
        : null
    if (pendingFixed.length > 0) {
      const stillFailing = new Set((Array.isArray(check.failed) ? check.failed : []).map((f) => String(f.check || '').trim()))
      pendingFixed
        .filter((key) => check.passed === true || !stillFailing.has(key))
        .forEach((key) => {
          const entry = `${contextNote || plainPhase(phaseName)}: ${key}`
          if (!checkFixed.includes(entry)) checkFixed.push(entry)
        })
      pendingFixed = []
    }
    if (check.passed === true) {
      return { passed: true, nonConvergence: false, lastCheck, lastFix }
    }
    const failed = Array.isArray(check.failed) ? check.failed : []
    // 収束判定: 直前イテレーションと同一署名の失敗が再出現したら、それ以上修正しても進まないとみなす
    const signatures = failed.map(failureSignature)
    if (prevSignatures && signatures.some((s) => prevSignatures.has(s))) {
      return {
        passed: false,
        nonConvergence: true,
        reason: '直前の自動修正のあとも、同じ検査が同じ箇所で失敗した(同じ失敗が繰り返されたので自動修正を打ち切った)',
        lastCheck,
        lastFix,
      }
    }
    prevSignatures = new Set(signatures)
    if (attempt >= maxFixes) {
      return {
        passed: false,
        nonConvergence: true,
        reason: `検査の失敗を自動で直す試みが上限(${maxFixes} 回)に達した${contextNote ? `(${contextNote})` : ''}`,
        lastCheck,
        lastFix,
      }
    }
    log(`${phaseName}: 検査失敗 ${failed.length} 件 — 修正を試行します(${attempt + 1}/${maxFixes})`)
    const failText = failed
      .map((f) => `- [${f.check}] ${f.detail}\n  失敗箇所: ${(f.failedItems || []).join(' / ')}`)
      .join('\n')
    lastFix = await fixWithGuard(`以下のリリース前検査の失敗を修正してください。\n${failText}`, phaseName, phaseKey, fixOpts)
    pendingFixed = (Array.isArray(lastFix.results) ? lastFix.results : [])
      .filter((x) => x && x.status === 'fixed' && typeof x.title === 'string')
      .map((x) => x.title.trim())
  }
}

// ---- Gate 0 preflight(AC-1): 違反時は何も変更せず通知して return する ----
phase('Gate0 事前検査')
// 従来ここは preflight と「開始時 HEAD 記録」の 2 体に分かれていたが、どちらも同じ git リポジトリを
// 1〜2 コマンド読むだけの工程で、エージェント 1 体には約 34k トークンの起動の床がある(実測)。
// 同じ性質の読み取りは 1 体にまとめる。run ディレクトリの解決もここへ寄せる — JS 側は環境変数を
// 展開できないため、${TMPDIR} の解決はエージェントにやらせるしかない
const stateDirOverride = typeof automation.stateDir === 'string' ? automation.stateDir : null
const ledgerSourcePath = (config.knownIssues && config.knownIssues.path) || 'docs/known-issues.md'
const LEDGER_ENTRIES_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      file: { type: 'string' },
      title: { type: 'string' },
      severity: { type: 'string' },
    },
  },
}
const LEDGER_ASK =
  `${ledgerSourcePath} を Read で読み、「未解決(バックログ)」に相当するセクションの各項目を ` +
  '{id, file, title, severity} の配列として抽出する。' +
  '解決済みログのセクションは対象外。**本文・現象・対応方針は含めないこと**(id / 対象ファイル / タイトル / severity の 4 つだけ)。' +
  'ファイルが存在しない場合は空配列とする。'
// 前回 run の状態ファイルと既知課題台帳の読み取りも preflight に同居させる(どれも読むだけの工程で、
// 1 体ごとに約 34k トークンの起動の床がある)。欠けて返ってきたものだけ、後で個別の体で読み直す
const preflight = await trackedAgent(
  'gate0',
  TOOL_POLICY +
    '読み取り専用の事前検査です。**リポジトリへの変更(ファイル編集・状態を変える git 操作)は一切禁止**。' +
    '以下を実行して結果をそのまま報告してください(手順 5 の mkdir だけはリポジトリ外への作成なので例外):\n' +
    '1. git status --porcelain の出力(porcelain。空なら空文字列)\n' +
    '2. git branch --show-current の出力(branch)\n' +
    `3. ${reqPath} が存在するか(requirementsExists)。存在する場合、「ステータス: 確定」という記載を含むか(statusConfirmed)\n` +
    '4. `git rev-parse HEAD` の出力のコミット SHA(head)と `git rev-parse --show-toplevel` の出力(repoRoot)。出力の加工・省略・推測は禁止\n' +
    '5. この run の作業ディレクトリ(runDir)を作って絶対パスを返す。' +
    (stateDirOverride
      ? `\`RUN_DIR="${stateDirOverride}/${release}"\``
      : '`REPO=$(basename "$(git rev-parse --show-toplevel)")` として ' +
        `\`RUN_DIR="\${TMPDIR:-/tmp}/claude-release-workflow/$REPO/${release}"\``) +
    ' を定め、`mkdir -p "$RUN_DIR"` を実行したうえでその絶対パスを runDir として返すこと。' +
    '**リポジトリ内には作らないこと**(Gate 0 のクリーンツリー検査と実装工程の捏造検知を壊すため)\n' +
    '6. `$RUN_DIR/state.json` が存在すれば Read で読み、stateFile に {exists: true, state: <内容>} を返す。' +
    '存在しない・JSON として壊れている場合は stateFile に {exists: false} を返す。**内容の要約・省略・補完は禁止**\n' +
    `7. ${LEDGER_ASK}結果を ledgerEntries として返す`,
  {
    label: 'preflight',
    role: 'preflight',
    phase: 'Gate0 事前検査',
    schema: {
      type: 'object',
      required: ['porcelain', 'branch', 'requirementsExists', 'statusConfirmed'],
      properties: {
        porcelain: { type: 'string' },
        branch: { type: 'string' },
        requirementsExists: { type: 'boolean' },
        statusConfirmed: { type: 'boolean' },
        head: { type: 'string' },
        repoRoot: { type: 'string', description: 'リポジトリルートの絶対パス' },
        runDir: { type: 'string', description: 'この run の中間成果物を置く絶対パス' },
        stateFile: {
          type: 'object',
          required: ['exists'],
          properties: { exists: { type: 'boolean' }, state: { type: 'object' } },
        },
        ledgerEntries: LEDGER_ENTRIES_SCHEMA,
      },
    },
    ...modelAndEffort('bootstrap', MODELS, EFFORTS),
  }
)

const violations = []
if (!preflight) {
  violations.push('preflight エージェントが結果を返しませんでした')
} else {
  if (String(preflight.porcelain || '').trim() !== '') {
    violations.push('作業ツリーがクリーンではありません(未コミットの変更があります)')
  }
  const branch = String(preflight.branch || '').trim()
  if (branch !== release) {
    violations.push(`現在ブランチ(${branch})が args.release(${release})と一致しません`)
  }
  if (branch === baseBranch) {
    violations.push(`現在ブランチが baseBranch(${baseBranch})です。リリースブランチで実行してください`)
  }
  if (preflight.requirementsExists !== true) {
    violations.push(`要件ファイル ${reqPath} が存在しません`)
  } else if (preflight.statusConfirmed !== true) {
    violations.push(`要件ファイル ${reqPath} に「ステータス: 確定」の記載がありません`)
  }
}
if (config.configVersion !== ENGINE_CONFIG_VERSION) {
  violations.push(
    `configVersion(${config.configVersion})がエンジン要求版(${ENGINE_CONFIG_VERSION})と一致しません`
  )
}
if (violations.length > 0) {
  return await finishWith('stopped', `開始前の事前検査で止めた: ${violations.join(' / ')}`)
}
log('Gate 0 通過: 作業ツリー・ブランチ・要件・config 版数に問題なし')

// Gate 0.5 の照合基準: 実装開始前の HEAD を記録し、リトライ(2 回目の implement-feature)にも同じ
// 基準を渡す。1 回目の試行中に無断コミットが起きても、リトライの照合が開始時 HEAD 起点差分で
// それを拾える。merge-base(baseBranch) 起点にしない理由: no-pr 停止後の同一ブランチ再実行
// (正規の再開手順)で前回実行がコミットした変更まで実差分に混入し、今回触っていないファイルの
// 捏造報告が検証済み扱いになってしまうため
const auditBaseRef =
  preflight &&
  typeof preflight.head === 'string' &&
  /^[0-9a-f]{7,40}$/i.test(preflight.head.trim())
    ? preflight.head.trim()
    : null
if (!auditBaseRef) {
  log('注: 実装開始時 HEAD を記録できませんでした。Gate 0.5 の照合は HEAD 差分と未追跡ファイルのみで行われます')
}

if (preflight && typeof preflight.repoRoot === 'string' && preflight.repoRoot.trim().startsWith('/')) {
  repoRootAbs = preflight.repoRoot.trim().replace(/\/+$/, '')
}

/** 中間成果物(変更マップ・チェックポイント)の置き場。解決できなければ両機能とも無効化して従来動作へ倒す。 */
const runDir =
  preflight && typeof preflight.runDir === 'string' && preflight.runDir.trim().startsWith('/')
    ? preflight.runDir.trim()
    : null
if (!runDir) {
  log('注: run ディレクトリを解決できませんでした。変更マップとチェックポイントは無効化して実行します')
}

// 変更マップの返り値。hunk ヘッダは 0.7.0 で外した — 79 ファイル分の hunk を並べた目次が 21.6k 字になり、
// レビュー・検証の全プロンプトに毎ターン再送されていた。hunk の位置は patch を Read すれば分かる
const CHANGEMAP_SCHEMA = {
  type: 'object',
  required: ['dir', 'manifest', 'consistent', 'trackedCount', 'untrackedCount'],
  properties: {
    dir: { type: 'string' },
    consistent: { type: 'boolean', description: 'manifest の追跡ファイル集合が git diff --name-only と一致したか' },
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
          patchPath: { type: 'string' },
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
 * review-changes.js と同一内容(テストでバイト一致を固定)。
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
 * 変更マップ(差分の目次)を作り、下流のレビュー・検証・文書同期へ配る。
 *
 * 従来は review-changes / sync-docs の各エージェントが**それぞれ独立に** git diff を叩いて
 * 差分の所在を発見し直していた(実測: 1 ファイルを 190 体中 121 体が読み、534 回のアクセス)。
 * 目次を 1 回だけ作って配れば、その再導出のターンがまるごと消える。
 *
 * **diff の本文は返り値に含めない** — 巨大なペイロードは構造化出力の経路で切り詰められるため、
 * 本文はファイルへ書き出してパスだけを返す。
 */
async function buildChangeMap(tag, phaseName, phaseKey) {
  if (!runDir) return null
  const cm = await trackedAgent(phaseKey, changeMapAsk(changeMapScript(`"${runDir}/${tag}"`, baseBranch)), {
    label: `変更マップ:${tag}`,
    role: 'changemap',
    phase: phaseName,
    schema: CHANGEMAP_SCHEMA,
    ...modelAndEffort('bootstrap', MODELS, EFFORTS),
  })
  // 信用できない目次(consistent: false・出力先の食い違い・件数の不一致)は使わない。古い・不完全な目次を
  // 配ると、下流に存在しない差分を見に行かせることになる。その場合は各エージェントが従来どおり git diff を叩く
  const rejects = []
  const valid = validChangeMap(cm, `${runDir}/${tag}`, rejects)
  if (!valid) log(`変更マップ ${tag} は使いません: ${rejects.join(' / ') || '結果なし'}`)
  return valid
}

// ---- チェックポイント: 中断した run を工程単位で再開する ----
// 動機: Gate2 のイテレーション番号はメモリ上のローカル変数でしか持っておらず、セッション制限等で
// 中断して再実行するとループが 0 から回り直す。実測では maxFixIterationsReview: 3(=最大 4 ラウンド)
// の設定で **7 ラウンド**回っており、レビュー段の消費が丸ごと二重に発生していた。
//
// **陳腐化ガードは AND で厳しく。** 記録が現在の状態と 1 つでも食い違えば、全部やり直す(安全側)。
// 判定不能(コマンド失敗)も必ず「再実行」へ倒す。スキップは「同一の入力に対して既に成功が
// 記録されている工程」に限る。
const STATE_VERSION = 1
const STATE_SCHEMA = {
  type: 'object',
  required: ['exists'],
  properties: {
    exists: { type: 'boolean' },
    state: { type: 'object' },
  },
}

/**
 * 前回 run の状態を読む。陳腐化ガードを通らないものは破棄して null を返す。
 * preflight が読んだ結果(stateFile)があればそれを使い、欠けていたときだけ個別の体で読む。
 */
async function loadState() {
  if (!runDir) return null
  const prefetched = preflight && preflight.stateFile && typeof preflight.stateFile.exists === 'boolean' ? preflight.stateFile : null
  const r = prefetched || await trackedAgent(
    'gate0',
    TOOL_POLICY +
      `${runDir}/state.json が存在すれば Read で読み、その JSON を state として {exists: true, state: <内容>} で返してください。` +
      '存在しない・JSON として壊れている場合は {exists: false} を返すこと。**内容の要約・省略・補完は禁止**。',
    { label: '状態読込', role: 'state', phase: 'Gate0 事前検査', schema: STATE_SCHEMA, ...modelAndEffort('bootstrap', MODELS, EFFORTS) }
  )
  const s = r && r.exists === true && r.state ? r.state : null
  if (!s) return null
  const stale =
    s.stateVersion !== STATE_VERSION ||
    s.release !== release ||
    s.branch !== String((preflight && preflight.branch) || '').trim() ||
    s.baseBranch !== baseBranch ||
    s.auditBaseRef !== auditBaseRef
  if (stale) {
    log('前回の実行状態は現在のブランチ/HEAD と不整合のため破棄し、最初から実行します')
    return null
  }
  return s
}

/**
 * 現在の進捗を state.json へ書き出す(1 ターンで終わる軽い工程)。
 * 工程名(phase)・消費・Codex の周別状態も毎回同梱する — セッション制限で run が死ぬとランタイムは
 * task output を書けず、ジャーナルしか残らない。手動完走の起点になる「どこまで進み、何を消費したか」を
 * ここに残す(再開判定に使うのは gate2Iter / gate2Done と陳腐化ガードの項目だけ)。
 */
async function saveState(patch, opts) {
  if (!runDir) return null
  const withFingerprint = Boolean(opts && opts.fingerprint)
  Object.assign(runState, patch)
  const snapshot = {
    ...runState,
    stateVersion: STATE_VERSION,
    consumption: { ...consumption },
    totalAgents,
    checkRunsTotal,
    codexRounds: codexRounds.slice(),
    ownedFiles: ownedFiles ? [...ownedFiles] : null,
    foreignFiles: [...foreignFiles],
    requirementIssues: requirementIssues.slice(),
    requirementEdits: requirementEdits.slice(),
    untrackedGap,
  }
  return await trackedAgent(
    'gate0',
    TOOL_POLICY +
      `次の JSON を ${runDir}/state.json へ Write でそのまま書き出してください(既存があれば上書き)。` +
      '内容の改変・整形以外の加工は禁止。リポジトリ内のファイルには一切触れないこと。\n\n' +
      JSON.stringify(snapshot, null, 2) +
      (withFingerprint
        ? `\n\nあわせて次のコマンドを一字一句そのまま実行し、出力を treeFingerprint として返すこと(作業ツリーの内容の指紋。ファイルは変わらない):\n\`${TREE_FINGERPRINT_CMD}\``
        : ''),
    {
      label: '状態保存',
      role: 'state',
      phase: '準備',
      ...(withFingerprint
        ? { schema: { type: 'object', required: ['treeFingerprint'], properties: { treeFingerprint: { type: 'string' } } } }
        : {}),
      ...modelAndEffort('bootstrap', MODELS, EFFORTS),
    }
  )
}

const runState = {
  stateVersion: STATE_VERSION,
  release,
  branch: String((preflight && preflight.branch) || '').trim(),
  baseBranch,
  auditBaseRef,
}
const prevState = await loadState()

// ---- 実装 + Gate 0.5(AC-2): 完了性・捏造疑いの照合。問題があれば 1 回リトライ ----

/** implement-feature の消費エージェント数の概算(下限): 探索2 + 設計1 + 照合1 + 実装項目数。 */
function estimateImplementAgents(r) {
  if (!r) return 1
  return (Array.isArray(r.reports) ? r.reports.length : 0) + 4
}

/** implement-feature の結果から Gate 0.5 の問題点(失敗残存・捏造疑い)を抽出する。 */
function implementProblems(r) {
  if (!r) return ['implement-feature が結果を返しませんでした']
  const problems = []
  if (Array.isArray(r.failedItems) && r.failedItems.length > 0) {
    problems.push(`実装に失敗した作業項目が残っています: ${r.failedItems.join(', ')}`)
  }
  const unverified =
    r.fileAudit && Array.isArray(r.fileAudit.unverified) ? r.fileAudit.unverified : []
  if (unverified.length > 0) {
    problems.push(`変更報告されたのに実差分に現れないファイルがあります(捏造疑い): ${unverified.join(', ')}`)
  }
  return problems
}

/**
 * 解説レポート用に実装結果を要約する。並列バッチ内で複数の作業単位が同じファイルを書いた
 * 衝突候補(sameBatchCollisions)と、複数の作業単位に触られたファイル(multiTouchedFiles)を分けて返す。
 *
 * 衝突候補を見る理由: 並列の競合判定は設計が宣言した files しか見ないので、宣言外のファイルを 2 体が
 * 同時に作ると後着が先着を上書きする(導入先で実際に起きた)。報告された changedFiles とバッチ構成を
 * 突き合わせれば事後に検出できる。sameBatchCollisions の items は同じバッチに居た作業単位だけで、
 * multiTouchedFiles は衝突候補も含む全件(逐次の結線なら想定内)。
 *
 * テストが関数単体を切り出して実行するため、外側の変数・関数を参照しないこと。
 *
 * @param r implement-feature の戻り値。
 * @returns 要約。r が無ければ null。batches を返さない旧版の戻り値では sameBatchCollisions は空。
 */
function summarizeImplementation(r) {
  if (!r) return null
  const normalize = (f) => String(f).trim().replace(/^\.\//, '')
  const items = (Array.isArray(r.reports) ? r.reports : []).map((x) => ({
    // implement-feature の reports[].item は作業単位の title で、batches の要素と同じ文字列
    title: x && typeof x.item === 'string' ? x.item : '',
    changedFiles: Array.isArray(x && x.changedFiles) ? [...new Set(x.changedFiles.map(normalize))] : [],
    report: x && typeof x.report === 'string' ? x.report : '',
  }))
  const batchOf = new Map()
  ;(Array.isArray(r.batches) ? r.batches : []).forEach((b, i) =>
    (Array.isArray(b) ? b : []).forEach((t) => batchOf.set(t, i))
  )
  const touched = new Map()
  items.forEach((it) =>
    it.changedFiles.forEach((f) => {
      const titles = touched.get(f) || []
      if (!titles.includes(it.title)) titles.push(it.title)
      touched.set(f, titles)
    })
  )
  const multi = [...touched.entries()].filter(([, titles]) => titles.length > 1)
  const sameBatchCollisions = []
  multi.forEach(([file, titles]) => {
    const byBatch = new Map()
    titles.forEach((t) => {
      const b = batchOf.get(t)
      if (b !== undefined) byBatch.set(b, [...(byBatch.get(b) || []), t])
    })
    const colliding = [...byBatch.values()].filter((group) => group.length > 1).flat()
    if (colliding.length > 0) sameBatchCollisions.push({ file, items: colliding })
  })
  return {
    design: typeof r.design === 'string' ? r.design : '',
    items,
    failedItems: Array.isArray(r.failedItems) ? r.failedItems : [],
    unverifiedFiles: r.fileAudit && Array.isArray(r.fileAudit.unverified) ? r.fileAudit.unverified : [],
    multiTouchedFiles: multi.map(([file, titles]) => ({ file, items: titles })),
    sameBatchCollisions,
  }
}

/**
 * Gate 0.5 のリトライで implement-feature を 2 回呼んだときの要約の結合。作業単位と衝突候補は連結する
 * (バッチ構成は実行ごとに別なので跨いで再計算しない)。failedItems・unverifiedFiles は最終状態 =
 * リトライ側、design は全体計画を持つ初回側を採る(リトライの設計は未解消分に限定されている)。
 */
function mergeImplementation(first, retry) {
  if (!first || !retry) return first || retry
  return {
    design: first.design,
    items: [...first.items, ...retry.items],
    failedItems: retry.failedItems,
    unverifiedFiles: retry.unverifiedFiles,
    multiTouchedFiles: [...first.multiTouchedFiles, ...retry.multiTouchedFiles],
    sameBatchCollisions: [...first.sameBatchCollisions, ...retry.sameBatchCollisions],
  }
}

let impl = await workflow('implement-feature', { release, config, skipVerify: true, auditBaseRef })
addConsumption('implement', agentsUsedOf(impl, estimateImplementAgents(impl)))
// 解説レポート用の実装メモ。再開(resume)はスクリプトを先頭から再実行してキャッシュ済みの結果を返すので、
// state.json へ保存しなくてもここで再構築される
let implementationNotes = summarizeImplementation(impl)
let gate05Problems = implementProblems(impl)
if (gate05Problems.length > 0) {
  log(`Gate 0.5 検出: ${gate05Problems.join(' / ')} — implement-feature を 1 回リトライします`)
  impl = await workflow('implement-feature', {
    release,
    config,
    skipVerify: true,
    auditBaseRef,
    scope: `前回実行で未解消の問題の解消に限定: ${gate05Problems.join(' / ')}。既に正しく実装済みの部分は変更しないこと`,
  })
  addConsumption('implement', agentsUsedOf(impl, estimateImplementAgents(impl)))
  implementationNotes = mergeImplementation(implementationNotes, summarizeImplementation(impl))
  gate05Problems = implementProblems(impl)
}
// ここから prMaterial 構築までの停止経路(Gate 0.5)は、実装メモだけを解説の材料として返す
if (implementationNotes) reportMaterial = { implementation: implementationNotes }
if (gate05Problems.length > 0) {
  // 残存は critical 相当(AC-9: Gate 0.5 由来の critical 残存は PR を作らず停止。作業状態は保全)
  await fileKnownIssues(
    gate05Problems.map((p) => ({
      source: 'check',
      checkKey: 'implement',
      severity: 'critical',
      title: '実装結果と実際の差分が食い違ったまま(失敗した作業項目、または変更したと報告されたのに差分に無いファイル)',
      detail: p,
    }))
  )
  return await finishWith(
    'no-pr',
    `実装を 1 回やり直しても、実装結果と実際の差分の食い違いが解消しなかった: ${gate05Problems.join(' / ')}`
  )
}
log(`実装完了: ${Array.isArray(impl.implemented) ? impl.implemented.length : 0} 作業項目(Gate 0.5 通過)`)
// このリリースが作ったファイルの起点 = 実装直後の実差分(未追跡ファイルを含む)と実装体の申告。
// run 自身が書く文書(同期対象・既知課題・要件)も含める。差分一覧が取れなければ区別しない(従来動作)
if (impl.fileAudit && impl.fileAudit.auditOk === true && Array.isArray(impl.fileAudit.actualDiff)) {
  ownedFiles = new Set()
  // 中断からの再開: 前回までに判定した所有・リリース外を引き継ぐ(リリース外は先に入れて所有へ流さない)
  if (prevState && Array.isArray(prevState.foreignFiles)) prevState.foreignFiles.map(normPath).forEach((p) => foreignFiles.add(p))
  if (prevState && Array.isArray(prevState.ownedFiles)) noteOwned(prevState.ownedFiles)
  if (prevState && prevState.untrackedGap === true) untrackedGap = true
  noteOwned(impl.fileAudit.actualDiff)
  noteOwned(Array.isArray(impl.fileAudit.reported) ? impl.fileAudit.reported : [])
  noteOwned([
    reqPath,
    ...(config.knownIssues && config.knownIssues.path ? [config.knownIssues.path] : []),
    ...(config.syncDocs && Array.isArray(config.syncDocs.targets) ? config.syncDocs.targets.map((t) => t && t.path) : []),
  ])
} else {
  log('注: 実装直後の差分照合が取れなかったため、run 中に追加されたファイルとリリースのファイルを区別せずに進めます')
}
await saveState({ phase: 'gate1', implementDone: true })

// ---- Gate 1 検査ループ(AC-3) ----
phase('Gate1 検査ループ')
const checkFindings = [] // 収束不能な検査失敗の起票用
const gate1 = await gate1Loop(maxFixIterationsCheck, 'Gate1 検査ループ', 'gate1', '実装後の検査')
if (!gate1.passed) {
  const failed = gate1.lastCheck && Array.isArray(gate1.lastCheck.failed) ? gate1.lastCheck.failed : []
  if (failed.length > 0) {
    failed.forEach((f) =>
      checkFindings.push({
        source: 'check',
        checkKey: f.check,
        severity: 'high',
        title: `実装後の検査 ${f.check} が、自動修正を打ち切った時点で失敗したまま`,
        detail: `${gate1.reason}。失敗箇所: ${(f.failedItems || []).join(' / ')}`,
      })
    )
  } else {
    checkFindings.push({
      source: 'check',
      checkKey: 'release-check',
      severity: 'high',
      title: '実装後の検査の失敗を、自動修正で直しきれなかった',
      detail: gate1.reason,
    })
  }
  log(`Gate1 収束不能: ${gate1.reason}(所見を起票して継続、PR は draft 以下に降格)`)
}

// ---- Gate 2 レビューループ(AC-4) ----
phase('Gate2 レビューループ')
const backlogFindings = [] // 起票対象(low・残存 medium 等)
const reviewFixed = [] // PR 本文用: 修正対応した所見(同じ所見は 1 回だけ)
const reviewFixedKeys = new Set()
/** 検証で誤検出と判定した所見の台帳(周をまたいで review-changes へ渡し、持ち越しからも外す)。 */
const rejectedLedger = []
/** 観点ごとの検証結果の累計(PR 本文・解説レポートへ)。 */
const reviewPrecision = {}
/** 検証体の独立評価で深刻度を改めた所見(PR 本文へ)。 */
const severityChanges = []
/** 所見に振る ID の通し番号(修正体の申告と ID で照合する。タイトルの一字一句一致に頼らない)。 */
let findingSeq = 0
/** 一度でも修正対象にした所見(looseKey)。上限到達後の「修正は未試行」の判定に使う。 */
const fixAttemptedKeys = new Set()
/** 「要件の変更が必要」で人の判断へ回した所見のキー(再発見されても二重に起票しない)。 */
const requirementChangeKeys = new Set()

/** 要件の変更が必要という申告か(修正プロンプトで reason の書き出しを指定している)。 */
function isRequirementChangeReason(reason) {
  return /^\s*要件の変更が必要/.test(String(reason || ''))
}
const mediumAttempted = new Set()
let residualBlock = [] // ループ終了時点で未解決の critical/high 所見
let unverifiableDims = [] // 周をまたいで累積する(0.8.1 までは周ごとに上書きしていた)
let gate2NonConvergence = null
// 2 回目以降の再レビューを直前修正の変更ファイルへ絞るスコープ(FR-02)。取得失敗時は null=全差分
let reReviewScope = null
// 差分の目次。レビュー・検証・文書同期が「差分がどこにあるか」を各自で発見し直すのをやめさせる
let changeMap = await buildChangeMap('gate2-0', 'Gate2 レビューループ', 'gate2')
// 中断した run の再開: 前回どこまでレビューラウンドを回したかを引き継ぐ(P7)
// gate2Done が立っている前回状態からは再開しない。収束済みの run を途中ラウンドから再開すると、
// いきなり上限到達の分岐に入って「収束不能」と誤報告してしまう
//
// gate2Iter だけでは再開できない: 各ラウンドの carriedBlock(未解決 block 所見の持ち越し)・
// mediumAttempted(medium の修正試行済み集合)・reReviewScope(直前修正の変更ファイル)・
// backlogFindings(起票対象)は純粋なインメモリの累積値で、リポジトリの状態からは復元できない。
// これらが揃っていない state.json(旧形式・破損)から gate2Iter だけを引き継ぐと、持ち越し所見が
// 消えたまま再レビューが始まってしまうため、揃っていなければ初回(全差分)からやり直す
const canResumeGate2 =
  !!prevState &&
  prevState.gate2Done !== true &&
  Number.isInteger(prevState.gate2Iter) &&
  prevState.gate2Iter > 0 &&
  Array.isArray(prevState.gate2CarriedBlock) &&
  Array.isArray(prevState.gate2MediumAttempted) &&
  Array.isArray(prevState.gate2BacklogFindings) &&
  Object.prototype.hasOwnProperty.call(prevState, 'gate2ReReviewScope')
const resumeIter = canResumeGate2 ? prevState.gate2Iter : 0
if (resumeIter > 0) {
  log(`Gate2: 前回実行の続きからレビューを再開します(イテレーション ${resumeIter + 1} から)`)
  backlogFindings.push(...prevState.gate2BacklogFindings)
  if (Array.isArray(prevState.gate2ReviewFixed)) prevState.gate2ReviewFixed.forEach((x) => { if (x && x.key && !reviewFixedKeys.has(x.key)) { reviewFixedKeys.add(x.key); reviewFixed.push(x.text) } })
  if (Array.isArray(prevState.gate2RejectedLedger)) rejectedLedger.push(...prevState.gate2RejectedLedger)
  if (prevState.gate2Precision && typeof prevState.gate2Precision === 'object') Object.assign(reviewPrecision, prevState.gate2Precision)
  if (Array.isArray(prevState.gate2Unverifiable)) unverifiableDims.push(...prevState.gate2Unverifiable)
  if (Array.isArray(prevState.gate2SeverityChanges)) severityChanges.push(...prevState.gate2SeverityChanges)
  if (Number.isInteger(prevState.gate2FindingSeq)) findingSeq = prevState.gate2FindingSeq
  if (Array.isArray(prevState.gate2FixAttempted)) prevState.gate2FixAttempted.forEach((k) => fixAttemptedKeys.add(k))
  if (Array.isArray(prevState.gate2CheckFixed)) prevState.gate2CheckFixed.forEach((x) => { if (!checkFixed.includes(x)) checkFixed.push(x) })
  if (Array.isArray(prevState.gate2GuardViolations)) {
    prevState.gate2GuardViolations.forEach((g) => {
      if (g && !guardViolations.some((x) => x.title === g.title && x.detail === g.detail)) guardViolations.push(g)
    })
  }
  if (Array.isArray(prevState.requirementIssues)) {
    requirementIssues.push(...prevState.requirementIssues)
    // 再発見された要件変更の medium 所見を二重に起票しないよう、キーも作り直す
    prevState.requirementIssues.filter((x) => x && x.source === 'fix').forEach((x) => requirementChangeKeys.add(findingKey(x)))
  }
  // Gate1 は再開時にもやり直されるので、Gate2 での書き戻しの記録だけを引き継ぐ(Gate1 の分の二重記録を避ける)
  if (Array.isArray(prevState.requirementEdits)) {
    requirementEdits.push(...prevState.requirementEdits.filter((e) => e && String(e.phase || '').startsWith('Gate2')))
  }
  prevState.gate2MediumAttempted.forEach((k) => mediumAttempted.add(k))
  reReviewScope = prevState.gate2ReReviewScope ?? null
} else if (prevState && prevState.gate2Done !== true && Number.isInteger(prevState.gate2Iter) && prevState.gate2Iter > 0) {
  // gate2Iter はあるが継続に必要な状態が欠けている(旧形式 state.json 等): 引き継がず全差分から再実行
  log('Gate2: 前回状態に継続用のラウンド情報(持ち越し所見等)が欠けているため、初回(全差分)から再実行します')
}

/** 所見の重複照合キー(同一ファイル・同一タイトルは同一所見とみなす)。 */
function findingKey(f) {
  return `${f.file || ''}::${f.title || ''}`
}

/**
 * 行番号を除いた照合キー(ファイルのパス + タイトル)。修正が入ると同じ所見の行番号がずれて再報告されるので、
 * 持ち越し・棄却・ID の引き継ぎはこちらで照合する(findingKey のままだと、行がずれた再報告を別の所見と見なし、
 * 持ち越しが外れず ID も振り直されていた)。
 */
function looseKey(f) {
  return `${normPath(String((f && f.file) || '').split(':')[0])}::${String((f && f.title) || '').trim()}`
}

/**
 * 2 つの所見リストを対応づける。完全一致(findingKey)を先に取り、残りは行番号を除いたキー(looseKey)が
 * 双方に 1 件ずつしか無いときだけ対応させる。同じファイルに同じタイトルの別の所見があるとき、
 * looseKey だけで照合すると別の所見同士を同じものとして扱ってしまうため(持ち越しが確認なしに消える等)。
 *
 * @returns Map(b の要素 → 対応する a の要素)
 */
function pairFindings(aList, bList) {
  const pairs = new Map()
  const usedA = new Set()
  bList.forEach((b) => {
    const a = aList.find((x) => !usedA.has(x) && findingKey(x) === findingKey(b))
    if (a) {
      pairs.set(b, a)
      usedA.add(a)
    }
  })
  const restA = aList.filter((x) => !usedA.has(x))
  const restB = bList.filter((x) => !pairs.has(x))
  restB.forEach((b) => {
    const k = looseKey(b)
    const candA = restA.filter((x) => looseKey(x) === k)
    const candB = restB.filter((x) => looseKey(x) === k)
    if (candA.length === 1 && candB.length === 1) pairs.set(b, candA[0])
  })
  return pairs
}

/** 所見の severity(欠落時は fixOnce 相当として扱う)。 */
function severityOf(f) {
  return f && typeof f.severity === 'string' ? f.severity : 'medium'
}

/**
 * 修正対象の所見を、修正エージェント 1 体ぶんのグループへ束ねる。
 *
 * **同一ファイルの所見は必ず同じグループへ入れる** — 分けると同じファイルを 2 体が別々に
 * 読み直すことになり、分割の目的(ターン数の削減)に逆行する。加えて逐次実行との組み合わせで
 * 同じファイルを続けて編集する形になり、後段の修正が前段の変更を前提にできる。
 */
function groupFindingsForFix(items, maxPerGroup) {
  const byFile = new Map()
  items.forEach((f) => {
    const key = String((f && f.file) || '').split(':')[0] || '(対象不明)'
    if (!byFile.has(key)) byFile.set(key, [])
    byFile.get(key).push(f)
  })
  const groups = []
  let current = []
  for (const arr of byFile.values()) {
    // 1 ファイルだけで上限を超える場合は、そのファイルを 1 グループとして丸ごと通す
    // (ファイルを跨いで割るより、同一ファイルの所見をまとめて直すほうが安全)
    if (current.length > 0 && current.length + arr.length > maxPerGroup) {
      groups.push(current)
      current = []
    }
    current.push(...arr)
  }
  if (current.length > 0) groups.push(current)
  // 入力が空なら空を返す(空グループで修正エージェントを起動しない)
  return groups
}

/** review-changes の所見を起票用の findings 形式に変換する。 */
function toReviewFinding(f, titleSuffix) {
  return {
    source: 'review',
    dimension: f.dimension,
    severity: severityOf(f),
    title: titleSuffix ? `${f.title}(${titleSuffix})` : f.title,
    file: f.file,
    detail: f.detail,
  }
}

/** 修正不要の申告が 2 回続き、修正体の再投入を止めた block 所見か(免除ではなく、残存には含める)。 */
function isWaived(f) {
  return Boolean(f && f.carry && f.carry.waived === true)
}

// ---- 既知課題台帳(P2): 起票済み・対応方針が決まっている所見の再発見を抑える ----
// 実測では 1 リリースの所見 75 件のうち 45 件(60%)が既出テーマの再発見で、同一テーマが最大 13 回
// 再検出されていた。そのたびに敵対的検証が 1 体走る。台帳をレビュープロンプトへ渡して抑制する。
//
// **block 対象 severity(critical/high)は台帳へ入れない。** この run で必ず直すべきものであり、
// 直っていないなら再報告されるべきだから。台帳へ入るのは addBacklog を通ったもの =
// backlogOnly と「修正を 1 回試行した後も残った fixOnce」だけになる。
// 台帳は preflight が実装前に読んだものを使う。preflight が返さなかったときは個別の体で読む
const ledgerEntries = []
// ただし実装・修正が known-issues そのものを書き換えていたら(Gate2 直前の変更マップに載っている、または変更マップが
// 無くて確かめられない)読み直す。実装体が「直した」として項目を解決済みへ移していた場合、実装前の台帳のままだと
// その項目が抑制され続け、実際に直ったかを誰も確かめなくなる
const ledgerTouched =
  !changeMap || changeMap.manifest.some((m) => normPath(m.path) === normPath(ledgerSourcePath))
const ledgerSeed =
  preflight && Array.isArray(preflight.ledgerEntries) && !ledgerTouched
    ? { entries: preflight.ledgerEntries }
    : await trackedAgent('gate2', TOOL_POLICY + `${LEDGER_ASK}結果を entries として返すこと。`, {
        label: '既知課題台帳',
        role: 'ledger',
        phase: 'Gate2 レビューループ',
        schema: { type: 'object', required: ['entries'], properties: { entries: LEDGER_ENTRIES_SCHEMA } },
        ...modelAndEffort('bootstrap', MODELS, EFFORTS),
      })
if (ledgerSeed && Array.isArray(ledgerSeed.entries)) {
  ledgerEntries.push(...ledgerSeed.entries.filter((e) => e && (e.title || e.file)))
  log(`既知課題台帳: ${ledgerEntries.length} 件をレビューの再報告抑制へ渡します`)
}

/**
 * 重複を除外しつつ起票対象に追加する。
 * @param rawTitle 台帳へ載せる元のタイトル(finding.title には「1 回自動修正したが直らなかった」等の
 *   接尾辞が付くことがあり、次ラウンドの生の所見タイトルと照合できなくなるため分けて渡す)。
 */
function addBacklog(finding, rawTitle) {
  if (!backlogFindings.some((b) => findingKey(b) === findingKey(finding))) {
    backlogFindings.push(finding)
    ledgerEntries.push({
      file: finding.file,
      title: rawTitle || finding.title,
      severity: finding.severity,
    })
  }
}

/**
 * 前ラウンドの修正で not-fixed / 未申告 / skipped(1 回目)だった block 所見。**再発見に頼らず**次ラウンドの
 * 修正対象へ明示的に持ち越す。従来は block 所見の生存を次周のレビュー(しかも修正ファイルへスコープ限定)
 * が再発見することに頼っていたため、修正エージェントが黙って飛ばした所見が消えていた。
 * 各要素は所見に carry: {status, reason, count} を添えたもの。
 * 中断からの再開時は state.json から復元する(canResumeGate2 が揃っている場合のみ)。
 */
let carriedBlock = canResumeGate2 ? prevState.gate2CarriedBlock.slice() : []
/**
 * 修正不要の申告が 2 回続いた block 所見(0.7.4)。修正体は再投入せず収束判定にも数えないが、
 * 修正エージェントは所見の真偽を裁定する独立検証者ではないので免除もしない — ループを抜けた後に
 * 残存へ合流させ、critical は no-PR・high は draft 降格の対象であり続ける(0.7.3 の門は維持)。
 * 0.7.3 までの state.json には無い項目なので、欠けていれば空で始める(当時の skipped は carriedBlock 側に
 * 残っており、一度再投入されてから waived になる)。canResumeGate2 の必須項目には含めない。
 */
let waivedBlock =
  canResumeGate2 && Array.isArray(prevState.gate2WaivedBlock) ? prevState.gate2WaivedBlock.slice() : []
if (waivedBlock.length > 0) {
  // 開示(fixWaived)は waived と 1:1 なので再開時はここから復元する(復元しないと PR 本文から消える)
  waivedBlock.forEach((f) => fixWaived.push({ ...toReviewFinding(f), reason: f.carry ? f.carry.reason : '' }))
  log(
    `Gate2: 前回実行で修正不要と申告された block 所見 ${waivedBlock.length} 件を復元しました(修正体は再投入せず最終判定に回します)`
  )
}
// Codex の利用枠切れを一度検出したら、この run では以降の周で試行しない(検出体 + 実行体の床を
// 毎周払わない)。**再開時には引き継がない** — 枠は時間で回復する("try again at 3:45 AM")ので、
// セッション制限で落ちて翌朝再開した run が Codex を二度と試さないのは M2 の目的に反する。
// 誤って引き継ぐ損失(run 全体で Codex 層を失う)は、引き継がない損失(約 4 秒で返る検出 + 実行の
// 床 2 体分)より大きい。state.json の codexDisabled は観測用に残すだけで、再開判定には使わない
let codexDisabled = false
/** Codex を以降の周で試さない理由(枠切れ以外で止めたとき。review-changes の報告にそのまま載る)。 */
let codexDisabledReason = null
// 最初の周で review-changes が検出した Codex プラグインの可否。以降の周へ渡して検出体を毎周起動しない
// (プラグインの有無は run の途中で変わらない。作業ツリーの状態は実行体のスクリプトが周ごとに見る)。
// 再開時は取り直す(state.json には載せない)
let codexDetected = null

for (let iter = resumeIter; ; iter++) {
  if (budgetExceeded()) {
    // 前ラウンドから持ち越した block 所見は、ここで打ち切っても残存として残す(黙って消さない)
    residualBlock = carriedBlock.slice()
    gate2NonConvergence = `エージェント起動数が上限(${maxAgentInvocations})を超過しました`
    break
  }
  // このラウンドに入る時点の継続状態を保存する(P7 の再開に必須)。gate2Iter だけでなく、
  // 純粋なインメモリ累積値である carriedBlock・mediumAttempted・reReviewScope・backlogFindings を
  // 直列化しないと、中断後の再開で持ち越し所見等が黙って消える(canResumeGate2 参照)
  await saveState({
    phase: 'gate2',
    gate2Iter: iter,
    gate2CarriedBlock: carriedBlock,
    gate2WaivedBlock: waivedBlock.slice(),
    gate2MediumAttempted: [...mediumAttempted],
    gate2ReReviewScope: reReviewScope,
    gate2BacklogFindings: backlogFindings.slice(),
    gate2ReviewFixed: [...reviewFixedKeys].map((key, i) => ({ key, text: reviewFixed[i] })),
    gate2RejectedLedger: rejectedLedger.slice(),
    gate2Precision: { ...reviewPrecision },
    gate2Unverifiable: unverifiableDims.slice(),
    gate2SeverityChanges: severityChanges.slice(),
    gate2FindingSeq: findingSeq,
    gate2FixAttempted: [...fixAttemptedKeys],
    gate2CheckFixed: checkFixed.slice(),
    gate2GuardViolations: guardViolations.slice(),
  })
  // 初回(iter=0)は全差分。2 回目以降は前回レビュー以降の変更ファイルへ絞る(取得済みのときのみ)
  // 要件書もレビューするが、指摘は修正ループに入れず人の判断へ回す(requirementFindings)。要件書はこの run の間
  // 変わらない(修正による書き換えはガードが戻す)ので、レビューは最初の周だけ。戻せなかった書き換えがあれば毎周見る
  const reviewArgs = {
    base: baseBranch,
    config,
    requirementsPaths: [reqPath],
    requirementsReviewed: iter >= 1 && !requirementEdits.some((e) => e.restored === false),
    // コミット済みの差分は最初の周でレビュー済み(run の途中ではコミットしない)。Codex の再レビューは作業ツリーだけ
    committedReviewed: iter >= 1,
  }
  if (rejectedLedger.length > 0) reviewArgs.rejectedFindings = rejectedLedger.slice()
  if (ledgerEntries.length > 0) {
    reviewArgs.knownFindings = ledgerEntries.slice()
  }
  if (iter >= 1 && reReviewScope) {
    reviewArgs.diffPathScope = reReviewScope
  }
  if (changeMap) {
    reviewArgs.changeMap = withoutForeign(changeMap)
  }
  if (codexDisabled) {
    reviewArgs.codexDisabled = true
    if (codexDisabledReason) reviewArgs.codexDisabledReason = codexDisabledReason
  }
  if (codexDetected) {
    reviewArgs.codexDetected = codexDetected
  }
  const review = await workflow('review-changes', reviewArgs)
  if (review && Number.isInteger(review.titleViolations)) proseLint.reviewTitles += review.titleViolations
  if (!codexDetected && review && review.codexDetected && typeof review.codexDetected.available === 'boolean') {
    codexDetected = review.codexDetected
  }
  addConsumption(
    'gate2',
    agentsUsedOf(
      review,
      review
        ? Math.max(
            1,
            (Array.isArray(review.dimensionsRun) ? review.dimensionsRun.length : 0) +
              (Array.isArray(review.confirmed) ? review.confirmed.length : 0)
          )
        : 1
    )
  )
  if (!review) {
    // 前ラウンドから持ち越した block 所見は、ここで打ち切っても残存として残す(黙って消さない)
    residualBlock = carriedBlock.slice()
    gate2NonConvergence = 'review-changes が結果を返しませんでした'
    break
  }
  // Codex 委譲の実態を周ごとに残す(PR 本文・戻り値・state.json へ)。捨てると「黙って欠落」に戻る
  if (review.codex && typeof review.codex === 'object') {
    codexRounds.push({
      round: iter + 1,
      eligible: review.codex.eligible === true,
      available: review.codex.available === true,
      mode: review.codex.mode ?? null,
      status: review.codex.status ?? null,
      reason: review.codex.reason ?? null,
      usedCount: review.codex.usedCount ?? 0,
      fallbackCount: review.codex.fallbackCount ?? 0,
      dimensionsRun: Array.isArray(review.dimensionsRun) ? review.dimensionsRun.length : 0,
    })
    if (review.codex.status === 'quota_exhausted' && !codexDisabled) {
      codexDisabled = true
      runState.codexDisabled = true // 次の saveState で state.json へ載る
      log('Gate2: Codex の利用枠切れを検出 — この run では以降の周で Codex を試行しません(PR 本文に明記します)')
    }
    if (review.codex.baseUnresolved === true && !codexDisabled) {
      codexDisabled = true
      codexDisabledReason = `base(${baseBranch})との merge-base を解決できず、コミット済みの差分の有無を判定できないので、この run では以降のレビューの回で Codex を使わない`
      runState.codexDisabled = true
      log('Gate2: base との merge-base を解決できないため、この run では以降の周で Codex を試行しません')
    }
  }
  ;(Array.isArray(review.requirementFindings) ? review.requirementFindings : []).forEach((f) => {
    if (!f || requirementIssues.some((x) => x.source === 'review' && findingKey(x) === findingKey(f))) return
    requirementIssues.push({
      source: 'review',
      severity: severityOf(f),
      title: f.title,
      file: f.file,
      detail: f.verifiedReason || f.detail,
    })
  })
  ;(Array.isArray(review.unverifiable) ? review.unverifiable : []).forEach((u) => {
    if (u && !unverifiableDims.some((x) => x.dimension === u.dimension && x.reason === u.reason)) unverifiableDims.push({ ...u, round: iter + 1 })
  })
  // 検証で誤検出と判定された所見: 台帳に積み(次の周で再報告させない)、持ち越し中なら修正対象から外す
  const rejectedNow = Array.isArray(review.rejected) ? review.rejected.filter(Boolean) : []
  rejectedNow.forEach((r) => {
    if (!rejectedLedger.some((x) => findingKey(x) === findingKey(r))) rejectedLedger.push({ file: r.file, title: r.title, reason: r.reason })
  })
  if (rejectedNow.length > 0) {
    // 行がずれた再報告でも外れるよう pairFindings で対応づける(同名の別所見は巻き込まない)
    const rejectedCarried = new Set(pairFindings(carriedBlock, rejectedNow).values())
    const before = carriedBlock.length
    carriedBlock = carriedBlock.filter((f) => !rejectedCarried.has(f))
    if (carriedBlock.length !== before) {
      log(`Gate2: 持ち越し中の所見 ${before - carriedBlock.length} 件は、今回の検証で誤検出と判定されたため修正対象から外します`)
    }
    // 「修正不要」の申告で残存扱いにしていた所見も、独立した検証で誤検出と判定されたら外す
    const rejectedWaived = new Set(pairFindings(waivedBlock, rejectedNow).values())
    if (rejectedWaived.size > 0) {
      const removedKeys = new Set([...rejectedWaived].map(findingKey))
      waivedBlock = waivedBlock.filter((f) => !rejectedWaived.has(f))
      for (let i = fixWaived.length - 1; i >= 0; i--) if (removedKeys.has(findingKey(fixWaived[i]))) fixWaived.splice(i, 1)
      log(`Gate2: 修正不要と申告されていた所見 ${rejectedWaived.size} 件は、検証で誤検出と判定されたため残存から外します`)
    }
  }
  Object.entries(review.precision && typeof review.precision === 'object' ? review.precision : {}).forEach(([dim, p]) => {
    const acc = (reviewPrecision[dim] = reviewPrecision[dim] || { verified: 0, rejected: 0, severityCorrected: 0 })
    ;['verified', 'rejected', 'severityCorrected'].forEach((k) => { acc[k] += Number(p && p[k]) || 0 })
  })
  ;(Array.isArray(review.severityCorrected) ? review.severityCorrected : []).forEach((c) => c && severityChanges.push({ ...c, round: iter + 1 }))
  // リリース外のファイル(run の途中で追加された未追跡ファイル)を指す所見は扱わない。修正体は触れないので、
  // 修正ループに入れても直らないまま残存になるだけ。捨てる件数はログに出す
  const confirmedAll = Array.isArray(review.confirmed) ? review.confirmed : []
  const confirmed = confirmedAll.filter((f) => !foreignFiles.has(normPath(String((f && f.file) || '').split(':')[0])))
  if (confirmed.length !== confirmedAll.length) {
    log(`Gate2: リリース外のファイルを指す所見 ${confirmedAll.length - confirmed.length} 件は扱いません(修正もコミットもしないファイルのため)`)
  }
  // 修正不要の申告が 2 回続いた所見は、再レビューが再発見しても修正体を再投入しない(残存には含める)。
  // 落とすものは数えてログに出す — 「0 件」が「無かった」と「捨てた」を区別できないため
  // 持ち越し中の所見が再報告されたら、前の ID と持ち越しの履歴を引き継ぐ(行がずれていても同じ所見として扱う。
  // ただし同じファイルに同じタイトルの所見が複数あるときは、完全一致したものだけ)
  const carriedPairs = pairFindings(carriedBlock, confirmed)
  const waivedPairs = pairFindings(waivedBlock, confirmed)
  const reReportedCarried = new Set(carriedPairs.values())
  /** 修正不要の申告が 2 回続いた所見の再報告(confirmed の添字)。修正体は再投入しない */
  const waivedIdx = new Set()
  confirmed.forEach((f, i) => {
    if (waivedPairs.has(f)) waivedIdx.add(i)
    const prev = carriedPairs.get(f)
    if (prev) confirmed[i] = { ...f, carry: prev.carry, ...(prev.id ? { id: prev.id } : {}) }
  })
  const isBlockSev = (f) => severityGate.block.includes(severityOf(f))
  const blockRaw = confirmed.filter(isBlockSev)
  const blockF = confirmed.filter((f, i) => isBlockSev(f) && !waivedIdx.has(i))
  if (blockRaw.length !== blockF.length) {
    log(
      `Gate2: 再発見された block 所見のうち ${blockRaw.length - blockF.length} 件は修正不要の申告が 2 回続いた所見のため、修正体を再投入しません(残存として最終判定に回します)`
    )
  }
  const fixOnceF = confirmed.filter((f) => severityGate.fixOnce.includes(severityOf(f)))
  // low(および gate 対象外の severity)は修正せず起票対象へ
  confirmed
    .filter((f) => !severityGate.block.includes(severityOf(f)) && !severityGate.fixOnce.includes(severityOf(f)))
    .forEach((f) => addBacklog(toReviewFinding(f), f.title))
  // medium: 修正は 1 回だけ試行し、試行後も再出現したら起票対象へ
  fixOnceF
    .filter((f) => mediumAttempted.has(findingKey(f)) && !requirementChangeKeys.has(findingKey(f)))
    .forEach((f) => addBacklog(toReviewFinding(f, '1 回自動修正したが直らなかった'), f.title))
  const mediumsToFix = fixOnceF.filter((f) => !mediumAttempted.has(findingKey(f)))

  // 持ち越し: 今回のレビューが再発見した所見は blockF 側で扱い(持ち越しの履歴だけ添える)、
  // 再発見されなかった所見はそのまま修正対象に足す。どちらも「直ったと確認できるまで消えない」
  // 再報告されなかった持ち越し所見だけを足す。再報告された所見は、再報告時の深刻度で扱いを決め直す
  // (検証体が medium 以下と評価した所見を、持ち越し側の元の深刻度のまま block に残さない)
  const carriedNow = carriedBlock.filter((f) => !reReportedCarried.has(f))
  const downgradedCount = confirmed.filter((f, i) => carriedPairs.size > 0 && f.carry && !isBlockSev(f) && !waivedIdx.has(i)).length
  if (downgradedCount > 0) {
    log(`Gate2: 持ち越し中の所見 ${downgradedCount} 件は、再報告時の深刻度が block 対象でなくなったため持ち越しから外します(medium は 1 回修正、low は起票)`)
  }
  const blockAll = [...blockF, ...carriedNow]
  if (carriedNow.length > 0) {
    log(`Gate2: 前ラウンドで未解決のまま残った block 所見 ${carriedNow.length} 件を持ち越して修正対象にします`)
  }

  if (blockAll.length === 0 && mediumsToFix.length === 0) {
    residualBlock = []
    log(
      `Gate2 収束: 修正が必要な所見はありません(イテレーション ${iter + 1})` +
        (waivedBlock.length > 0 ? `。修正不要と申告された block 所見 ${waivedBlock.length} 件は残存として最終判定に回します` : '')
    )
    break
  }
  if (iter >= maxFixIterationsReview) {
    // 上限に達した周で初めて見つかった所見は、修正を一度も試していない(持ち越し履歴が無い)。PR 本文で区別する
    residualBlock = blockAll.map((f) => (f.carry || fixAttemptedKeys.has(looseKey(f)) ? f : { ...f, firstSeenAtLimit: true }))
    mediumsToFix.forEach((f) => addBacklog(toReviewFinding(f, '自動修正の上限回数に達し、修正は試していない'), f.title))
    gate2NonConvergence = `レビューの指摘を自動で直す試みが上限(${maxFixIterationsReview} 回)に達した`
    break
  }

  // 修正体の申告と照合する ID を振る(持ち越した所見は前の ID のまま)
  const toFix = [...blockAll, ...mediumsToFix].map((f) => (f.id ? f : { ...f, id: `F${++findingSeq}` }))
  toFix.forEach((f) => fixAttemptedKeys.add(looseKey(f)))
  const renderFindings = (list) =>
    list
      .map(
        (f) =>
          `- [${severityOf(f)}/${f.dimension}] ${f.title}\n  ID: ${f.id}\n  対象: ${f.file}\n  ${f.detail}` +
          (f.failureScenario ? `\n  失敗シナリオ: ${f.failureScenario}` : '') +
          (f.carry
            ? `\n  前ラウンドの修正報告: ${f.carry.status}${f.carry.reason ? `(${f.carry.reason})` : ''} — 解決が確認できていないため再度対象にしている`
            : '')
      )
      .join('\n')
  const fixGroups = groupFindingsForFix(toFix, maxFindingsPerFix)
  log(
    `Gate2: 修正対象 ${toFix.length} 件(block ${blockAll.length} / medium ${mediumsToFix.length})` +
      (fixGroups.length > 1 ? ` — ${fixGroups.length} グループに分割して逐次修正します` : '')
  )
  // 1 体へ全件渡すとターン数が伸び、その分だけ二次項(それまでの全 tool_result の再送)が効く。
  // 同一ファイルの所見は同じグループへ入れてコード読解を共有し、グループ間は逐次実行する
  // (並列にすると lint/format の競合とガードの増分判定が混線する。トークン量は逐次でも変わらない)
  let fixResult = { fixed: false, results: null, guard: null, snapshotRef: null, changedFiles: null, changedTracked: null, changeMap: null }
  let firstSnapshotRef = null
  // 前のグループのガード体が取った次のスナップショット(グループ間には何も走らないので、そのまま使える)
  let nextSnapshot = null
  /** 修正エージェントの件ごとの申告(findingKey → {status, reason})。申告が無い所見は「未着手」扱い。 */
  const fixStatus = new Map()
  for (let gi = 0; gi < fixGroups.length; gi++) {
    const isLast = gi === fixGroups.length - 1
    const r = await fixWithGuard(
      // 横断的な修正がグループ分断で片側だけ直るのを防ぐため、このラウンドで扱っている
      // 所見の全体像(タイトルのみ)を必ず見せる
      (fixGroups.length > 1
        ? `このラウンドでは次の ${toFix.length} 件を修正します(**あなたの担当は末尾に示すものだけ**):\n` +
          toFix.map((f) => `- ${f.title}`).join('\n') +
          '\n\n'
        : '') + `以下のレビュー所見を修正してください。\n${renderFindings(fixGroups[gi])}`,
      'Gate2 レビューループ',
      'gate2',
      // 次イテレーションで要る「再レビュースコープ」と「更新後の変更マップ」は最後のグループで
      // まとめて取る(いずれも差分の読み取りが起点なのでガード検査と同じ 1 体に載る)
      isLast
        ? { withScope: true, changeMapTag: `gate2-${iter + 1}`, scopeBaseRef: firstSnapshotRef, snapshot: nextSnapshot }
        : { snapshot: nextSnapshot, wantsNextSnapshot: true }
    )
    nextSnapshot = r.nextSnapshot || null
    if (firstSnapshotRef === null) firstSnapshotRef = r.snapshotRef
    // 申告は title で照合する(一字一句そのままを要求している。前後空白だけ吸収する)。
    // 結果を返さなかったグループ・申告に無い所見は「未着手」のまま = 試行済みにしない。
    // 分割前は fix 1 体の成否が全所見に一様にかかっていたが、分割後は「グループ 1 は成功・
    // グループ 2 は失敗」が起きうる。ここを一律にすると、一度も修正を試みていない所見が
    // 「修正 1 回試行後も残存」として起票され、次ラウンドで修正対象から外れてしまう
    // ID が一致しない申告(書き方の揺れ等)はタイトルで照合する。別の所見の ID を持つ申告だけはタイトル照合に使わない
    const groupIds = new Set(fixGroups[gi].map((f) => f.id))
    if (Array.isArray(r.results)) {
      fixGroups[gi].forEach((f) => {
        // ID で照合し、ID が無い申告だけタイトルで照合する(タイトルは修正体が言い換えることがある)
        const hit =
          r.results.find((x) => x && typeof x.id === 'string' && x.id.trim() === f.id) ||
          r.results.find(
            (x) =>
              x &&
              !(typeof x.id === 'string' && groupIds.has(x.id.trim())) &&
              typeof x.title === 'string' &&
              x.title.trim() === String(f.title || '').trim()
          )
        if (hit && ['fixed', 'not-fixed', 'skipped'].includes(hit.status)) {
          const reason = typeof hit.reason === 'string' ? hit.reason : ''
          fixStatus.set(findingKey(f), {
            status: hit.status,
            reason,
            requirementChange: hit.status === 'skipped' && isRequirementChangeReason(reason),
          })
        }
      })
    }
    // 修正体が要件ファイルを書き換えていた(ガードが元に戻した)グループは、その所見の fixed の申告を信用しない。
    // 所見の解消に要件の変更が要ると修正体が判断したことになるので、人の判断待ちとして扱う。
    // 対象は、申告の changedFiles に要件ファイルを挙げた所見。どの所見のためか申告から分からなければ、
    // グループ内の fixed を全部対象にする(maxFindingsPerFix の既定は 2 なので巻き込みは小さい)
    if (r.requirementsChanged) {
      const reqNorm = normPath(reqPath)
      const touchedResults = (Array.isArray(r.results) ? r.results : []).filter(
        (x) => x && Array.isArray(x.changedFiles) && x.changedFiles.map(normPath).includes(reqNorm)
      )
      const touchedIds = new Set(touchedResults.map((x) => String(x.id || '').trim()).filter(Boolean))
      const touchedTitles = new Set(touchedResults.map((x) => String(x.title || '').trim()).filter(Boolean))
      // 申告の ID かタイトルで特定できた所見だけに適用する。特定できなければグループの fixed 全部
      const identified = fixGroups[gi].filter((f) => touchedIds.has(f.id) || touchedTitles.has(String(f.title || '').trim()))
      fixGroups[gi].forEach((f) => {
        const st = fixStatus.get(findingKey(f))
        if (identified.length > 0 && !identified.includes(f)) return
        if (st && st.status !== 'fixed' && !st.requirementChange) return
        fixStatus.set(findingKey(f), {
          status: 'skipped',
          reason: `要件の変更が必要: 自動修正が要件ファイル ${reqPath} を書き換えたので元に戻した(要件を変えるかどうかは人が判断する)${st && st.reason ? `。自動修正の説明: ${st.reason}` : ''}`,
          requirementChange: true,
        })
      })
    }
    fixResult = r
  }
  // 件ごとの申告から「試行済み」「持ち越し」「修正不要の開示」を決める
  const nextCarried = []
  toFix.forEach((f) => {
    const st = fixStatus.get(findingKey(f))
    const isBlock = severityGate.block.includes(severityOf(f))
    const isMedium = severityGate.fixOnce.includes(severityOf(f))
    if (st && st.requirementChange) {
      // 要件の変更が必要な所見は、修正体を再投入せず(何度渡しても要件は変えられない)人の判断へ回す。
      // block 所見は waived と同じく残存に含めて出荷判定にかける(免除ではない)
      requirementIssues.push({ source: 'fix', severity: severityOf(f), title: f.title, file: f.file, detail: st.reason })
      requirementChangeKeys.add(findingKey(f))
      if (isMedium) {
        mediumAttempted.add(findingKey(f))
        addBacklog(toReviewFinding(f, '要件を変えないと直せないので修正していない'), f.title)
      }
      if (isBlock) {
        fixWaived.push({ ...toReviewFinding(f), reason: st.reason })
        waivedBlock.push({ ...f, carry: { status: 'skipped', reason: st.reason, count: 1, waived: true, requirementChange: true } })
      }
      return
    }
    if (st && st.status === 'fixed') {
      if (!reviewFixedKeys.has(findingKey(f))) {
        reviewFixedKeys.add(findingKey(f))
        reviewFixed.push(`[${severityOf(f)}] ${f.title}`)
      }
      if (isMedium) mediumAttempted.add(findingKey(f))
      return
    }
    if (st && st.status === 'skipped') {
      if (isMedium) mediumAttempted.add(findingKey(f))
      if (isBlock) {
        // 「修正不要」の主張は 1 回だけ持ち越して別の修正体にも判断させ、2 回続いたら waivedBlock へ移す(0.7.4)。
        // 以後は修正体を再投入しない — 0.7.3 はループ上限まで毎周再投入していたが、修正体は意見を変えないので
        // 費用だけが増える。**ただし開示は追加情報であって免除ではない**(0.7.3 の門は維持) —
        // 修正エージェントは所見の真偽を裁定する独立検証者ではなく、自分が担当した所見について
        // 「直す必要が無い」と申告しているだけなので、その自己申告だけで severity gate を迂回できて
        // しまうのは出荷判断として弱い。ループを抜けた後に残存へ合流させ、critical は no-PR・
        // high は draft 降格の判定対象であり続ける。真偽の裁定が要るなら独立した再検証工程を足すこと(M4)
        const skips = (f.carry && f.carry.status === 'skipped' ? f.carry.count || 1 : 0) + 1
        if (skips >= 2) {
          // 開示は 1 回だけ — waived になった所見は carriedBlock から外れるので、run 内で同じ所見が
          // 2 度ここへ来ることはない。0.7.3 の state.json から再開した場合は carriedBlock 側に開示済み
          // (waivedDisclosed)の所見が残りうるが、fixWaived 自体が再開で失われているので改めて開示する
          fixWaived.push({ ...toReviewFinding(f), reason: st.reason })
          waivedBlock.push({ ...f, carry: { status: 'skipped', reason: st.reason, count: skips, waived: true } })
        } else {
          nextCarried.push({ ...f, carry: { status: 'skipped', reason: st.reason, count: skips } })
        }
      }
      return
    }
    // not-fixed または未申告(= 未着手): block は持ち越し、medium は試行済みにしない(再発見されれば再試行)
    if (isBlock) {
      nextCarried.push({
        ...f,
        carry: {
          status: st ? 'not-fixed' : '未申告',
          reason: st ? st.reason : '自動修正が結果を報告しなかった(手を付けていない)',
          count: 1,
        },
      })
    }
  })
  carriedBlock = nextCarried

  // critical/high の修正後は Gate1 を別枠上限で再実行してから差分再レビューに戻る
  if (blockAll.length > 0) {
    // Gate1 の修正が走ったら、その修正のガード体で再レビュースコープと変更マップを取り直す。
    // スコープの起点は Gate2 の最初の修正の直前なので、Gate2 の修正と Gate1 の修正の両方を含む
    const g1 = await gate1Loop(
      maxGate1RerunsPerReviewFix,
      'Gate2 レビューループ',
      'gate2',
      'レビューの指摘を直したあとの検査',
      { withScope: true, changeMapTag: `gate2-${iter + 1}-g1`, scopeBaseRef: firstSnapshotRef }
    )
    if (g1.passed && g1.lastFix) {
      // Gate2 の修正前のスナップショットが取れていなければ、Gate2 の修正で変わったファイルを起点から数えられない。
      // そのときは次のレビューを全差分に戻す(変更マップは merge-base 起点なので取り直した値を使える)
      fixResult = firstSnapshotRef ? g1.lastFix : { ...g1.lastFix, changedFiles: null, changedTracked: null }
    }
    if (!g1.passed) {
      const failed = g1.lastCheck && Array.isArray(g1.lastCheck.failed) ? g1.lastCheck.failed : []
      failed.forEach((f) =>
        checkFindings.push({
          source: 'check',
          checkKey: f.check,
          severity: 'high',
          title: `レビューの指摘を直したあとの検査 ${f.check} が失敗したまま`,
          detail: `${g1.reason}。失敗箇所: ${(f.failedItems || []).join(' / ')}`,
        })
      )
      // 修正の有効性を検査で確認できないため、当該所見は残存扱いにして打ち切る
      residualBlock = blockAll
      gate2NonConvergence = `レビューの指摘を直したあとの検査が通らなかった: ${g1.reason}`
      break
    }
  }

  // 次イテレーションの再レビュースコープと更新後の変更マップは fixWithGuard が
  // ガード検査と同じ 1 体で取得済み。Gate1 の再実行で修正が走った周は、その修正のガード体が取り直した値
  // (起点は Gate2 の最初の修正の直前)を使う — 0.8.0 までは Gate2 の修正直後の値を使っており、
  // Gate1 の修正体が変えたファイルが次のレビューのスコープと変更マップから漏れていた。
  // 取得失敗・空のときは reReviewScope=null(次回は全差分)に倒す(AC-3)。
  // **直前の修正が追跡ファイルを 1 件も変えていない周も全差分へ倒す**(0.7.2) — changedFiles は
  // `git ls-files --others`(未追跡ファイルを全件列挙)を含むため、修正が何も変えなくても空にならず、
  // 上記 AC-3 のフォールバックが構造的に発火しない。その周のスコープは「未追跡ファイル全件」= 直前の
  // 修正と無関係な集合になり、追跡ファイルを指す所見が review-changes 側の inScope() で全部落ちる
  // (実測: 導入先の release-10 で high 2 件を含む 3 件が消えた)
  const scopeFiles = Array.isArray(fixResult.changedFiles) ? fixResult.changedFiles : []
  const trackedChanged = Array.isArray(fixResult.changedTracked) ? fixResult.changedTracked : null
  if (trackedChanged !== null && trackedChanged.length === 0) {
    reReviewScope = null
    log('Gate2: 直前の修正で追跡ファイルの変更が無かったため、次のレビューは全差分に戻します')
  } else {
    const releaseScope = scopeFiles.filter((p) => !foreignFiles.has(normPath(p)))
    reReviewScope = releaseScope.length > 0 ? [...new Set(releaseScope)] : null
  }
  // 修正でコードが変わった以上、古い目次を配ると存在しない差分を見に行かせてしまう。
  // 再生成できなかった場合は目次なし(=各エージェントが自分で git diff を叩く)へ倒す
  changeMap = fixResult.changeMap || null
}
// 修正不要の申告が 2 回続いた block 所見は、どの経路でループを抜けても残存に含める(免除しない)。
// blockAll から除外しているので residualBlock と重複しない
if (waivedBlock.length > 0) {
  residualBlock = [...residualBlock, ...waivedBlock]
  log(`Gate2: 修正不要と申告された block 所見 ${waivedBlock.length} 件を残存に含めます(独立した検証は無いので免除しない)`)
}
await saveState({ phase: 'triage', gate2Done: true })
if (gate2NonConvergence) {
  log(`Gate2 収束不能: ${gate2NonConvergence}`)
}

// ---- 起票(AC-6): 未対応所見 + 収束不能分を record-known-issues に渡す ----
const triageFindings = [
  ...backlogFindings,
  ...checkFindings,
  ...guardViolations,
  ...residualBlock.map((f) =>
    toReviewFinding(
      f,
      f.carry && f.carry.requirementChange
        ? '要件の変更が必要なため未修正・人の判断待ち'
        : f.firstSeenAtLimit
          ? '自動修正の上限回数に達したレビューの回で初めて見つかった・修正は試していない'
          : isWaived(f)
          ? '自動修正が「直す必要はない」と申告した・別の確認はしていない'
          : '自動修正を打ち切った時点で直っていない'
    )
  ),
]
await fileKnownIssues(triageFindings)
log(`起票工程完了: 入力所見 ${triageFindings.length} 件 / 起票・追記 ${filedIssues.length} 件`)
await saveState({ phase: 'docs', triageDone: true })

// ---- 文書同期 + 最終検査(AC-7) ----
let syncedDocs = []
let syncFailedTargets = []
if (budgetNearLimit()) {
  log(
    `エージェント起動数が予算(${maxAgentInvocations})の 8 割に達したため文書同期をスキップします` +
      '(PR 作成までは到達させるための降り方です。同期は手動で行ってください)'
  )
} else {
  // 変更マップを渡し、差分要約が git diff を叩き直すのをやめさせる(取得できていれば)
  const sync = await workflow('sync-docs', {
    base: baseBranch,
    release,
    config,
    ...(changeMap ? { changeMap: withoutForeign(changeMap) } : {}),
  })
  addConsumption('docs', agentsUsedOf(sync, sync && Array.isArray(sync.updates) ? sync.updates.length + 1 : 1))
  if (sync && Number.isInteger(sync.proseViolations)) proseLint.docs += sync.proseViolations
  if (!sync) {
    log('sync-docs が結果を返しませんでした(文書同期は未確認のまま続行します)')
  } else {
    syncedDocs = (sync.updates || []).map((u) => u && u.path).filter(Boolean)
    // 文書同期が新しく作った文書もこのリリースのファイル(コミット時にリリース外と判定しない)
    noteOwned(syncedDocs)
    syncFailedTargets = Array.isArray(sync.failedTargets) ? sync.failedTargets : []
  }
}
const beforeFinal = await saveState({ phase: 'finalCheck', docsDone: true }, { fingerprint: Boolean(lastPassedTree) })

// 最終検査以降は PR準備(AC-10)に合流させる: 直下の直接エージェントが無い『実装』『起票』『文書同期』は
// meta.phases から削除済みのため、修正ループが起動した場合の phase も PR準備 として扱う
phase('PR準備')

// 最終 release-check: 失敗したら別枠 2 回の修正ループ。収束しなければ起票して draft 降格。
// 最後に走った検査が通っていて、そのときから作業ツリーの内容が変わっていなければ(指紋が一致)省き、その結果を使う。
// 指紋は状態保存体(軽量モデル)の申告だが、捏造・取り違えは不一致=省かない側に倒れる
const finalCheckReused =
  lastPassedTree !== null &&
  beforeFinal &&
  typeof beforeFinal.treeFingerprint === 'string' &&
  beforeFinal.treeFingerprint.trim() === lastPassedTree.fingerprint
if (finalCheckReused) {
  log('最後に通った検査の後に作業ツリーが変わっていないため、最終検査を省いてその結果を使います')
}
const finalGate = finalCheckReused
  ? { passed: true, nonConvergence: false, lastCheck: lastPassedTree.check, lastFix: null }
  : await gate1Loop(2, 'PR準備', 'finalCheck', '最終検査')
const finalCheck = finalGate.lastCheck
await saveState({ phase: 'pr', finalCheckPassed: finalGate.passed === true })
let finalCheckDegraded = false
if (!finalGate.passed) {
  finalCheckDegraded = true
  const failed = finalCheck && Array.isArray(finalCheck.failed) ? finalCheck.failed : []
  const findings =
    failed.length > 0
      ? failed.map((f) => ({
          source: 'check',
          checkKey: f.check,
          severity: 'high',
          title: `最終検査 ${f.check} が失敗したまま`,
          detail: `${finalGate.reason}。失敗箇所: ${(f.failedItems || []).join(' / ')}`,
        }))
      : [
          {
            source: 'check',
            checkKey: 'release-check',
            severity: 'high',
            title: '最終検査の失敗を、自動修正で直しきれなかった',
            detail: finalGate.reason,
          },
        ]
  await fileKnownIssues(findings)
  log(`最終検査が収束せず draft PR に降格します: ${finalGate.reason}`)
}

// ---- PR 準備(AC-10): AC 充足検証と既知課題の解決判定(1 体)→ 解決済みログ移動 ----
// 既知課題の解決済みログ移動(FR-XX 参照ベース): requirements.md が FR 本文に明記した既存の
// known-issues ID を能動的に走査し、解決済みログへ移動する。record-known-issues の
// resolvedLogProposal(新規所見の重複照合中に偶然気づいた場合のみ発火する受動的な提案。適用禁止)
// とは別枠の工程で、判定(read-only)と適用(ファイル編集)はエージェントを分ける。
// 判定は AC 充足検証と同じ体で行う(0.8.x までは別の体だった)。材料(要件の全文・実コード・最終検査結果)と
// 求める姿勢(自己申告を根拠にしない)が同じで、要件の全文読みも 1 回で済む
const knownIssuesPath = config.knownIssues && config.knownIssues.path
const wantsResolution = Boolean(knownIssuesPath) && !budgetNearLimit()
if (!knownIssuesPath) {
  log('config.knownIssues.path が未定義のため、既知課題の解決済みログ移動をスキップします')
} else if (!wantsResolution) {
  log(`エージェント起動数が予算(${maxAgentInvocations})の 8 割に達したため既知課題の解決判定をスキップします`)
}
const acCheck = await trackedAgent(
  'pr',
  TOOL_POLICY +
  `AC 充足検証: 要件ファイル ${reqPath} を読み、各 FR の AC ごとに充足状況を検証してください。\n` +
    '検証は実コードの grep・ファイル内容の実確認・下記の検査出力のみを根拠とし、実装エージェントの自己申告・作業報告文は根拠にしないこと。\n' +
    '要件側で「手動検証必須」と区分されている AC は manualRequired: true とし、自動検証だけで met: true にしないこと。\n' +
    'あわせて `git -c core.quotePath=false diff --name-only HEAD` と `git -c core.quotePath=false ls-files --others --exclude-standard` の出力を結合した配列を workingChanges として返すこと(加工・省略しない。文書同期の結果を実差分と照らすのに使う)。\n' +
    (wantsResolution
      ? `\nあわせて既知課題の解決判定を行い candidates として返すこと: 要件ファイルの本文中で対応が明記されている既存の既知課題 ID` +
        `(${knownIssuesPath} のバックログ項目を指す ID。表記は自由文なので文脈から読み取ること)を抽出する。見つからなければ candidates: []。\n` +
        `各候補について ${knownIssuesPath} を読み、現在「未解決（バックログ）」セクションに存在するか確認し、存在しない(解決済みログに既にある等)候補は除外する。\n` +
        '解決判定の根拠は実コードの grep・実際の差分(`git diff ' +
        baseBranch +
        '`)・下記の検査結果のみとし、要件書の記述や実装エージェントの自己申告だけを根拠に resolved: true にしないこと。' +
        '根拠が不十分なら resolved: false とし、evidence にその理由を書くこと。\n'
      : '') +
    'ファイルの変更は一切行わないこと(読み取り専用)。\n' +
    `\n## 直近の検査結果(release-check)\n${JSON.stringify(finalCheck && finalCheck.results ? finalCheck.results : [])}`,
  {
    label: 'AC充足検証',
    role: 'ac-check',
    phase: 'PR準備',
    schema: {
      type: 'object',
      required: ['items', 'summary'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'met', 'manualRequired', 'evidence'],
            properties: {
              id: { type: 'string', description: 'FR-XX AC-N 形式' },
              met: { type: 'boolean' },
              manualRequired: { type: 'boolean' },
              evidence: { type: 'string', description: '充足判定の根拠(grep 結果・検査出力等)' },
            },
          },
        },
        summary: {
          type: 'string',
          description: '満たした・満たしていない AC の件数と、満たしていないものの ID と理由を 1〜2 文で',
        },
        workingChanges: { type: 'array', items: { type: 'string' }, description: '未コミットの変更ファイルと未追跡ファイル' },
        candidates: {
          type: 'array',
          description: 'requirements.md が対応を明記した既知課題 ID の解決判定(頼まれたときだけ)',
          items: {
            type: 'object',
            required: ['id', 'resolved', 'evidence'],
            properties: {
              id: { type: 'string', description: '既知課題 ID (例: N3)' },
              title: { type: 'string', description: 'バックログ項目の現在のタイトル(分かれば)' },
              resolved: { type: 'boolean' },
              evidence: { type: 'string', description: '解決 (または未解決) と判定した根拠' },
            },
          },
        },
      },
    },
    ...modelAndEffort('verify', MODELS, EFFORTS),
  }
)
if (wantsResolution) {
  const resolvedCandidates = (acCheck && Array.isArray(acCheck.candidates) ? acCheck.candidates : []).filter(
    (c) => c && c.resolved === true && typeof c.id === 'string' && c.id.trim() !== ''
  )

  if (resolvedCandidates.length === 0) {
    log('既知課題の解決済みログ移動: 対象なし')
  } else {
    const moveResult = await trackedAgent(
      'pr',
      TOOL_POLICY +
      `既知課題ドキュメント ${knownIssuesPath} を編集し、以下の候補 ID を「未解決（バックログ）」から「解決済みログ」の表へ移動してください。` +
        `編集してよいファイルは ${knownIssuesPath} のみです。候補ごとに:\n` +
        '1. 未解決セクションから対象 ID の H3 項目を探し、その項目全体を削除する(見つからなければ moved に含めず failed に {id, reason} で報告する)\n' +
        `2. 解決済みログの表へ「| <ID> | <削除した項目の内容を要約> | ${release}(candidates の evidence から対応 FR が読み取れれば付記) |」の行を追加する\n` +
        '3. 他の項目(未解決・解決済み問わず)は一切変更・削除・並べ替えしない\n\n' +
        `## 候補一覧(判定根拠つき)\n${JSON.stringify(resolvedCandidates)}`,
      {
        label: '解決済みログ移動',
        role: 'resolve',
        phase: 'PR準備',
        schema: {
          type: 'object',
          required: ['moved', 'failed'],
          properties: {
            moved: {
              type: 'array',
              description: '解決済みログへ移動した項目',
              items: {
                type: 'object',
                required: ['id', 'title'],
                properties: { id: { type: 'string' }, title: { type: 'string' } },
              },
            },
            failed: {
              type: 'array',
              description: '移動できなかった候補',
              items: {
                type: 'object',
                required: ['id', 'reason'],
                properties: { id: { type: 'string' }, reason: { type: 'string' } },
              },
            },
          },
        },
        ...modelAndEffort('docSync', MODELS, EFFORTS),
      }
    )
    if (moveResult && Array.isArray(moveResult.moved)) {
      resolvedKnownIssues.push(
        ...moveResult.moved.map((e) => ({ id: String(e?.id ?? ''), title: String(e?.title ?? '') }))
      )
    }
    if (moveResult && Array.isArray(moveResult.failed) && moveResult.failed.length > 0) {
      log(
        `既知課題の解決済みログ移動に失敗した ID があります: ${moveResult.failed
          .map((f) => `${f.id}(${f.reason})`)
          .join(' / ')}`
      )
    }
    log(`既知課題の解決済みログ移動: ${resolvedKnownIssues.length} 件`)
  }
}
const acItems = acCheck && Array.isArray(acCheck.items) ? acCheck.items : []
const manualPending = acItems.filter((i) => i.manualRequired === true && i.met !== true)
// 自動で検証できる AC の未充足。0.8.1 までは表に出るだけで、起票も draft 降格もしていなかった
const acUnmet = acItems.filter((i) => i.manualRequired !== true && i.met !== true)
if (!acCheck) {
  log('AC 充足検証エージェントが結果を返しませんでした(PR 本文には検証不能と明記し、draft にします)')
}
if (acUnmet.length > 0) {
  await fileKnownIssues(
    acUnmet.map((i) => ({
      source: 'check',
      checkKey: 'ac-check',
      severity: 'high',
      title: `受け入れ基準 ${i.id} を満たしていない`,
      detail: `受け入れ基準の照合で、満たしていないと判定した。根拠: ${i.evidence || '記載なし'}`,
    }))
  )
}
// 文書同期が「更新した」と報告した文書を実差分と照らす(導入先で、同期成功と報告された 2 文書に差分が無かった)
let syncUnverified = []
// 空配列は取得失敗とみなす(実装の変更は未コミットで残っているので、正常なら空にならない)
if (acCheck && Array.isArray(acCheck.workingChanges) && acCheck.workingChanges.length > 0) {
  const changed = new Set(acCheck.workingChanges.map(normPath))
  syncUnverified = syncedDocs.filter((p) => !changed.has(normPath(p)))
  if (syncUnverified.length > 0) {
    log(`文書同期が更新したと報告したが差分が無い文書: ${syncUnverified.join(', ')}(同期済みから外して PR 本文に明記します)`)
    syncedDocs = syncedDocs.filter((p) => changed.has(normPath(p)))
  }
}

const residualCritical = residualBlock.filter((f) => severityOf(f) === 'critical')
const residualNonCritical = residualBlock.filter((f) => severityOf(f) !== 'critical')

const prMaterial = {
  release,
  acVerification: acCheck ? { items: acItems, summary: acCheck.summary } : null,
  finalCheck: finalCheck
    ? { passed: finalCheck.passed, results: finalCheck.results, ...(finalCheckReused ? { reusedPreviousCheck: true } : {}) }
    : null,
  reviewFixed,
  residualFindings: residualBlock.map(
    (f) =>
      `[${severityOf(f)}] ${f.title}(${f.file})` +
      (f.carry && f.carry.requirementChange
        ? ': 自動修正は「要件を変えないと直せない」と判断した(人の判断待ち)'
        : f.firstSeenAtLimit
          ? ': 自動修正の上限回数に達したレビューの回で初めて見つかった(修正は試していない)'
          : isWaived(f)
          ? ': 自動修正が「直す必要はない」と申告した(別の確認はしていない)'
          : '')
  ),
  // 修正エージェントが 2 ラウンド続けて「修正不要」と申告した block 所見。理由つきで開示するが、
  // 独立した検証は無いので residualFindings にも残存として含まれる(免除ではない)
  fixWaived: fixWaived.map((f) => `[${f.severity}] ${f.title}(${f.file}): ${f.reason || '理由未記載'}`),
  unverifiableDimensions: unverifiableDims,
  // 周ごとの Codex 委譲の実態。Codex 層が欠けた周は reason に理由が入る(枠切れ・未導入・検出失敗など)
  codexReview: codexRounds,
  filedIssues,
  resolvedKnownIssues,
  syncedDocs,
  syncFailedTargets,
  // 文書同期が更新したと報告したが、実際には差分が無かった文書
  syncUnverified,
  manualPendingAcs: manualPending.map((i) => i.id),
  // 自動で検証できるのに満たしていない AC(起票済み・draft 理由)
  unmetAcs: acUnmet.map((i) => i.id),
  // 検査失敗の修正で直したと申告された検査
  checkFixed,
  // レビューの精度: 観点ごとの検証結果(verified=実在 / rejected=誤検出で棄却 / severityCorrected=深刻度を改めた)
  reviewPrecision,
  severityChanges: severityChanges.map((c) => `${c.title}(${c.file}): ${c.from} → ${c.to}`),
  // 人の判断が要る要件書への指摘。review = レビューが要件ファイルを指し、検証を通った指摘(矛盾・検証できない AC 等)、
  // fix = 解消に要件の変更が必要と修正エージェントが判断した所見
  requirementIssues: requirementIssues.map(
    (x) =>
      `[${x.severity}] ${x.title}(${x.file}): ` +
      (x.source === 'review' ? `レビューの指摘(検証済み)— ${x.detail || ''}` : x.detail)
  ),
  // 修正エージェントが要件ファイルを書き換えたので元に戻した回数と工程
  requirementEdits: requirementEdits.map((e) =>
    e.restored === false
      ? `${plainPhase(e.phase)}: 自動修正が書き換えた ${e.file} を修正前へ戻せなかった(差分を目視で確認すること)`
      : `${plainPhase(e.phase)}: 自動修正が書き換えた ${e.file} を修正前へ戻した`
  ),
  // 工程別の起動数。キーは読者向けの名前にする(内部名 gate0〜gate2 などが PR 本文の表にそのまま出ていた)
  consumption: plainConsumption(consumption),
  totalAgents,
}
// isDraft・draftReasons は PR 作成分岐で確定するので、それより前の停止経路(コミット直前停止・
// コミット失敗・critical 残存)では載せない
reportMaterial = { ...prMaterial, implementation: implementationNotes }
// 本文は機械検査(lintProse)にかけ、内部語などの違反があれば違反箇所を渡して 1 回だけ出し直させる
const prBodyAsk = (retryNote, fileName) =>
  trackedAgent(
  'pr',
  TOOL_POLICY +
  WRITING_POLICY +
  'リリース PR の本文(Markdown)とタイトルを生成してください。以下の材料 JSON のみを根拠とし、材料にない充足状況を捏造しないこと。本文には次のセクションを含めること:\n' +
    '1. 概要\n2. FR/AC 充足状況(acVerification の検証結果に基づく表。検証不能な場合はその旨)\n' +
    '3. 最終検査結果(finalCheck)と、検査失敗の修正で直した検査(checkFixed)。finalCheck.reusedPreviousCheck が true なら「最後に通った検査の後にファイルが変わっていないので、最終検査は再実行せずその結果を使った」と書く\n4. レビュー所見と対応(reviewFixed=直した指摘 / residualFindings=修正されずに残った指摘 / fixWaived=自動修正が 2 回続けて「直す必要はない」と申告した、必ず直す深刻度(config の severityGate.block。既定は critical・high)の指摘。理由つきで開示するが、別の確認はしていないので「修正されずに残った指摘」にも含まれる / unverifiableDimensions=レビューできなかった観点)。あわせて codexReview(レビューの回ごとの Codex への委譲の実態。status: used=一次レビューを Codex が担当 / quota_exhausted=利用枠切れ / failed=実行失敗 / unavailable=未導入・検出失敗 / disabled=枠切れ・base との merge-base を解決できない等で以降の回を省略(理由は reason) / not-eligible=対象外)を表にし、Codex を使えなかった回は理由を明記すること(codexReview が空なら「Codex 委譲: 対象外」)\n' +
    '5. 起票した known-issues ID(filedIssues)\n6. 更新したドキュメント(syncedDocs / syncFailedTargets)\n' +
    '7. 未実施の手動検証 AC(manualPendingAcs)と、自動検証で満たしていない AC(unmetAcs)。あれば明記\n8. 消費サマリー(consumption のフェーズ別エージェント起動数と totalAgents。**PR 本文を作った時点の値で、この後のコミット・PR 作成・通知のぶんは含まない**と明記する)\n' +
    '9. 自動的に解決済みログへ移動した既知課題(resolvedKnownIssues。空なら「該当なし」)\n' +
    '10. 要件書について人の判断が要る点(requirementIssues と requirementEdits。空なら「該当なし」)。自動修正では要件を変えていないので、要件を直すか実装を直すかをレビュアーが決める必要があると明記する\n' +
    '11. レビューの精度(reviewPrecision を観点ごとの表に。rejected が多い観点は指示の見直し候補と書く)と、深刻度を改めた所見(severityChanges)。文書同期で差分が無かった文書(syncUnverified)があれば 6 に書く\n' +
    '\n材料のキー名(residualFindings・fixWaived など)は本文に書かない。上の説明の日本語で書く。' +
    '既知課題の件名と、レビューの指摘の件名は、材料のとおりにバッククォートで囲んで引用する(言い換えない。known-issues の実際の件名と食い違わないように)。\n' +
    (runDir
      ? `\n本文は ${runDir}/${fileName} へ Write で書き出し(既存があれば上書き)、同じ本文を body としても返すこと。書き出せたら bodyFile: true、書き出せなかったら false。\n`
      : '') +
    `\n## 材料\n${JSON.stringify(prMaterial)}` +
    retryNote,
  {
    label: retryNote ? 'PR本文生成(出し直し)' : 'PR本文生成',
    role: 'pr',
    phase: 'PR準備',
    schema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', description: '変更の中身が分かる 1 行(何を・どうしたか)。リリース識別子だけにしない' },
        body: { type: 'string', description: 'PR 本文(Markdown)。各節の最初の文で、その節の結論を具体名(パス・コマンド・AC の ID)で書く' },
        bodyFile: { type: 'boolean', description: `本文を ${runDir}/${fileName} へ書き出せたか` },
      },
    },
    ...modelAndEffort('docSync', MODELS, EFFORTS),
  }
)
let prDraft = await prBodyAsk('', 'pr-body.md')
// 採った本文が書き出されたファイル。出し直しは別のファイルに書かせ、採ったときだけ差し替える
// (同じファイルに書かせると、採らなかった本文で PR が作られ、戻り値の本文と食い違う)
let prBodyFileName = 'pr-body.md'
if (prDraft && typeof prDraft.body === 'string') {
  const violations = lintProse(prDraft.body, 'pr')
  proseLint.prBody = violations.length
  if (violations.length > 0) {
    log(`PR 本文の機械検査で ${violations.length} 件の違反 — 1 回だけ出し直させます`)
    const again = await prBodyAsk(
      `\n## 出し直し\n前回の本文に、次の問題があった。該当する箇所を直した本文を、同じ手順で書き出して返すこと(直す必要の無い箇所は変えない):\n` +
        violations.map((v) => `- ${v.hint}(該当: ${v.excerpt.replace(/[{}]/g, '')})`).join('\n') +
        '\n',
      'pr-body.retry.md'
    )
    // 出し直しの方が違反が少ないときだけ採る(増えた・変わらないなら初回のまま)。件名は初回のものを保つ
    const againCount = again && typeof again.body === 'string' ? lintProse(again.body, 'pr').length : Infinity
    if (againCount < violations.length) {
      prDraft = { ...again, title: prDraft.title || again.title }
      prBodyFileName = 'pr-body.retry.md'
      proseLint.prBody = againCount
    }
    if (proseLint.prBody > 0) log(`PR 本文の機械検査: 出し直し後も ${proseLint.prBody} 件の違反が残っています(戻り値の proseLint に載せます)`)
  }
}
const prTitle = prDraft && prDraft.title ? prDraft.title : release
const prBodyDraft = prDraft ? prDraft.body : '(PR 本文の生成に失敗しました。材料は run-release の戻り値を参照)'
// 本文生成体が書き出したファイル。PR 作成体に長い本文を写させない(PR 作成は転記役の軽量モデルで、
// 数千字の本文を HEREDOC へ一字一句写すと崩しうる)。書き出せなかったときだけ従来どおりプロンプトで渡す
const prBodyFile = runDir && prDraft && prDraft.bodyFile === true ? `${runDir}/${prBodyFileName}` : null

// ---- コミット(AC-8): autoApprove=false はコミット直前で停止して案を返す ----
phase('コミット')
const planRes = await trackedAgent(
  'commit',
  TOOL_POLICY +
  WRITING_POLICY +
  'git status --porcelain と git diff で現在の未コミット変更を確認し、論理単位のコミット分割案を作ってください。各コミットは message(このリポジトリの既存コミットの文体に合わせる)と files(対象ファイルのリポジトリルート相対パス)で構成し、全変更ファイルをいずれか 1 つのコミットに割り当てること。この段階では git add / git commit を実行しないこと(読み取り専用)。' +
    'あわせて git ls-files --others --exclude-standard の出力を、1 行 1 パスの配列 untracked として返すこと(加工・省略しない)。' +
    (foreignFiles.size > 0
      ? `\n\n次のファイルはこのリリースの工程が作ったものではない(run の途中で追加された)ので、どのコミットにも含めないこと: ${[...foreignFiles].join(', ')}`
      : ''),
  {
    label: 'コミット分割案',
    role: 'commit',
    phase: 'コミット',
    schema: {
      type: 'object',
      required: ['commits'],
      properties: {
        commits: {
          type: 'array',
          items: {
            type: 'object',
            required: ['message', 'files'],
            properties: {
              message: {
                type: 'string',
                description: '既存のコミットの文体に合わせた件名(と必要なら本文)。何をなぜ変えたかが分かるように。「修正」「更新」だけにしない',
              },
              files: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        untracked: { type: 'array', items: { type: 'string' }, description: 'コミット前の未追跡ファイル' },
      },
    },
    ...modelAndEffort('docSync', MODELS, EFFORTS),
  }
)
// 最後の修正より後に増えた未追跡ファイル(文書同期・検査の生成物・人の追加)もここで判定する。
// リリース外のファイルは分割案から外し、コミット実行体にも add させない(PR 本文にも列挙する)
if (planRes && Array.isArray(planRes.untracked)) {
  if (untrackedGap) {
    // 最後の修正が作ったファイルを特定できていない: いまの未追跡ファイルは所有扱いにする(判定済みのリリース外は除く)
    log('注: 最後の修正で未追跡ファイルの前後比較ができなかったため、現在の未追跡ファイルをリリースのファイルとして扱います')
    noteOwned(planRes.untracked)
    untrackedGap = false
  }
  noteForeign(planRes.untracked)
}
const foreignList = [...foreignFiles]
const commitPlan = (planRes && Array.isArray(planRes.commits) ? planRes.commits : [])
  .map((c) => ({ ...c, files: (Array.isArray(c.files) ? c.files : []).filter((p) => !foreignFiles.has(normPath(p))) }))
  .filter((c) => c.files.length > 0)
if (foreignList.length > 0) {
  log(`リリース外のファイル ${foreignList.length} 件はコミットしません: ${foreignList.slice(0, 5).join(', ')}${foreignList.length > 5 ? ' ほか' : ''}`)
}
/** PR 本文の末尾に付ける、コミットしなかったリリース外ファイルの節(エンジンが書く。該当が無ければ空文字)。 */
const foreignSection =
  foreignList.length > 0
    ? `\n\n## コミットしなかったファイル(run の途中で追加された、このリリース外のファイル)\n${foreignList.map((p) => `- ${p}`).join('\n')}`
    : ''
if (reportMaterial) reportMaterial = { ...reportMaterial, foreignFiles: foreignList }

if (!autoApprove) {
  return await finishWith(
    'stopped',
    'autoApprove=false のためコミット直前で停止しました。commitPlan と prBodyDraft を確認し、/logical-commits(対話承認)でコミットしてください' +
      (foreignList.length > 0 ? `。run の途中で追加されたファイル ${foreignList.length} 件(foreignFiles)はコミットに含めないこと` : ''),
    { commitPlan, prBodyDraft, foreignFiles: foreignList }
  )
}

const committed = await trackedAgent(
  'commit',
  TOOL_POLICY +
  '以下のコミット分割案に従って論理単位コミットを実行してください。コミットごとに対象ファイルのみを git add してから git commit すること。push は禁止。分割案が空・不完全な場合は git status で変更を確認し、適切な論理単位で全変更をコミットすること。\n' +
    (foreignList.length > 0
      ? `ただし次のファイルはこのリリース外なので、分割案の有無にかかわらず git add しないこと(作業ツリーに残す): ${foreignList.join(', ')}\n`
      : '') +
    `\n## コミット分割案\n${JSON.stringify(commitPlan)}`,
  {
    label: 'コミット実行',
    role: 'commit',
    phase: 'コミット',
    schema: {
      type: 'object',
      required: ['commits'],
      properties: {
        commits: {
          type: 'array',
          items: { type: 'string', description: '実行したコミットのハッシュとメッセージ' },
        },
      },
    },
    ...modelAndEffort('docSync', MODELS, EFFORTS),
  }
)
if (!committed) {
  return await finishWith('stopped', 'コミット実行エージェントが失敗しました。作業ツリーの状態を確認してください', {
    commitPlan,
    prBodyDraft,
  })
}

// ---- PR 作成分岐(AC-9) ----
phase('PR作成')
if (residualCritical.length > 0) {
  // critical 残存: PR を作らず停止(コミット済みのブランチ・作業状態は保全し、reset しない)
  return await finishWith(
    'no-pr',
    `critical の指摘が修正されずに残ったので、PR を作らずに止めた: ${residualCritical.map((f) => f.title).join(' / ')}`,
    { commitPlan, prBodyDraft }
  )
}
const draftReasons = []
if (residualNonCritical.length > 0) {
  const waivedCount = residualNonCritical.filter(isWaived).length
  draftReasons.push(
    `未解決の high 所見 ${residualNonCritical.length} 件` +
      (waivedCount > 0 ? `(うち修正不要の申告のみで未検証 ${waivedCount} 件)` : '')
  )
}
if (finalCheckDegraded) {
  draftReasons.push('最終検査の失敗を、自動修正で直しきれなかった')
}
if (gate2NonConvergence) {
  draftReasons.push(`レビューの指摘を直しきれなかった: ${gate2NonConvergence}`)
}
if (manualPending.length > 0) {
  draftReasons.push(`手動検証必須 AC が未実施: ${manualPending.map((i) => i.id).join(', ')}`)
}
if (acUnmet.length > 0) {
  draftReasons.push(`自動検証で満たしていない AC: ${acUnmet.map((i) => i.id).join(', ')}`)
}
if (!acCheck) {
  draftReasons.push('AC 充足検証が結果を返さず、受け入れ基準を確かめられていない')
}
// 要件ファイルの書き戻し失敗は上で別の理由として載せているので、ここではテスト改変などだけを扱う
const otherGuardViolations = guardViolations.filter((g) => g.checkKey !== 'requirements-guard')
if (otherGuardViolations.length > 0) {
  // テスト改変(戻し済み)など。修正の中身を人が確かめる必要がある
  draftReasons.push(`修正の検査で問題を検出: ${otherGuardViolations.map((g) => g.title).join(' / ')}`)
}
if (requirementEdits.some((e) => e.restored === false)) {
  // 修正体が書き換えた要件ファイルが戻っていない = 承認されていない要件の変更がコミットに入っている
  draftReasons.push(`自動修正が書き換えた要件ファイル ${reqPath} を元に戻せなかった(要件の差分を確認すること)`)
}
if (foreignList.length > 0) {
  // 自動では「検査が生成したコミット対象(テストのスナップショット等)」と「人が途中で足したファイル」を
  // 区別できない。黙って漏らさないよう、除外したら必ず人に確認させる
  draftReasons.push(
    `run の途中で現れた未追跡ファイル ${foreignList.length} 件をコミットしなかった(リリースに必要なファイルが含まれていないか確認し、必要なら追加でコミットする)`
  )
}
const isDraft = draftReasons.length > 0
reportMaterial = { ...prMaterial, isDraft, draftReasons, implementation: implementationNotes, foreignFiles: foreignList }
const prBody =
  (isDraft
    ? `${prBodyDraft}\n\n## Draft 理由(未解決事項)\n${draftReasons.map((r) => `- ${r}`).join('\n')}`
    : prBodyDraft) + foreignSection

// PR 作成の可否(config.automation.createPr、省略時 true)。gh CLI の認証アカウントが
// リモートリポジトリへアクセスできない環境(例: push は専用 SSH 鍵で可能だが gh は別
// アカウント認証)では false にする。false の場合は push までを実行し、PR タイトル・
// 本文を戻り値で返してユーザーによる手動作成(ブラウザ等)に委ねる
const createPr = automation.createPr !== false

if (!createPr) {
  const pushRes = await trackedAgent(
    'pr',
    TOOL_POLICY +
    'リリースブランチを push してください(config.automation.createPr=false のため PR 作成は行わない)。手順:\n' +
      `1. git branch --show-current が ${release} であることを確認する(異なれば何もせず pushed: false で報告)\n` +
      `2. \`git push -u origin ${release}\` を実行する。実行してよい push コマンドはこれのみ。${baseBranch} への push・force push は絶対に行わないこと\n` +
      '3. push の成否を pushed として報告する。gh pr create 等の PR 作成、および認証情報(トークン・鍵・設定ファイル)の探索は行わないこと',
    {
      label: 'push(PR手動作成)',
      role: 'pr',
      phase: 'PR作成',
      schema: {
        type: 'object',
        required: ['pushed'],
        properties: { pushed: { type: 'boolean' } },
      },
      ...modelAndEffort('bootstrap', MODELS, EFFORTS),
    }
  )
  if (!pushRes || pushRes.pushed !== true) {
    return await finishWith('stopped', 'push に失敗しました。ブランチとリモートの状態を確認してください', {
      commitPlan,
      prBodyDraft,
      prTitle,
      prBody,
      isDraft,
      draftReasons,
    })
  }
  phase('通知')
  const status = isDraft ? 'pushed-manual-pr-draft' : 'pushed-manual-pr'
  await notify(
    `run-release: ${status}`,
    `${release}: push 済み。PR はタイトル・本文案から手動作成してください${isDraft ? `(draft 推奨: ${draftReasons.join(' / ')})` : ''}`
  )
  log(`run-release ${status}: push 済み・PR は手動作成待ち(エージェント起動数 概算 ${totalAgents})`)
  return {
    status,
    prTitle,
    prBody,
    isDraft,
    draftReasons,
    filedIssues,
    resolvedLogProposal,
    resolvedKnownIssues,
    consumption,
    codexReview: codexRounds,
    proseLint,
    fixWaived,
    reportMaterial: reportMaterialNow(),
    commitPlan,
    prBodyDraft,
  }
}

const prRes = await trackedAgent(
  'pr',
  TOOL_POLICY +
  'リリースブランチを push して PR を作成してください。手順:\n' +
    `1. git branch --show-current が ${release} であることを確認する(異なれば何もせず pushed: false で報告)\n` +
    `2. \`git push -u origin ${release}\` を実行する。実行してよい push コマンドはこれのみ。${baseBranch} への push・force push は絶対に行わないこと\n` +
    (prBodyFile
      ? `3. 次のコマンドを一字一句そのまま実行して PR 本文ファイルを用意し、PR を作成する(本文ファイルは読まなくてよい。内容を書き換えないこと)\n\`\`\`\n${prBodyCommand(prBodyFile, prBody.slice(prBodyDraft.length), `gh pr create --base ${shq(baseBranch)}${isDraft ? ' --draft' : ''} --title ${shq(prTitle)} --body-file ${shq(`${prBodyFile}.final`)}`)}\n\`\`\`\n`
      : `3. gh pr create --base ${baseBranch}${isDraft ? ' --draft' : ''} で PR を作成する。タイトル: ${prTitle}\n` +
        '   本文は以下の「PR 本文」を一字一句そのまま使うこと(HEREDOC や一時ファイル経由で正確に渡す)\n') +
    '4. 作成された PR の URL を url として報告する\n' +
    '   注意: push や gh の認証エラーで失敗した場合、認証情報(トークン・鍵・設定ファイル)の探索や別手段での回避を試みず、pushed と url:"" で失敗をそのまま報告すること\n' +
    (prBodyFile ? '' : `\n## PR 本文\n${prBody}`),
  {
    label: isDraft ? 'draft PR作成' : 'PR作成',
    role: 'pr',
    phase: 'PR作成',
    schema: {
      type: 'object',
      required: ['pushed', 'url'],
      properties: {
        pushed: { type: 'boolean' },
        url: { type: 'string', description: '作成した PR の URL(失敗時は空文字列)' },
      },
    },
    ...modelAndEffort('bootstrap', MODELS, EFFORTS),
  }
)
if (!prRes || prRes.pushed !== true || !prRes.url) {
  return await finishWith('stopped', 'push または PR 作成に失敗しました。ブランチとリモートの状態を確認してください', {
    commitPlan,
    prBodyDraft,
  })
}

phase('通知')
const prUrl = prRes.url
const status = isDraft ? 'draft-pr' : 'completed'
await notify(
  `run-release: ${status}`,
  `${release}: ${prUrl}${isDraft ? `(draft 理由: ${draftReasons.join(' / ')})` : ''}`
)
log(`run-release ${status}: ${prUrl}(エージェント起動数 概算 ${totalAgents})`)

return {
  status,
  prUrl,
  filedIssues,
  resolvedLogProposal,
  resolvedKnownIssues,
  consumption,
  codexReview: codexRounds,
  proseLint,
  fixWaived,
  reportMaterial: reportMaterialNow(),
  commitPlan,
  prBodyDraft,
}
