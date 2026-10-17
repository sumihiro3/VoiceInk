export const meta = {
  name: 'implement-feature',
  description: 'リリース要件を入力に、探索→設計→実装→検証を行う機能実装パイプライン',
  whenToUse:
    '確定済み要件を実装するとき。args: {release: "release-1"} でリリース指定、または {task: "..."} で単発タスク指定。スコープを絞る場合は {scope: "..."} を併用。{config: {...}} で設定を直接渡せる。{skipVerify: true} で最終検証(release-check のネスト実行)を省略する(run-release からの起動用)。{auditBaseRef: "<コミットSHA>"} で照合フェーズの基準コミットを指定(run-release が Gate 0.5 リトライ間で基準を保持するために渡す。省略時は実行開始時の HEAD を自分で記録する)',
  phases: [
    { title: '準備', detail: 'config 読込と入力検証', model: 'haiku' },
    { title: '探索', detail: '関連コードの調査(要件は設計が原文を読む)', model: 'sonnet' },
    { title: '設計', detail: '実装計画と作業項目への分解', model: 'opus' },
    {
      title: '実装',
      detail:
        'ファイル競合の無い作業項目はバッチ化して並列実装、競合する項目間のみ逐次。失敗項目は 1 回リトライ',
      model: 'config.models.implementLow/Mid/High(複雑度スコアで決定)',
    },
    { title: '照合', detail: '報告された変更ファイルと git 差分の機械照合', model: 'haiku' },
    {
      title: '検証',
      detail: 'release-check ワークフローをネスト実行(skipVerify 指定時は省略)',
      model: 'haiku',
    },
  ],
}

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
 * 作業方針。実装・修正エージェント共通の第 2 の共有ブロックで、TOOL_POLICY の直後に置く
 * (TOOL_POLICY はバイト一致テストで固定しているため触らない)。run-release.js と同一内容(テストで固定)。
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
 * 増える(実測: 実装 16 体の平均 174 ターン・最大 295 ターン)。n が 0 なら指示しない。
 * 遵守率は実測で確かめること(usage-report.py の turns/agent)。
 */
function softCapInstruction(n) {
  return n > 0
    ? `- ツール呼び出しがおおよそ ${n} 回に達したら、キリのよいところ(編集が整合した状態)で作業を止め、status: "partial" として残作業を remaining に書いて報告する(変更したファイルも報告する)。続きは別のエージェントが引き継ぐので、無理に 1 体で完走しないこと\n`
    : ''
}

// モデル使い分けの方針: 探索・設計・実装のモデルは config.models から取得する。
// 実装フェーズは複雑度スコア(1-10、設計フェーズが作業項目ごとに採点)を 2 つの閾値で 3 段に分け、
// implementLow / implementMid / implementHigh を割り当てる。閾値を変えるだけで中位モデルの
// 担当範囲を調整できる。LOW_MAX_COMPLEXITY 以下 → implementLow、HIGH_MIN_COMPLEXITY 以上 →
// implementHigh、その間(既定 3-7 の 5 段階、10 段中最も広い帯)は implementMid。
// 上位モデルの境界は設計プロンプトの採点基準「8-10: 新規のアーキテクチャ判断・複雑な状態管理…」に揃える
// (0.9.0 までは 9 で、採点基準では上位の 8 が中位モデルに回っていた)。
const LOW_MAX_COMPLEXITY = 2
const HIGH_MIN_COMPLEXITY = 8

// args は JSON 文字列で渡ってくる場合があるためパースする
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    input = { task: input }
  }
}
input = input || {}

const release = input.release
const taskDesc = input.task || ''
const scope = input.scope || ''
if (!release && !taskDesc) {
  throw new Error('args.release(例: {release: "release-1"})または args.task を指定してください')
}

// 実際に起動したエージェント数。呼び出し元(run-release)は戻り値からの概算で起動数の上限判定を
// していたため下限しか見えていなかった。数え漏らしを防ぐため agent() は必ずこのラッパ経由で呼ぶ。
// parallel() へ渡すサム内でも、実際に起動する時点で加算されるため正しく数えられる。
// ネスト実行する release-check 内の起動数は観測できないためここには含まない
// (run-release は skipVerify: true で起動するので、呼び出し元から見た欠落は無い)
let agentsUsed = 0

/**
 * agent() を起動数カウント付きで呼ぶ。このファイル内の agent() 呼び出しは全てこれを経由する。
 * 役割マーカー `[crw:role=<役割>]` をプロンプト末尾(可変部)へ付ける — engine/tools/usage-report.py が
 * transcript から工程別の消費を集計するための目印(末尾なので前方一致キャッシュには影響しない)。
 */
function trackedAgent(prompt, opts) {
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

// config ブートストラップ: args.config が無ければリポジトリの workflow.config.json を読む。
// エージェントによる値の捏造を防ぐため、不存在は exists: false で報告させたうえで明示 throw する。
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
    TOOL_POLICY +
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
  if (loaded && loaded.exists && loaded.config) config = loaded.config
}
if (!config) {
  throw new Error(
    'workflow.config.json が読めません。args.config を渡すか .claude/workflow.config.json を作成してください'
  )
}
if (config.configVersion !== 1) {
  throw new Error(
    `workflow.config.json の configVersion がエンジン要求版(1)と一致しません: ${config.configVersion}`
  )
}

