---
description: リリース自動パイプライン(run-release)の起動。workflow.config.json を読込・スキーマ検証したうえで scriptPath 指定で起動し、完了・停止時の戻り値をユーザーに報告する
---

# /run-release — リリース自動パイプラインの起動

確定済み要件(config の `requirementsPath` が指す requirements.md)を入力に、実装→検査ループ→レビューループ→known-issues 起票→doc 同期→論理単位コミット→PR 作成までを統括する `run-release` ワークフローを起動する。

引数: `$ARGUMENTS`(対象リリース識別子。例: `release-1-login-form`。省略時は現在のブランチ名をリリース識別子とみなす。`autoApprove=false` を付けると config の値に関わらずコミット直前で停止する)

## 進め方

1. **config の読込**: `.claude/workflow.config.json` を Read する。ファイルが無い・読めない場合は「**`.claude/workflow.config.json` がありません**」と明示し、**起動しない**。値を推測で補完して起動することを禁止する。`.claude/config.schema.json` を参照して config を作成するよう案内して終了する
2. **スキーマ整合の確認**: `.claude/config.schema.json` を Read し、手順1で読み込んだ config が構造的に整合するかを確認する:
   - スキーマの `required` に列挙されたトップレベルキーがすべて存在する
   - `configVersion` が `1`(エンジン要求版)である
   - `checks`・`reviewDimensions` が非空配列で、各要素が必須フィールド(`key`/`cmd`/`cwd`、`key`/`prompt`)を持つ
   - `automation` に各上限値と `severityGate` が揃っている
   - 違反があれば違反箇所を列挙して**起動しない**(スキーマ検証ツールが利用可能な環境ならそれで検証してよい。無ければ上記の構造照合で足りる)
3. **リリース識別子の決定**: `$ARGUMENTS` で指定があればそれを、無ければ現在のブランチ名(`git branch --show-current`)をリリース識別子とする。現在ブランチが config の `baseBranch` と同一の場合は run-release の Gate 0 で拒否されるため起動せず、リリースブランチへの切替(または `/refine-requirements` からのやり直し)を案内する
4. **起動**: 以下で起動する。`config` には手順1で読み込んだファイル内容を**そのまま**渡す(要約・省略・補完をしない):

   ```
   Workflow({scriptPath: ".claude/workflows/run-release.js", args: {release: "<リリース識別子>", config: <手順1で読み込んだ config>, autoApprove: <config.automation.autoApprove>}})
   ```

   - 起動は常に **scriptPath 指定**とする。name 指定(`{name: "run-release"}`)は、新規追加されたワークフローが同一セッション内で name 解決されない既知の罠があるため使わない
   - `$ARGUMENTS` に `autoApprove=false` の指定があれば、`args.autoApprove` をそれで上書きする(既定は `config.automation.autoApprove`)
5. **戻り値の読み取りと報告**: 後述の「戻り値の読み方」に従って結果を要約し、ユーザーに報告する
6. **解説レポートの生成**: `config.report.enabled` が `false` でなければ、`.claude/commands/explain-release.md` を Read し、その手順に従って HTML 解説レポートを生成する。手順5で受け取った戻り値をそのまま材料に使う。完了・draft・停止のどの終了区分でも実行する(停止時こそ、どこまで進み何が残っているかの解説が要る)

## 戻り値の読み方(完了・停止時)

run-release は完了時・停止時のいずれも戻り値で結果を返す(いずれの場合も push 通知が送信される)。以下の順で読み取って報告する。報告では、README の「用語」の表の右の列の言い方を使い、戻り値のフィールド名や内部の言い方(残存・収束不能・Gate 0〜2 など)をそのまま書かない:

1. **終了区分の特定**: まず次のどれで終わったかを特定する
   - **通常 PR 作成**: 全ゲート通過。PR の URL と PR 本文の要点(FR/AC 充足状況・最終検査結果・起票 ID・消費サマリー)を報告して完了
   - **push のみ・PR 手動作成**(`config.automation.createPr=false` 時の正常経路。status: `pushed-manual-pr` / `pushed-manual-pr-draft`): push は完了済み。戻り値の `prTitle`・`prBody` を提示し、ユーザーがブラウザから PR を作成できるよう base ブランチとの compare URL を案内する。`isDraft=true` なら draft での作成を推奨し `draftReasons` を添える
   - **draft PR 降格**: high 所見の残存・手動検証必須 AC の未実施・最終検査の収束不能のいずれか。未解決事項は PR 本文に明記されているので、残存項目とその解消手順を要約して報告する
   - **PR なしで停止**: Gate 0 preflight 拒否(ダーティツリー / ブランチ不一致 / 要件が「ステータス: 確定」でない / `configVersion` 不一致)、critical 所見の残存、収束不能、エージェント起動数上限超過のいずれか。停止理由を報告し、**ブランチ・作業状態は保全されている**(reset されていない)ことを添える
   - **コミット直前停止**(`autoApprove=false` 起動時の正常経路): 戻り値に含まれるコミット案・PR 案を提示し、`/logical-commits`(対話承認)へ引き継ぐ
