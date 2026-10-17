export const meta = {
  name: 'release-check',
  description: 'リリース前検査: 検証コマンドを並列実行して失敗を集約報告',
  whenToUse: 'コミット・リリース前の最終検査。修正はせず検査結果の報告のみ行う',
  phases: [
    { title: '設定読み込み', detail: 'workflow.config.json の取得と検証', model: 'haiku' },
    { title: '検査', detail: '検査コマンドを並列実行', model: 'haiku' },
  ],
}

// モデル使い分けの方針: コマンド実行と結果報告のみの軽量タスク = config.models.check(既定 haiku。modelAndEffort 参照)

// args は JSON 文字列で渡ってくる場合があるためパースする
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    throw new Error('args を JSON として解釈できません')
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

// 検査エージェントは「コマンドを実行する」のが仕事なので、方針を読んで実行を躊躇されると本末転倒になる。
// TOOL_POLICY 本体は 4 ファイル共通のキャッシュ前置きなので書き換えず、直後に例外の明示だけを足す
const CHECK_TOOL_POLICY =
  TOOL_POLICY + '検査コマンドの実行はまさにこの例外にあたる。指定されたコマンドは必ず bash で実行すること。\n\n'

// 起動したエージェント数を数える薄いラッパ。呼び出し時点で加算するため、parallel に渡した
// サムの中から呼ばれても正しく数えられる。役割マーカー `[crw:role=<役割>]` をプロンプト末尾(可変部)へ
// 付ける — engine/tools/usage-report.py が transcript から工程別の消費を集計するための目印
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