const MODELS = config.models || {}
const EFFORTS = config.efforts || {}
const automation = config.automation || {}
// 実装エージェント 1 体のツール呼び出しの目安(超えたら引き継ぎ)。0 で無効
const maxToolCallsPerAgent = Number.isInteger(automation.maxToolCallsPerAgent)
  ? automation.maxToolCallsPerAgent
  : 60
// 1 作業単位あたりの引き継ぎ回数の上限。超えても未完なら failedItems へ(Gate 0.5 が拾う)
const maxAgentContinuations = Number.isInteger(automation.maxAgentContinuations)
  ? automation.maxAgentContinuations
  : 2
// 1 作業単位が触るファイル数の上限。超える項目は設計側に subtasks へ分割させる。0 で無効。
// エージェントはターン数を見積もれない(「30〜40 ターン」の目安は 10 FR → 16 単位・平均 174 ターンだった)ので、
// 機械的に判定できるファイル数を基準にする
const maxFilesPerWorkItem = Number.isInteger(automation.maxFilesPerWorkItem)
  ? automation.maxFilesPerWorkItem
  : 4

// 照合フェーズの基準コミット。run-release から渡される(Gate 0.5 リトライでも 1 回目開始時の
// 基準を保持し、1 回目の試行中の無断コミットをリトライの照合が拾えるようにするため)。
// 単体実行時は探索フェーズで自分の開始時 HEAD を記録する
let auditBaseRef =
  typeof input.auditBaseRef === 'string' && /^[0-9a-f]{7,40}$/i.test(input.auditBaseRef.trim())
    ? input.auditBaseRef.trim()
    : null

/**
 * 複雑度スコア(1-10)から実装フェーズの役割を決める。モデルと effort は modelAndEffort がこの役割から引く。
 *
 * @param score 設計フェーズが採点した複雑度(1-10)。
 * @returns 'implementLow' / 'implementMid' / 'implementHigh' のいずれか(config.models のキー)。
 */
function implementRoleFor(score) {
  if (score <= LOW_MAX_COMPLEXITY) return 'implementLow'
  if (score >= HIGH_MIN_COMPLEXITY) return 'implementHigh'
  return 'implementMid'
}

// 要件ファイルパスは config のテンプレート({release} プレースホルダ)から組み立てる
const reqPathTemplate = config.requirementsPath || 'docs/releases/{release}/requirements.md'
const reqPath = release ? reqPathTemplate.replace('{release}', release) : null
const target = reqPath
  ? `要件ファイル ${reqPath}${scope ? `(今回のスコープ: ${scope})` : ''}`
  : `タスク: ${taskDesc}`

// エージェントはカレント作業ディレクトリ(=リポジトリルート)前提で動かす。規約文書は config から取得
const conventionsDoc = config.conventionsDoc || 'CLAUDE.md'
// git 状態変更の禁止は実障害由来: 実装サブエージェントが無断で git commit すると変更が HEAD 差分
// から消え、照合フェーズ(run-release Gate 0.5 の入力)で捏造疑いの偽陽性になる
const REPO_RULE = `リポジトリはカレント作業ディレクトリ。CLAUDE.md と ${conventionsDoc} の規約に従うこと。git の状態を変更する操作(git add・git commit・git push・git stash 等)は一切禁止 — 変更はファイル編集のみで作業ツリーに残すこと(コミットは後工程が一括で行う)。`
const RULES = TOOL_POLICY + REPO_RULE
// 実装エージェントだけは作業方針(WORK_POLICY)とソフト上限も前置きに含める(探索・設計には要らない)
const IMPLEMENT_RULES = TOOL_POLICY + WORK_POLICY + softCapInstruction(maxToolCallsPerAgent) + '\n' + REPO_RULE
// 最後の引き継ぎ先(finisher)はソフト上限を外して完走させる。上限は最適化であって、引き継ぎを
// 使い切った作業項目が failedItems → Gate 0.5 → no-pr と転がる理由にしてはいけない
// (導入先の実測では実装 1 体の平均が 96 回・最大 166 回で、60 × 3 は余裕とは言えない)
const IMPLEMENT_RULES_UNCAPPED = TOOL_POLICY + WORK_POLICY + '\n' + REPO_RULE

