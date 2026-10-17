export const meta = {
  name: 'record-known-issues',
  description: 'レビュー・検査の未対応所見を既知課題ドキュメントへ逐次起票する',
  whenToUse:
    'run-release の triage 工程、または手動で未対応所見をバックログ化するとき。args: {config, findings: [{source: "review"|"check", dimension?, checkKey?, severity, title, file?, detail}]}',
  phases: [
    { title: '設定読み込み', detail: 'workflow.config.json の取得と検証' },
    { title: '起票', detail: '単一エージェントが既知課題ドキュメントへ逐次採番・追記' },
  ],
}

// モデル使い分けの方針: 既知課題ドキュメントの読解・採番・追記 = 文書編集タスクなので docSync モデルを流用。
//
// 採番の一貫性を保つため、起票は単一エージェントによる逐次処理とする(並列採番による ID 衝突の禁止)。
// 起票日は Workflow スクリプト内で Date が使えないため、エージェントが bash の date コマンドで取得する。

// args は JSON 文字列で渡ってくる場合があるためパースする(失敗は握り潰さず明示エラー)
let input = args
if (typeof input === 'string') {
  try {
    input = JSON.parse(input)
  } catch (e) {
    throw new Error(`record-known-issues の args を JSON としてパースできません: ${e.message}`)
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

// 起動したエージェント数を数える薄いラッパ。所見ゼロで早期 return する経路でも同じ値を返せる。
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

phase('設定読み込み')

// config ブートストラップ: args.config を優先し、未指定時は .claude/workflow.config.json をエージェント経由で読む
let config = input.config
if (!config) {
  const loaded = await countedAgent(
    TOOL_POLICY +
    'カレントリポジトリの .claude/workflow.config.json を読んでください。存在すれば {exists: true, config: <ファイル内容そのまま>} を、無ければ {exists: false} を返すこと。内容の要約・省略・補完は禁止。',
    {
      label: 'config-bootstrap',
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

const knownIssues = config.knownIssues
if (!knownIssues || typeof knownIssues.path !== 'string' || knownIssues.path.length === 0) {
  throw new Error('config.knownIssues.path が未定義です。workflow.config.json に knownIssues 節を定義してください')
}
const issuesPath = knownIssues.path
const categoryMap = knownIssues.categoryMap && typeof knownIssues.categoryMap === 'object' ? knownIssues.categoryMap : {}
const defaultCategory = typeof knownIssues.defaultCategory === 'string' ? knownIssues.defaultCategory : 'N'

// 所見の検証と正規化。カテゴリ接頭辞の決定は決定的な処理なのでスクリプト側で行う
// (review 由来 → dimension、check 由来 → "check:<checkKey>" を categoryMap で引き、マップ外は defaultCategory)
const rawFindings = input.findings == null ? [] : input.findings
if (!Array.isArray(rawFindings)) {
  throw new Error('args.findings は配列で渡してください')
}

if (rawFindings.length === 0) {
  log('起票対象の所見がありません — 何も変更せず終了します')
  return { filed: [], appendedTo: [], resolvedLogProposal: null, agentsUsed }
}

const findings = rawFindings.map((f, i) => {
  const mapKey = f.source === 'check' ? `check:${f.checkKey ?? ''}` : (f.dimension ?? '')
  const category = Object.prototype.hasOwnProperty.call(categoryMap, mapKey) ? categoryMap[mapKey] : defaultCategory
  return {
    index: i + 1,
    category,
    source: f.source === 'check' ? `check:${f.checkKey ?? '(不明)'}` : `review:${f.dimension ?? '(不明)'}`,
    severity: f.severity ?? '(未指定)',
    title: f.title ?? '(タイトル不明)',
    file: f.file ?? null,
    detail: f.detail ?? '',
  }
})

phase('起票')

const RESULT_SCHEMA = {
  type: 'object',
  required: ['filed', 'appendedTo', 'resolvedLogProposal'],
  properties: {
    filed: {
      type: 'array',
      description: '新規起票した項目',
      items: {
        type: 'object',
        required: ['id', 'title'],
        properties: {
          id: { type: 'string', description: '採番した ID (例: B9)' },
          title: { type: 'string' },
          text: {
            type: 'string',
            description: 'この項目として書き込んだ Markdown(見出しから最後の bullet まで。1500 字を超えるなら 1500 字で切る)',
          },
        },
      },
    },
    appendedTo: {
      type: 'array',
      description: '重複照合により既存項目へ追記した先の項目',
      items: {
        type: 'object',
        required: ['id', 'title'],
        properties: {
          id: { type: 'string', description: '追記先の既存 ID' },
          title: { type: 'string', description: '追記先の既存タイトル' },
          text: { type: 'string', description: '追記した bullet の行(500 字を超えるなら 500 字で切る)' },
        },
      },
    },
    resolvedLogProposal: {
      type: ['string', 'null'],
      description: '解決済みログへの移動提案 (unified diff 形式のテキスト)。提案が無ければ null',
    },
  },
}

const MODELS = config.models || {}
const EFFORTS = config.efforts || {}
const result = await countedAgent(
  `${TOOL_POLICY}${WRITING_POLICY}既知課題ドキュメント ${issuesPath} に、以下の所見一覧を起票してください。作業はカレント作業ディレクトリ(=リポジトリルート)で行い、編集してよいファイルは ${issuesPath} のみです。

## 手順(必ずこの順で、所見を1件ずつ逐次処理すること。並列化・一括採番は禁止)

1. bash で \`date '+%Y-%m-%d'\` を実行し、結果を起票日として使う。
2. ${issuesPath} を全文読む。「未解決（バックログ）」と「解決済みログ」の2部構成になっている。既存項目の記法(見出し・bullet の書き方)を観察し、以降の追記はそれに合わせること。
3. 所見一覧を index 順に1件ずつ処理する:
   a. **重複照合**: 未解決セクションの既存項目(この実行で自分が直前に起票した項目も含む)に、同一ファイル・同一現象を指す項目があれば、新規起票せずその項目の bullet 末尾に追記するに留める(例: \`- 追記(<起票日>, severity: <severity>, <source> 由来): <今回の所見の要点>\`)。追記した先は appendedTo に {id, title} で記録する。場所が同じでも現象が別なら重複ではない。
   b. **新規起票**: 重複が無ければ、所見に指定されたカテゴリ接頭辞(category)の既存 ID を「未解決（バックログ）」と「解決済みログ」の**両セクションから**走査し(同一カテゴリの ID が両セクションに分散しているため)、最大番号 + 1 を新 ID とする。この実行内で自分が直前に採番した ID も走査対象に含め、連番を衝突させないこと。
4. 新規起票は「未解決（バックログ）」セクションの末尾(「## 解決済みログ」見出しの直前)に、次の形式で追記する:

\`\`\`markdown
### <category><番号>. <タイトル>

- severity: <severity>（<source> 由来、起票日: <起票日>）
- 場所: <file>（file が null の場合は「該当なし」とし、detail から関連ファイルが分かれば「関連: ...」を添える）
- 現象: <detail を基にした事実の記述。何が起きるかを、実測や再現条件(実行したコマンド・入力・対象のファイルや関数)とあわせて書く>
- 対応方針: <detail から対応案が読み取れればそれを書く。読み取れなければ「未検討、要壁打ち」>
\`\`\`

   起票した項目は filed に {id, title, text} で記録する(text は書き込んだ Markdown そのもの。書いた後の機械検査に使う)。
5. **解決済みログへの移動提案**: 照合の過程で、既存の未解決項目がすでに解決済みと確認できる明確な根拠(コード上の実装済み証跡など)を得た場合のみ、その項目を解決済みログの表へ移す変更案を unified diff 形式のテキストとして resolvedLogProposal に返す。**移動をファイルへ反映することは絶対に禁止**(提案のみ)。該当が無ければ null を返す。

## 制約

- ${issuesPath} 以外のファイルを変更しないこと
- 既存項目の削除・並べ替え・書き換えをしないこと(重複照合による bullet 追記と、未解決セクション末尾への新規追記のみ)
- 所見の内容を要約で歪めないこと(detail の事実関係を保つ)

## 所見一覧

${JSON.stringify(findings, null, 2)}`,
  {
    label: 'known-issues起票',
    role: 'triage',
    phase: '起票',
    schema: RESULT_SCHEMA,
    ...modelAndEffort('docSync', MODELS, EFFORTS),
  }
)

if (!result) {
  throw new Error(
    `known-issues 起票エージェントが結果を返しませんでした。${issuesPath} の状態を確認してから再実行してください`
  )
}

// 戻り値契約 {filed, appendedTo, resolvedLogProposal} に正規化する
const filed = Array.isArray(result.filed)
  ? result.filed.map(e => ({ id: String(e?.id ?? ''), title: String(e?.title ?? '') }))
  : []
const appendedTo = Array.isArray(result.appendedTo)
  ? result.appendedTo.map(e => ({ id: String(e?.id ?? ''), title: String(e?.title ?? '') }))
  : []
const resolvedLogProposal =
  typeof result.resolvedLogProposal === 'string' && result.resolvedLogProposal.trim().length > 0
    ? result.resolvedLogProposal
    : null

// 書き込んだ本文を機械検査し(lintProse)、違反があれば該当する項目の該当行だけを直す体を 1 回だけ起動する。
// 書き直させると重複起票や ID の振り直しが起きるので、追加・削除・採番・並べ替えは禁じる
const texts = [
  ...(Array.isArray(result.filed) ? result.filed : []).map(e => ({ id: String(e?.id ?? ''), text: e?.text, kind: 'known-issue' })),
  ...(Array.isArray(result.appendedTo) ? result.appendedTo : []).map(e => ({ id: String(e?.id ?? ''), text: e?.text, kind: 'title' })),
]
// 同じ run で起票した ID に追記すると filed と appendedTo に同じ ID が並ぶ。本文をつないで 1 件にする(追記した行も検査する)
const merged = new Map()
texts.forEach(t => {
  const prev = merged.get(t.id)
  if (!prev) merged.set(t.id, { ...t })
  else if (typeof t.text === 'string') prev.text = typeof prev.text === 'string' ? `${prev.text}\n${t.text}` : t.text
})
texts.splice(0, texts.length, ...merged.values())
const unlinted = texts.filter(t => typeof t.text !== 'string' || !t.text.trim()).length
const lintAll = list => list.map(t => ({ ...t, violations: typeof t.text === 'string' ? lintProse(t.text, t.kind) : [] })).filter(t => t.violations.length > 0)
let flagged = lintAll(texts)
if (flagged.length > 0) {
  log(`起票した本文の機械検査で ${flagged.length} 項目に違反 — 該当行だけを直させます`)
  const fix = await countedAgent(
    `${TOOL_POLICY}${WRITING_POLICY}既知課題ドキュメント ${issuesPath} で、いま起票・追記した次の項目の文章に問題がある。**該当する項目の該当する行だけを**直すこと。` +
      '項目の追加・削除・ID の振り直し・並べ替え、ほかの項目への変更は一切しないこと。直したあとの項目の Markdown を fixed に {id, text} で返すこと。\n\n' +
      flagged.map(t => `### ${t.id}\n${t.violations.map(v => `- ${v.hint}(該当: ${v.excerpt})`).join('\n')}`).join('\n\n'),
    {
      label: 'known-issues起票(文章の手直し)',
      role: 'triage',
      phase: '起票',
      schema: {
        type: 'object',
        required: ['fixed'],
        properties: {
          fixed: {
            type: 'array',
            items: { type: 'object', required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } },
          },
        },
      },
      ...modelAndEffort('docSync', MODELS, EFFORTS),
    }
  )
  const fixedById = new Map((fix && Array.isArray(fix.fixed) ? fix.fixed : []).filter(x => x && typeof x.text === 'string').map(x => [String(x.id), x.text]))
  flagged = lintAll(flagged.map(t => (fixedById.has(t.id) ? { ...t, text: fixedById.get(t.id) } : t)))
}
const proseViolations = flagged.reduce((n, t) => n + t.violations.length, 0)
if (proseViolations > 0) log(`起票した本文の機械検査: 手直し後も ${proseViolations} 件の違反が残っています`)

log(
  `新規起票: ${filed.length} 件 / 既存へ追記: ${appendedTo.length} 件 / 解決済みログ移動提案: ${resolvedLogProposal ? 'あり' : 'なし'}`
)

return { filed, appendedTo, resolvedLogProposal, agentsUsed, proseViolations, unlinted }