// ---- config ブートストラップ (全エンジン共通パターン) ----
phase('設定読み込み')
let config = input.config
if (!config) {
  const loaded = await countedAgent(
    TOOL_POLICY +
    'カレントリポジトリの .claude/workflow.config.json を読んでください。存在すれば {exists: true, config: <ファイル内容そのまま>} を、存在しなければ {exists: false} を返すこと。内容の要約・省略・補完は禁止。',
    {
      label: 'config読込',
      role: 'config',
      phase: '設定読み込み',
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

// 検査コマンドは config.checks (プロジェクト固有値) からのみ取得する
const CHECKS = config.checks
if (!Array.isArray(CHECKS) || CHECKS.length === 0) {
  throw new Error('config.checks が未定義または空です。workflow.config.json に検査コマンドを定義してください')
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

const CHECK_SCHEMA = {
  type: 'object',
  required: ['check', 'passed', 'detail', 'failedItems'],
  properties: {
    check: { type: 'string' },
    passed: { type: 'boolean' },
    detail: { type: 'string', description: '成功時は一言、失敗時はエラーの要点(該当箇所つき)。表示専用の自由文' },
    failedItems: {
      type: 'array',
      items: { type: 'string' },
      description:
        '失敗箇所の構造化リスト (file:line・テスト名・エラーコード等の文字列)。成功時は空配列。収束判定の入力になるため失敗時は必ず列挙すること',
    },
  },
}

phase('検査')
const MODELS = config.models || {}
const EFFORTS = config.efforts || {}
const FINGERPRINT_SCHEMA = {
  ...CHECK_SCHEMA,
  properties: {
    ...CHECK_SCHEMA.properties,
    treeFingerprint: { type: 'string', description: '検査コマンドの前に実行した指紋コマンドの出力(40 桁の 16 進)' },
  },
}
const results = await parallel(
  CHECKS.map((c, i) => {
    const where =
      c.cwd && c.cwd !== '.' ? `カレント作業ディレクトリ配下の ${c.cwd} で` : 'カレント作業ディレクトリ(リポジトリルート)で'
    return () =>
      countedAgent(
        `${CHECK_TOOL_POLICY}${where} \`${c.cmd}\` を実行し、結果を報告してください。失敗しても修正せず、check="${c.key}" として成否のみ返すこと。` +
          `成否は必ずコマンドの exit code で判定すること (exit 0=成功。警告が出ていても exit 0 なら成功とする。自分の品質判断を混ぜない)。` +
          // パイプの exit code は最後のコマンド(head 等)のものになり、失敗した検査が成功に見える
          `exit code を正しく取るため、コマンドはパイプ(| head 等)に繋がず、\`${c.cmd}; echo "CRW_EXIT=$?"\` の形で実行し、出力の CRW_EXIT の値で判定すること。` +
          `出力が長いと予想される場合は、パイプで絞る代わりに \`${c.cmd} > "\${TMPDIR:-/tmp}/crw-check-${String(c.key).replace(/[^A-Za-z0-9_-]/g, '_')}.log" 2>&1; echo "CRW_EXIT=$?"\` とし、ログは失敗時に必要な範囲だけ Read すること。` +
          `ビルドやテストで 2 分を超えそうなときは、Bash ツールの timeout に 600000 を指定すること。` +
          `失敗時は failedItems に失敗箇所 (ファイル:行・テスト名・エラーコード等) を文字列配列で必ず列挙し、detail にエラーの要点を書くこと。` +
          `成功時は failedItems を空配列にすること。コマンド自体が実行できない場合 (コマンド不存在・起動失敗等) も passed=false とし、failedItems にその旨を含めること。` +
          // 指紋は 1 体目だけに取らせる(可変部なので末尾に置く)
          (i === 0
            ? `\n\n検査コマンドを実行する**前に**、次のコマンドを一字一句そのまま実行し、出力を treeFingerprint として返すこと(作業ツリーの内容の指紋。ファイルは変わらない):\n\`${TREE_FINGERPRINT_CMD}\``
            : ''),
        {
          label: c.key,
          role: 'check',
          phase: '検査',
          schema: i === 0 ? FINGERPRINT_SCHEMA : CHECK_SCHEMA,
          ...modelAndEffort('check', MODELS, EFFORTS),
        }
      )
  })
)

// 偽グリーン防止: エージェントが null を返した検査 (実行失敗・スキップ) は結果を捨てず failed として計上する。
// CHECKS 側を基準に走査するため、結果の欠落がそのまま失敗に現れる
const checks = CHECKS.map((c, i) => {
  const r = Array.isArray(results) ? results[i] : null
  if (!r) {
    return {
      check: c.key,
      passed: false,
      detail: '検査エージェントが結果を返しませんでした (実行失敗またはスキップ)',
      failedItems: [`agent-failure: ${c.key} の検査結果が得られませんでした`],
    }
  }
  return {
    // 名前はエージェントの申告ではなく config の key を使う(収束判定の署名と起票の対応がずれないように)
    check: c.key,
    passed: r.passed === true,
    detail: r.detail ?? '',
    failedItems: Array.isArray(r.failedItems)
      ? r.failedItems
      : r.passed === true
        ? []
        : [`schema-violation: ${c.key} の failedItems が未報告です`],
  }
})

// 結果数 ≠ 検査数は検査基盤の異常なので、個別成否によらず passed=false にする
const countMismatch = !Array.isArray(results) || results.length !== CHECKS.length
if (countMismatch) {
  log(`検査結果数 (${Array.isArray(results) ? results.length : 0}) が検査数 (${CHECKS.length}) と一致しません — passed=false として扱います`)
}

const failed = checks.filter(c => !c.passed)
log(failed.length === 0 ? (countMismatch ? '結果数不一致のため失敗扱い' : '全検査パス') : `${failed.length} 件の検査が失敗`)

const fp = Array.isArray(results) && results[0] && typeof results[0].treeFingerprint === 'string' ? results[0].treeFingerprint.trim() : ''

return {
  passed: !countMismatch && failed.length === 0,
  results: checks,
  failed,
  agentsUsed,
  // 検査の直前の作業ツリーの指紋。形式が崩れていれば null(run-release は最終検査を省かない側に倒す)
  treeFingerprint: /^[0-9a-f]{40}$/.test(fp) ? fp : null,
}