// 実装完了前の format/lint 自走指示に使う検査コマンド一覧。config.checks (プロジェクト固有値) を
// そのまま文字列展開するだけで、コマンド文字列自体はソースにハードコードしない。
// どの key が format/lint に相当するかはエージェント側の判断に委ねる(config.checks の key 命名は
// プロジェクトごとに異なりうるため、エンジン側で固定の key 名と照合しない)。
const checksList = Array.isArray(config.checks) ? config.checks : []
const selfCheckInstruction =
  checksList.length > 0
    ? `\n\n## 作業完了前の自走検査\n以下の検査コマンドのうち format・lint に相当するものを自分で判別し、自分が編集したファイルに対して実行すること。自分の変更に起因する失敗があれば、完了報告の前に整形・修正し、再実行してパスすることを確認してから完了とすること(他者の変更に起因する既存の失敗まで修正する必要はない)。\n${checksList
        .map(
          (c) =>
            `- key=${c.key}: \`${c.cmd}\`${c.cwd && c.cwd !== '.' ? `(${c.cwd} 配下で実行)` : ''}`
        )
        .join('\n')}`
    : ''

phase('探索')
const needHeadCapture = !auditBaseRef
// 要件は要約させず、設計体に原文を読ませる(0.8.x までは軽量モデルが要約してから渡しており、
// 受け入れ基準やスコープ外の記述が落ちても設計側からは気づけなかった)
const requirementsBlock = reqPath
  ? `${target} を Read で全文読み、機能要件・受け入れ基準・スコープ外・未解決事項を踏まえること(要約は渡さない。原文が正)。`
  : target
const [codeMap, headReport] = await parallel([
  // 調査結果(codeMap)は実装エージェント全員のプロンプト前置きに載り、以後の全ターンへ再送される。
  // 長さがそのままターン数の二乗でコンテキストに効くため、報告量に上限を課す
  () =>
    trackedAgent(
      `${RULES}\n${target} に関連する既存コードを調査してください。関連ファイルパス、既存パターン、再利用できる実装、変更が必要になりそうな箇所を報告してください。\n報告は 8,000 字以内に収めること。超える見込みなら「関連ファイル一覧 + 各 1 行の役割」形式へ圧縮し、コード本文の引用は行わないこと。`,
      { label: 'コード調査', role: 'explore', phase: '探索', agentType: 'Explore', ...modelAndEffort('explore', MODELS, EFFORTS) }
    ),
  () =>
    needHeadCapture
      ? trackedAgent(
          TOOL_POLICY +
            'カレントリポジトリで `git rev-parse HEAD` を実行し、出力のコミット SHA を head として返してください。出力の加工・省略・推測は禁止。',
          {
            label: '開始時HEAD記録',
            role: 'state',
            phase: '探索',
            schema: { type: 'object', required: ['head'], properties: { head: { type: 'string' } } },
            ...modelAndEffort('bootstrap', MODELS, EFFORTS),
          }
        )
      : Promise.resolve(null),
])
if (needHeadCapture) {
  const h = headReport && typeof headReport.head === 'string' ? headReport.head.trim() : ''
  auditBaseRef = /^[0-9a-f]{7,40}$/i.test(h) ? h : null
  if (!auditBaseRef) {
    log('注: 実行開始時 HEAD を記録できませんでした。照合は HEAD 差分と未追跡ファイルのみで行います')
  }
}

phase('設計')

// 複雑度採点の較正例は config.complexityRubricExamples から取得する(プロジェクトごとに差し替え可能)
const rubric = config.complexityRubricExamples || {}
const rubricLow = rubric.low ? `(例: ${rubric.low})` : ''
const rubricMid = rubric.mid ? `(例: ${rubric.mid})` : ''
const rubricHigh = rubric.high ? `(例: ${rubric.high})` : ''

const DESIGN_SCHEMA = {
  type: 'object',
  required: ['summary', 'items'],
  properties: {
    summary: {
      type: 'string',
      description: '実装方針。どのファイルに何を足し・変えるか、既存のどの仕組み(関数・モジュール)を使うかを具体名で',
    },
    items: {
      type: 'array',
      description: '実装順に並べた作業項目',
      items: {
        type: 'object',
        required: ['title', 'description', 'files', 'complexity'],
        properties: {
          title: { type: 'string' },
          description: { type: 'string', description: '変更内容と完了条件' },
          files: {
            type: 'array',
            items: { type: 'string' },
            description:
              '作成・編集する全ファイル(新規作成を含む)。実装フェーズの並列実行の競合判定に使うため、共有ヘッダ・設定雛形等の新規作成も漏れなく含めること',
          },
          complexity: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            description:
              '実装の複雑度(1-10、実装に割り当てるモデルの強さを決める採点)。' +
              '次の3観点を総合して採点すること: ' +
              '(a) 新規設計判断の有無(既存パターンの単純適用か、新しい抽象・状態管理・並行制御の設計が要るか)、' +
              '(b) 変更範囲(単一ファイルの局所変更か、複数レイヤーにまたがる契約変更か)、' +
              '(c) バグ混入リスク(機械的な値変更か、境界値・タイミング・レイアウト計算等が絡むか)。' +
              '目安 — 1-3: 機械的な置換・定数値の変更・定型パターンのそのままの適用' +
              rubricLow +
              '。4-7: 典型的な実装(既存パターンの組み合わせ・中程度の分岐、大半の作業項目はここ)' +
              rubricMid +
              '。8-10: 新規のアーキテクチャ判断・複雑な状態管理・レイアウト計算等の新規ロジック・' +
              '既存規約からの逸脱を伴う判断' +
              rubricHigh +
              '。',
          },
          // optional。1 体のターン数が伸びるほどコンテキストは二乗で膨らむため、
          // 大きすぎる作業項目は設計側で分割させ、実装フェーズは分割後を作業単位にする
          subtasks: {
            type: 'array',
            description:
              '1 エージェントでは 30〜40 ターンに収まらない見込みの項目だけ、分割した作業単位を実装順に並べる' +
              '(収まる項目では省略すること)。分割した場合、実装は親項目ではなくこの単位で行われる。',
            items: {
              type: 'object',
              required: ['title', 'description', 'files'],
              properties: {
                title: { type: 'string' },
                description: { type: 'string', description: '変更内容と完了条件' },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '触る予定のファイル(親項目の files の部分集合)',
                },
              },
            },
          },
        },
      },
    },
  },
}
// 設計出力がプレースホルダ的なジャンクでないかを検査する。
// (既知の事故: 大きな StructuredOutput 送信がペイロード切断され、切り分け用の
// 最小診断ペイロード(summary:"test", items:[{title:"t",...}])がそのまま正式な
// 設計出力として採用され、実装ゼロで終了した。docs/known-issues.md 解決済みログ参照)
function isJunkDesign(d) {
  if (!d || typeof d.summary !== 'string' || d.summary.trim().length < 15) return true
  if (!Array.isArray(d.items) || d.items.length === 0) return true
  return d.items.some((item) => {
    if (!item || typeof item.title !== 'string' || item.title.trim().length < 4) return true
    if (typeof item.description !== 'string' || item.description.trim().length < 8) return true
    if (!Array.isArray(item.files) || item.files.length === 0) return true
    // 拡張子・パス区切りの有無では判定しない(Makefile・Dockerfile・LICENSE 等の
    // 拡張子なしファイルを誤ってジャンク判定してしまうため)。空文字のみ弾く
    return item.files.some((f) => typeof f !== 'string' || f.trim().length === 0)
  })
}

const designPrompt = `${RULES}\n以下の要件と現状調査をもとに実装計画を設計し、実装順に並べた作業項目に分解してください。各項目は独立して検証できる粒度にすること。依存関係がある場合は、依存される側を先に並べること。\n1 つの作業項目は 1 エージェントが 30〜40 ターン程度で終わる粒度にすること。それを超える見込みの項目は subtasks へ分割すること(分割した項目は subtasks の単位で実装される)。${maxFilesPerWorkItem > 0 ? `\n**files が ${maxFilesPerWorkItem} 件を超える項目は必ず subtasks へ分割し、各 subtask の files は親の files の部分集合で ${maxFilesPerWorkItem} 件以下にすること**(超えたまま出すと、分割のためだけに設計をもう 1 回やり直す)。` : ''}\n\n## 並列実行を前提にした並べ方\n実装フェーズは、実装順に隣接する項目のうち files が重ならないものを同じバッチにまとめて並列実行し、重なった時点でバッチを区切る(バッチ間は逐次)。したがって:\n- files には新規作成を含め、その項目が作成・編集する全ファイルを漏れなく列挙すること(共有ヘッダ・設定雛形・.gitignore 等も含む)。列挙漏れは並列中の他項目との上書き事故になる\n- 互いに独立な系列(要件に「独立に実装可能」とある別デバイス・別パッケージ等)が複数ある場合は、依存順を崩さない範囲で系列を交互に並べ、同じファイルを触る項目が連続しないようにすること\n- エントリポイントや結線ファイルを多くの項目で触る計画にしない。各項目は自分のモジュールに閉じ、共有ファイルへの結線は末尾の項目 1 件に集約すること\n\n## 要件\n${requirementsBlock}\n\n## 現状調査\n${codeMap}`