2. **起票結果**: 未対応所見・収束不能分は known-issues に起票される。新規起票された ID・既存項目へ追記された ID を報告する。また requirements.md が FR に対応 ID を明記した既存の既知課題は、run-release が自動で解決判定し確認できたものを解決済みログへ移動している(`resolvedKnownIssues`)ので、移動された ID をそのまま報告すればよい(ユーザー確認は不要)。別途 `resolvedLogProposal` が非 null の場合は、新規所見の重複照合中に偶然見つかった無関係な既存項目の移動提案(補助的・opportunistic。ファイルには未適用)なので、内容を報告し適用可否をユーザーに確認する
3. **修正不要と判断された所見・Codex 委譲の実態**: `fixWaived`(修正エージェントが 2 ラウンド続けて「修正不要」と申告した block 所見。理由つき)は PR 本文に開示されるが、独立した検証は無いので**残存(`residualFindings`)にも含まれる**(high は draft 降格・critical は PR 作成なしの理由になる。0.7.4)。修正体はこの所見に 2 回までしか投入されないので、所見が妥当なら手で直し、誤検出なら要件側で当該観点を外すか known-issues に理由を残すようユーザーに促す。`codexReview`(周ごとの Codex 委譲の実態。`status`: used / quota_exhausted / failed / unavailable / disabled / not-eligible)で Codex 層が欠けた周(used 以外。`reason` に枠切れ・未導入・検出失敗など)があれば、その周は自力レビューのみで通った旨を報告する。quota_exhausted の周以降は disabled になる(run 単位で試行を省く。Codex の利用枠が回復した後に再実行すれば再び試みる)
4. **要件書と、リリース外のファイル**(0.8.1〜): 修正ループは要件ファイルを変えない。`reportMaterial.requirementIssues` は人の判断が要る要件書への指摘で、レビューが要件ファイルを指し検証を通ったもの(要件同士の矛盾・検証できない受け入れ基準など。要件書のレビューは最初の周だけ)と、修正エージェントが「解消には要件の変更が必要」と判断したものの 2 種類がある。後者の block 所見は残存にも含まれる(high は draft 降格の理由になる)。要件を直すか実装を直すかをユーザーに確認する。`requirementEdits` があれば、修正エージェントが要件ファイルを書き換えたのでエンジンが元に戻したことを伝える。`reportMaterial.foreignFiles`(コミット直前停止では戻り値の `foreignFiles`)は run の途中で追加された未追跡ファイルで、修正もコミットもしていない。作業ツリーに残っているので、要るものは別途コミットするよう促す
5. **判定と精度**(0.8.2〜): `reportMaterial.unmetAcs`(自動検証で満たしていない AC。起票済みで draft 理由にもなる)、`syncUnverified`(文書同期が更新したと報告したが差分が無かった文書)、`checkFixed`(検査失敗の修正で直した検査)、`reviewPrecision`(観点ごとの検証結果。`rejected` が多い観点は config の `reviewDimensions` の指示を見直す候補)、`severityChanges`(検証エージェントの独立評価で深刻度を改めた所見)を報告に含める。修正されずに残った指摘のうち「自動修正の上限回数に達したレビューの回で初めて見つかった」とあるものは、修正を一度も試していない
6. **文章の機械検査**(0.9.2〜): `proseLint` は、読者向けの文章を機械検査して見つかった違反の件数(`prBody`=出し直し後の PR 本文、`knownIssues`=起票した本文、`knownIssuesUnchecked`=本文が返らず検査できなかった起票の件数、`docs`=同期した文書、`reviewTitles`=レビューの指摘の件名の、回ごとの延べ件数)。`knownIssues`・`docs` は、手直しした体が返した本文を検査した件数で、ファイルそのものを読み直してはいない。0 でなければ、どこに内部の言い方などが残っているかを報告に添える。`reviewTitles` が多いときは、config の `reviewDimensions` の指示を見直す候補
7. **消費サマリー**: フェーズ別のエージェント起動数を報告に含める(上限到達で停止した場合の一次情報になる)
8. **解説レポートの材料**: `reportMaterial`(AC 充足・最終検査・レビュー結果・実装メモ・衝突候補などを構造のまま持つ。`prMaterial` 構築前に停止した場合は null または `implementation` のみ)。要約せず `/explain-release` に渡す
9. **次の一歩**: PR を作った終了区分(通常 PR・draft PR・push のみ)では、報告の最後に「PR をマージしたら `/close-release` を実行する(base へ切り替え、次のリリースへの引き継ぎを書き、セッションのクリアを案内する)」と添える

## 注意

- このコマンドはメインセッションから実行すること。他のワークフロー内から `workflow()` で run-release を呼ぶと、内部の `implement-feature` 呼び出しがネスト 2 段になり失敗する(workflow() のネストは 1 段まで)
- run-release の Gate 0 は作業ツリーがクリーンであることを要求する。未コミット変更がある場合は、先にコミットまたは stash を済ませてから起動する。`/close-release` が書いた未コミットの handoff.md が残っていれば、確定要件と同じコミットに含める(`/refine-requirements` を通さずに要件を書いた場合に起きる)
- 停止後の再開は、停止理由(所見の修正・要件の確定・ブランチの切替など)を解消したうえで本コマンドを再実行する
- セッション制限などで run 自体が落ちた(戻り値が無い)場合は、`${TMPDIR:-/tmp}/claude-release-workflow/<リポジトリ名>/<release>/state.json`(`config.automation.stateDir` 指定時はその配下)を読む。`phase`(どの工程まで進んだか)・`consumption` / `totalAgents`(消費)・`codexRounds`(周ごとの Codex 委譲状態)が残っており、手動完走の起点になる。再実行すれば Gate2 のラウンド番号はここから引き継がれる
- 検査コマンド・文書パス等の固有値をこのコマンド本文に書き写さない(config との二重管理を避け、常に config を正とする)