let design = await trackedAgent(designPrompt, {
  label: '設計',
  role: 'design',
  phase: '設計',
  schema: DESIGN_SCHEMA,
  ...modelAndEffort('design', MODELS, EFFORTS),
})
if (!design) {
  throw new Error('設計エージェントが失敗しました。再実行してください')
}

if (isJunkDesign(design)) {
  log('設計出力がプレースホルダ的で無効と判定されたため、再設計を1回試行します')
  design = await trackedAgent(
    `${designPrompt}\n\n前回の出力はプレースホルダ的な内容(極端に短い title/description、意味のない files 等)で無効でした。` +
      `具体的で実行可能な作業項目に分解し直してください。StructuredOutput の送信が大きすぎて失敗する場合は、` +
      `items の description を短く圧縮して再送すること(切り分け用の最小ペイロードを最終出力として送らないこと)。`,
    { label: '設計(再試行)', role: 'design', phase: '設計', schema: DESIGN_SCHEMA, ...modelAndEffort('design', MODELS, EFFORTS) }
  )
  if (!design || isJunkDesign(design)) {
    throw new Error(
      '設計エージェントが有効な設計を出力できませんでした(プレースホルダ的な出力が続いています)。要件を分割するか手動で設計を確認してください。'
    )
  }
}
log(`設計完了: ${design.items.length} 作業項目`)

// ---- 作業項目の粒度の機械的な検査: files が上限を超えるのに subtasks が無い項目は設計側に分割させる ----
// 上限は設計プロンプトにも明記しているので、ここに来るのは設計体が守らなかったときだけ。
// 設計プロンプトの「30〜40 ターン」は目安として残すが、エージェントはターン数を見積もれない
// (実測: 10 FR → 16 単位で平均 174 ターン)。ファイル数なら機械的に判定できる。再設計は 1 回だけで、
// それでも超えていればそのまま進める(無限ループにしない)
/** files が上限を超え、かつ使える subtasks を持たない作業項目。 */
function oversizedItems(items) {
  return items.filter(
    (item) =>
      Array.isArray(item.files) &&
      item.files.length > maxFilesPerWorkItem &&
      !(Array.isArray(item.subtasks) && item.subtasks.length > 0 && item.subtasks.every(isUsableSubtask))
  )
}
if (maxFilesPerWorkItem > 0) {
  const big = oversizedItems(design.items)
  if (big.length > 0) {
    log(`設計: 触るファイルが ${maxFilesPerWorkItem} を超える作業項目 ${big.length} 件を subtasks へ分割させます`)
    const split = await trackedAgent(
      `${RULES}\n次の作業項目は 1 エージェントで扱うには大きい(触るファイルが ${maxFilesPerWorkItem} を超える)。それぞれを実装順に並べた subtasks へ分割してください。\n` +
        `- 各 subtask の files は親の files の部分集合で ${maxFilesPerWorkItem} 以下にすること\n` +
        '- 1 subtask は 1 エージェントが 30〜40 ターン程度で終わる粒度にすること(1 画面・1 ルート・1 モジュール程度)\n' +
        '- 他の subtask が使う型・契約(インターフェース)を定義する subtask は、それを使う subtask より前に置くこと\n' +
        '- title は親項目のタイトルを一字一句そのまま返すこと(照合に使う)。対象外の項目は含めないこと\n\n' +
        `## 分割対象\n${JSON.stringify(
          big.map((i) => ({ title: i.title, description: i.description, files: i.files })),
          null,
          2
        )}\n\n## 実装方針(参考)\n${design.summary}`,
      {
        label: '設計(分割)',
        role: 'design',
        phase: '設計',
        schema: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['title', 'subtasks'],
                properties: {
                  title: { type: 'string' },
                  subtasks: DESIGN_SCHEMA.properties.items.items.properties.subtasks,
                },
              },
            },
          },
        },
        ...modelAndEffort('design', MODELS, EFFORTS),
      }
    )
    const byTitle = new Map(
      (split && Array.isArray(split.items) ? split.items : []).map((s) => [String(s.title || '').trim(), s.subtasks])
    )
    big.forEach((item) => {
      const subs = byTitle.get(String(item.title || '').trim())
      if (Array.isArray(subs) && subs.length > 0 && subs.every(isUsableSubtask)) {
        item.subtasks = subs
      } else {
        log(`分割結果が使えないため、そのままの粒度で実装します: ${item.title}`)
      }
    })
  }
}

phase('実装')

/** 2つの作業項目が対象ファイルを共有するか(共有があれば同時実行できない)。 */
function filesOverlap(filesA, filesB) {
  const setA = new Set(filesA)
  return filesB.some((f) => setA.has(f))
}

/** subtask が実装エージェントへそのまま渡せる形か(空文字・空配列はスキーマを通っても弾く)。 */
function isUsableSubtask(s) {
  if (!s || typeof s.title !== 'string' || s.title.trim().length < 4) return false
  if (typeof s.description !== 'string' || s.description.trim().length < 8) return false
  if (!Array.isArray(s.files) || s.files.length === 0) return false
  return s.files.every((f) => typeof f === 'string' && f.trim().length > 0)
}

/**
 * 設計の作業項目を実装フェーズの作業単位へ展開する。subtasks を持つ項目は親の代わりに
 * subtask を単位にする(1 体のターン数が伸びるほどコンテキストは二乗で膨らむため)。
 *
 * complexity は親から引き継ぐ。分割は粒度の調整であってモデル振り分けの方針変更ではないので、
 * 親の採点をそのまま各単位へ適用する。使えない subtask が 1 つでもあれば作業の取りこぼしを
 * 避けるため親項目を分割せずそのまま使う。
 *
 * @param items 設計エージェントが返した作業項目の配列。
 * @returns 実装順を保った作業単位の配列({title, description, files, complexity})。
 */
function expandWorkItems(items) {
  const expanded = []
  for (const item of items) {
    const subs = Array.isArray(item.subtasks) ? item.subtasks : []
    if (subs.length === 0 || !subs.every(isUsableSubtask)) {
      if (subs.length > 0) log(`subtasks が不正なため分割せずに実装します: ${item.title}`)
      expanded.push(item)
      continue
    }
    for (const s of subs) {
      expanded.push({
        title: `${item.title} / ${s.title}`,
        description: s.description,
        files: s.files,
        complexity: item.complexity,
      })
    }
  }
  return expanded
}

const workItems = expandWorkItems(design.items)
if (workItems.length !== design.items.length) {
  log(`subtasks 展開: ${design.items.length} 作業項目 → ${workItems.length} 作業単位`)
}

// workItems は実装順(依存順)のリスト。直前までのバッチとファイルが重ならない限り
// 同じバッチにまとめて並列実行し、重なった時点で新しいバッチに区切る。バッチ内は並列、
// バッチ間は逐次(前のバッチが完了してから次を開始)にすることで、ファイル競合を避けつつ
// 元の実装順序(依存関係の前提)も保つ。
const batches = []
for (const item of workItems) {
  const currentBatch = batches[batches.length - 1]
  const conflicts =
    currentBatch && currentBatch.some((existing) => filesOverlap(existing.files, item.files))
  if (currentBatch && !conflicts) {
    currentBatch.push(item)
  } else {
    batches.push([item])
  }
}
log(
  `実装バッチ: ${batches.length}件(${batches.map((b) => b.length).join('+')} 作業項目。` +
    '同一バッチ内は並列実行)'
)

// 完了報告に「変更したファイル一覧」を必ず含めさせる(後段で git 差分と機械照合する)
const IMPLEMENT_SCHEMA = {
  type: 'object',
  required: ['changedFiles', 'report'],
  properties: {
    changedFiles: {
      type: 'array',
      items: { type: 'string' },
      description: '実際に変更・新規作成したファイル(リポジトリルートからの相対パス)',
    },
    report: {
      type: 'string',
      description: '変更したファイルごとに何をしたか、判断に迷った点と選んだ理由(推測は「推測:」と根拠)',
    },
    status: {
      type: 'string',
      enum: ['done', 'partial'],
      description: 'done=作業項目を完了した / partial=ツール呼び出しの上限で切り上げた(remaining 必須。続きは別の担当が引き継ぐ)',
    },
    remaining: {
      type: 'string',
      description: 'partial のとき、残作業を次の担当がそのまま着手できる粒度で(何が済んで何が残っているか)',
    },
  },
}

// 実装エージェント間で不変のプロンプト前置き。可変部(作業項目)は必ず末尾へ置く —
// 兄弟エージェントの前方一致キャッシュに載せるため。
// codeMap を渡すのは、探索フェーズの成果が設計にしか渡っておらず、実装エージェントが全員
// 独立にコードベースを調べ直していたため(実測では同一ファイルを 190 体中 121 体が読んでいた)。
// ただし調査結果が誤っていた場合に全員がそれを共有したまま突き進むのを避けるため、再調査は禁じない
const IMPLEMENT_BODY = `\n末尾の「## 作業項目」を実装してください。テストが必要な変更は同時に書くこと。実装後、実際に変更・新規作成したファイルをリポジトリルートからの相対パスで changedFiles に列挙し、実装内容と判断に迷った点を report で報告してください。実際に編集していないファイルを changedFiles に含めてはいけません。作業項目の対象ファイルに無いファイルを新規作成する必要が生じたときは、並列で走る他の作業項目が同じファイルを作っている可能性があるため、作成前に存在を確認し、既に存在すればその内容を正として合わせること(上書きしない)。完了したら status: "done"、切り上げたら status: "partial" とすること。\n\n## 現状調査(探索フェーズの成果。**再調査は禁止しない — 必要に応じて裏取りすること**)\n${codeMap}\n\n## 実装方針(全体)\n${design.summary}\n\n## 要件(参照用)\n${reqPath ? `原文は ${target}。作業項目の完了条件だけで判断できないときに限り、該当する節を Read で確かめること(全文を読み直さない)。` : target}${selfCheckInstruction}`
const IMPLEMENT_PREFIX = IMPLEMENT_RULES + IMPLEMENT_BODY
const IMPLEMENT_PREFIX_UNCAPPED = IMPLEMENT_RULES_UNCAPPED + IMPLEMENT_BODY

/**
 * 作業単位 1 件を実装エージェント 1 体に割り当てて実行する。
 *
 * @param item 設計フェーズが生成した作業項目(subtasks があれば展開後の作業単位)。
 * @param labelPrefix ログ用のラベル接頭辞('実装' または '再実装')。
 * @param handoff 前の担当が partial で切り上げたときの引き継ぎ({changedFiles, report, remaining})。無ければ null。
 * @param finisher 最後の担当か(ソフト上限を外し、切り上げずに完了させる)。
 * @returns 成功時は {item, complexity, model, changedFiles, report, status, remaining}、失敗時は null。
 */
function runImplementItem(item, labelPrefix, handoff, finisher) {
  const modelOpts = modelAndEffort(implementRoleFor(item.complexity), MODELS, EFFORTS)
  const model = modelOpts.model
  log(`${labelPrefix}: ${item.title} (複雑度 ${item.complexity} → ${model}${modelOpts.effort ? `/${modelOpts.effort}` : ''})`)
  const handoffBlock = handoff
    ? `\n\n## 引き継ぎ(前の担当がツール呼び出しの上限で切り上げた。ここから続けること。済んだ作業をやり直さない)\n変更済みファイル: ${handoff.changedFiles.length > 0 ? handoff.changedFiles.join(', ') : '(なし)'}\n前の担当の報告: ${handoff.report}\n残作業: ${handoff.remaining}${
        finisher
          ? '\n\nあなたはこの作業項目の最後の担当。ツール呼び出しの目安は適用しないので、切り上げずに完了(status: "done")まで進めること'
          : ''
      }`
    : ''
  return trackedAgent(
    `${finisher ? IMPLEMENT_PREFIX_UNCAPPED : IMPLEMENT_PREFIX}\n\n## 作業項目\n${item.title}\n${item.description}\n対象ファイル目安: ${item.files.join(', ')}${handoffBlock}`,
    { label: `${labelPrefix}: ${item.title}`, role: 'implement', phase: '実装', schema: IMPLEMENT_SCHEMA, ...modelOpts }
  ).then(
    (r) =>
      r && {
        item: item.title,
        complexity: item.complexity,
        model,
        changedFiles: r.changedFiles || [],
        report: r.report,
        status: r.status === 'partial' ? 'partial' : 'done',
        remaining: typeof r.remaining === 'string' ? r.remaining : '',
      }
  )
}

/**
 * 作業単位 1 件を、引き継ぎを挟みながら完了まで実装する。partial で切り上げた体の報告・残作業を
 * 次の体へ渡す(床からの再スタートなので、二次項が 1/k になる。fix の分割と同じ形)。
 * 最後の引き継ぎ先(k === maxAgentContinuations)はソフト上限を外した finisher で、切り上げずに完走させる。
 * finisher までもが partial を返した場合だけ、そこまでの変更を結果として返しつつ incomplete を立てる
 * (呼び出し側で failedItems へ。Gate 0.5 が拾う)。途中の体が null(失敗)を返したら null
 * (呼び出し側の 1 回リトライへ)。maxAgentContinuations が 0 なら最初の体が finisher(= 上限なし)。
 */
async function implementWithHandoff(item, labelPrefix) {
  const changed = new Set()
  const reports = []
  let handoff = null
  for (let k = 0; ; k++) {
    const finisher = k >= maxAgentContinuations
    const r = await runImplementItem(item, k === 0 ? labelPrefix : `${labelPrefix}(引き継ぎ ${k})`, handoff, finisher)
    if (!r) return null
    r.changedFiles.forEach((f) => changed.add(f))
    reports.push(r.report)
    const merged = { ...r, changedFiles: [...changed], report: reports.join('\n---\n'), continuations: k }
    if (r.status !== 'partial') return merged
    if (finisher) {
      log(`最後の担当も未完のまま切り上げました: ${item.title} — 残作業: ${r.remaining.slice(0, 120)}`)
      return { ...merged, incomplete: true }
    }
    log(`引き継ぎ(${k + 1}/${maxAgentContinuations}): ${item.title} — 残作業: ${r.remaining.slice(0, 120)}`)
    handoff = { changedFiles: [...changed], report: r.report, remaining: r.remaining }
  }
}

// 失敗項目はサイレントスキップせず 1 回リトライし、それでも失敗した項目は failedItems に記録する。
// リトライは同一バッチ内で行う(後続バッチが依存する可能性があるため、次バッチ開始前に解消を試みる)
const results = []
const failedItems = []
for (const batch of batches) {
  const batchResults = await parallel(batch.map((item) => () => implementWithHandoff(item, '実装')))
  const retryTargets = batch.filter((item, idx) => batchResults[idx] === null)
  results.push(...batchResults.filter(Boolean))
  if (retryTargets.length > 0) {
    log(`実装失敗: ${retryTargets.length} 件を 1 回リトライします`)
    const retryResults = await parallel(
      retryTargets.map((item) => () => implementWithHandoff(item, '再実装'))
    )
    retryTargets.forEach((item, idx) => {
      if (retryResults[idx] === null) {
        log(`実装失敗(リトライ後): ${item.title}(failedItems に記録)`)
        failedItems.push(item.title)
      }
    })
    results.push(...retryResults.filter(Boolean))
  }
}
// 引き継ぎ上限に達しても未完の作業単位は failedItems へ。残作業の要約を添えて、run-release の
// Gate 0.5 リトライ(scope に failedItems が入る)がそこから着手できるようにする
results
  .filter((r) => r.incomplete)
  .forEach((r) => failedItems.push(`${r.item}(引き継ぎ上限で未完: ${String(r.remaining || '').slice(0, 200)})`))

phase('照合')

/** ファイルパスの表記ゆれ(先頭の ./ や余分な空白)を照合用に正規化する。 */
function normalizePath(p) {
  return p.trim().replace(/^\.\//, '')
}

// 実装エージェントが報告したファイルと実際の git 差分を機械照合する(run-release Gate 0.5 の入力)。
// 実差分 = HEAD 差分 ∪ 未追跡ファイル ∪ 実行開始時 HEAD(auditBaseRef) 起点差分。
// 新規作成ファイルは git diff に現れないため未追跡ファイル一覧を含め、指示に反してエージェントが
// commit してしまった変更は HEAD 差分から消えるため開始時 HEAD 起点差分で拾う。基準を
// merge-base(baseBranch) にしない理由: no-pr 停止後の同一ブランチ再実行で前回実行のコミットまで
// 実差分に混入し、今回触っていないファイルの捏造報告が検証済み扱いになってしまうため
const reportedRaw = results.flatMap((r) => r.changedFiles)
const diffReport = await trackedAgent(
  TOOL_POLICY +
    '読み取り専用の差分照合です。リポジトリの状態を変更するコマンドは実行禁止。カレントリポジトリで以下を実行してください:\n' +
    '1. `git diff --name-only HEAD` と `git ls-files --others --exclude-standard` を実行する\n' +
    (auditBaseRef
      ? `2. \`git diff --name-only ${auditBaseRef}\` も実行する(成功したら auditDiffIncluded: true とする。このコマンドが失敗した場合のみスキップし、auditDiffIncluded: false とする)\n`
      : '') +
    '3. 実行した全コマンドの出力ファイルパスを結合・重複除去した配列を files として返す。出力の加工・省略・推測は禁止。\n' +
    '4. `git rev-parse --show-toplevel` の出力(リポジトリルートの絶対パス)を repoRoot として返す。',
  {
    label: '差分照合',
    role: 'audit',
    phase: '照合',
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: { type: 'array', items: { type: 'string' } },
        auditDiffIncluded: { type: 'boolean' },
        repoRoot: { type: 'string' },
      },
    },
    ...modelAndEffort('bootstrap', MODELS, EFFORTS),
  }
)
if (auditBaseRef && diffReport && diffReport.auditDiffIncluded !== true) {
  log('注: 開始時 HEAD 起点の差分が取得できなかったため、HEAD 差分と未追跡ファイルのみで照合します')
}

// 絶対パス報告の吸収: プロンプト・スキーマで相対パスを要求しても絶対パスで報告される事故が実際に
// 起きたため、差分照合エージェントが返した repoRoot を接頭辞として機械的に剥がす。repoRoot が
// 取れない場合は従来どおり(絶対パス報告は unverified = 安全側)。正規化は報告側・実差分側の両方へ
// 対称に適用する(git 出力は相対パスのため実質 no-op)
const repoRoot =
  diffReport && typeof diffReport.repoRoot === 'string'
    ? diffReport.repoRoot.trim().replace(/\/+$/, '')
    : null

/** repoRoot 接頭辞つきの絶対パスをリポジトリルート相対へ剥がす(それ以外は素通し)。 */
function stripRepoRoot(p) {
  return repoRoot && p.startsWith(repoRoot + '/') ? p.slice(repoRoot.length + 1) : p
}

/** 照合用の最終正規化: 前後空白 → repoRoot 接頭辞剥がし → 先頭 ./ 除去。 */
function normalizeForAudit(p) {
  return normalizePath(stripRepoRoot(p.trim()))
}

const reported = [...new Set(reportedRaw.map(normalizeForAudit))]
const actualDiff = Array.isArray(diffReport?.files) ? diffReport.files.map(normalizeForAudit) : []
const actualSet = new Set(actualDiff)
// 報告されたのに実差分に現れないファイル = 捏造疑い。差分取得自体に失敗した場合は
// 検証できないため、安全側に倒して報告された全ファイルを unverified とする
const unverified = diffReport ? reported.filter((f) => !actualSet.has(f)) : reported
if (!diffReport) {
  log('差分照合エージェントが失敗したため、報告された全ファイルを unverified 扱いにします')
} else if (unverified.length > 0) {
  log(`照合不一致: ${unverified.length} 件のファイルが報告されたが実差分に現れません(捏造疑い)`)
} else {
  log('照合完了: 報告されたファイルはすべて実差分に存在します')
}

// skipVerify 指定時は最終検証を省略する(run-release から起動される場合、workflow() の
// ネストは 1 段までのため release-check は run-release 側が直接実行する)
let verification = null
if (input.skipVerify !== true) {
  phase('検証')
  verification = await workflow('release-check', { config })
}

return {
  design: design.summary,
  implemented: results.map((r) => r.item),
  failedItems,
  // auditOk: 差分照合が取れたか。false のとき actualDiff は空配列で、実差分を表していない
  fileAudit: { reported, actualDiff, unverified, auditOk: Boolean(diffReport) },
  reports: results,
  // 並列バッチの構成(作業単位の title。reports[].item と同じ文字列)。run-release が「同一バッチ内で
  // 複数の作業単位が同じファイルを書いた衝突候補」を検出するのに使う。失敗した作業単位も含む
  batches: batches.map((b) => b.map((i) => i.title)),
  agentsUsed,
  verification,
  next:
    failedItems.length > 0
      ? `実装に失敗した作業項目が ${failedItems.length} 件あります。failedItems を確認・対応後、review-changes ワークフローで差分レビューを実施してください`
      : 'review-changes ワークフローで差分レビューを実施してください',
}
