---
description: リリースの区切り。PR がマージ済みで base に入ったことを確かめ、base へ切り替えて最新化し、次のリリースへの引き継ぎ(handoff.md)を書いて base へコミット・push し、セッションのクリアを案内する
---

# /close-release — リリースの区切り

リリースの PR がマージされたあとに実行する。やることは 4 つ。

1. PR がマージ済みで、base ブランチに入ったことを確かめる
2. base ブランチへ切り替えて最新化する
3. 次のリリースへの引き継ぎ `handoff.md` を書き、base ブランチへコミットして push する
4. 「ここで `/clear` して、次は `/refine-requirements` から」と案内して終わる

リリースが終わるたびにセッションを区切る理由は 2 つある。1 つは、前のリリースの会話を抱えたまま次の要件を詰めると、古い判断を引きずりやすいこと。もう 1 つは、長いセッションほど 1 ターンの費用が上がることだ。区切るとそのセッションの会話は消えるので、次に要る事実だけを handoff.md に残して次のセッションへ渡す。

引数: `$ARGUMENTS`(リリース識別子。省略時は現在のブランチ名)

**このコマンドはセッションを消せない。** `/clear` はユーザーの操作なので、案内して止まる。

## 進め方

1. **config の読込**: `.claude/workflow.config.json` を Read する。使うのは `baseBranch`・`requirementsPath`・`knownIssues.path`・`automation.stateDir`・`report` の 5 つ。ファイルが無い・読めない場合は「`.claude/workflow.config.json` がありません」と明示して中断する(パスやブランチを推測で補わない)
2. **リリース識別子の決定**: `$ARGUMENTS` で指定があればそれを使う。無ければ現在のブランチ名を使う。ただし現在のブランチが `baseBranch` そのものなら、識別子が分からないのでユーザーに聞く。候補は `gh pr list --state merged --base <baseBranch> --limit 5 --json headRefName,mergedAt` で示す(gh が使えなければ `git log --merges -5 --oneline`。squash マージの運用ではマージコミットが無いので、こちらは空になりうる)
3. **マージの確認**(満たさなければ何も変えずに止まる):
   - `gh pr view <release> --json state,mergedAt,mergeCommit,url,number,isDraft,baseRefName,body` で PR を引く
   - `state` が `MERGED` でなければ止まる。OPEN なら「マージしてから再実行」、CLOSED なら「マージされずに閉じられている」と伝える
   - **`baseRefName` が config の `baseBranch` と違えば、そのままでは進まない。** スタックした PR が、base ではなく別のブランチへマージされる事故があった。`git fetch origin` のあとに `git merge-base --is-ancestor <release> origin/<baseBranch>` を試し、成功すれば「<baseRefName> 経由で base に入った」と注記して進む。失敗すれば「base に入っていない(<baseRefName> へマージされた)」と伝えて止まる。squash・rebase マージではこの検査が失敗するので、その場合はユーザーに確認し、確認が取れたときだけ進む
   - gh で PR を引けないとき(gh が別アカウントで認証されている環境など)は、`git fetch origin` のあとに `git merge-base --is-ancestor <release> origin/<baseBranch>` で確かめる(ローカルの `<release>` ブランチが無ければ `origin/<release>` を使う。マージ後にリモートのブランチが自動削除されていれば、どちらも無いことがある)。成功すれば、マージ済みで base に入っている
   - それでも確かめられないとき(squash・rebase マージはブランチの先端が base の祖先にならない)は、AskUserQuestion で「マージ済みで base に入ったか」をユーザーに確認する。確認が取れなければ止まる
4. **作業ツリーの確認**: `git status --porcelain --untracked-files=all` を実行する。置き場所の規則に合う handoff のうち、未追跡(`??`)のもの(前のリリースの close で push できずに残ったもの)と、書き換え(` M`)のもの(同じリリースの再実行で書き直し、push できずに取り消して残ったもの)だけは除いて判定する。それ以外が出たら一覧を示して止まる。自動で退避・削除・コミットはしない。マージ済みのリリースブランチへコミットしても base には入らないので、ファイルごとに次のどれかをユーザーに選んでもらい、選ばれた操作をしてから手順 4 をやり直す
   - 次のリリースで扱う: 名前を付けて退避する(`git stash push -u -m "close-release: <release>" -- <パス>`)。退避したパスと stash の名前は handoff.md の「参考」に書き、次の `/refine-requirements` がリリースブランチを作ったあとで戻す。`.gitignore` を直したい場合も、その変更をここで退避する
   - 要らない: 消す
   - 手元だけで無視すればよい生成物: `.git/info/exclude` に足す(追跡されないので作業ツリーは汚れない。`.gitignore` に足すと、それ自体が未コミットの変更になってまた止まる)
5. **base への切り替えと最新化**:
   - `git checkout <baseBranch> && git pull --ff-only` を実行する。fast-forward できなければ止まる(ローカルの base に origin に無いコミットがある。何が進んでいるかを示す)
   - 手順 3 で `mergeCommit` が取れていて、しかも PR のマージ先が base そのものだったときは、`git merge-base --is-ancestor <mergeCommit> HEAD` で手元の base にマージが入ったことを確かめ、失敗したら止まる。別のブランチ経由で入った場合や、ユーザーの確認で進んだ場合は、この確認を飛ばす(`mergeCommit` は親ブランチへのマージを指し、base の祖先にならないことがある)
   - リリースブランチは消さない(消すかどうかはユーザーが決める。手順 6 の差分にも使う)
6. **材料を集める**: 後述の「材料」の表に従う。同じセッションで run-release の戻り値を受け取っていれば、戻り値を正とする
7. **ユーザーに 1 回だけ聞く**: AskUserQuestion を 1 回だけ呼ぶ。
   - 質問 1(multiSelect):「このリリースを動かしてみて分かったこと、次にやりたいこと」。選択肢は材料から拾った次のリリースの候補(最大 3 件)と「特になし」(合わせて 4 つまで)。候補が 0 件なら「特になし」と「自分で書く(Other に記入)」の 2 つにする。自由記述は Other で受ける
   - 質問 2(単一選択。このリリースの handoff が既にある場合=再実行のときだけ、同じ呼び出しに入れる):「既存の handoff を上書きする / 残して終わる」
8. **handoff.md を書いて base に入れる**: 後述の「置き場所」と「構成」に従って書き、**handoff.md だけを** base ブランチへコミットして push する。別の Mac や worktree で次のリリースを始めても、`git pull` で届くようにするため
   - `git add -- <handoff のパス>` → `git commit -m "docs: <release> の引き継ぎ"` → `git push origin <baseBranch>`。ほかのファイルを add しない(`git add -A` や `git add .` を使わない)。force push はしない
   - **commit の前後で `git rev-parse HEAD` が変わったことを確かめ、変わっていなければ push しない。** 再実行で内容が同じだった(nothing to commit)なら「前回と同じ内容なので新しいコミットは無い」と伝える。pre-commit フックなどで失敗したなら、その出力を示して止まる(handoff.md は作業ツリーに残る)
   - push の前に確認が出る(導入時の許可設定は base への push を許していない。run-release の無人実行が base へ push できないよう、あえて足していない)。ユーザーが承認したら進める
   - **push が拒否されたら**(ブランチ保護・承認されなかった・origin が先に進んでいた等)、今作ったコミットを取り消す。**先に次の 2 つを両方確かめ、どちらかでも満たさなければ何も取り消さずに止まる**: `git log -1 --format=%s` が `docs: <release> の引き継ぎ` であること、かつ `git merge-base --is-ancestor HEAD origin/<baseBranch>` が失敗すること(=そのコミットがまだ origin に無い。終了コードが 1 のときだけ。参照を解決できない 128 などは止まる)。コミット自体が失敗していると base の別のコミットを消してしまい、同じリリースの再実行では前回 push 済みの同じ件名のコミットが HEAD にあるため、件名だけでは区別できない。確かめられたら `git reset --soft HEAD~1` で取り消し、`git restore --staged -- <handoff のパス>` で未コミットに戻す(新しいリリースなら未追跡 `??`、同じリリースの再実行なら書き換え ` M` で残る)。handoff.md は作業ツリーに残り、次の `/refine-requirements` が新しいリリースブランチで確定要件と一緒にコミットする。この場合は、未コミットのファイルはこの作業ツリーにしか無い(別の Mac や worktree からは見えない)ことを伝える
9. **案内して終わる**: 次の 4 点を伝える
   - base へ切り替えて最新化した(先頭のコミットを添える)
   - handoff.md の場所と、中身の要点(残っている既知課題の件数、次の候補の件数)
   - handoff.md を base へコミットして push した(コミットを添える)。push できず未コミットに戻した場合はその旨と、次の `/refine-requirements` が要件と一緒にコミットすること
   - **「ここで `/clear` してください。次は `/refine-requirements` から始めます」**

## handoff.md の置き場所

`requirementsPath` の `{release}` をリリース識別子で置き換え、そのディレクトリに置く。

- ディレクトリ部分に `{release}` を含む場合(例: `docs/releases/{release}/requirements.md`)は、そのディレクトリの `handoff.md`。例: `docs/releases/release-3-login/handoff.md`
- 含まない場合(例: `docs/{release}-requirements.md`)は、同じディレクトリの `<release>-handoff.md`。複数リリースの引き継ぎが同じファイル名で上書きされないようにするため

## 材料

| 材料 | 一次ソース(同じセッションの戻り値) | 戻り値が無いときの再構成 |
| --- | --- | --- |
| PR・終わり方 | `prUrl`・`status`・`reportMaterial.isDraft`・`reportMaterial.draftReasons` | 手順 3 で引いた PR(`url`・`isDraft`・`body`) |
| 残っている既知課題 | `filedIssues`(このリリースで起票・追記した ID) | `git diff "$(git merge-base <release> <mergeCommit>^1)" <release> -- <knownIssues.path>` で増えた項目(merge・squash・rebase のどのマージ方式でも、リリースブランチ全体の差分になる。ローカルの `<release>` が無ければ `origin/<release>`)。`mergeCommit` が取れていなければ(gh を使えない環境)この差分は取れない。PR 本文の「起票した known-issues ID」を使い、それも無ければ「取得できず」 |
| 解決した既知課題 | `resolvedKnownIssues` | 同じ差分で解決済みログへ移った項目 |
| 残っている所見 | `reportMaterial.residualFindings`・`reportMaterial.fixWaived` | PR 本文の「レビュー所見と対応」 |
| 要件書について人の判断が要る点 | `reportMaterial.requirementIssues` と、`reportMaterial.requirementEdits` のうち**戻せなかったもの**(戻せたものは判断不要) | PR 本文の「要件書について人の判断が要る点」 |
| 満たしていない受け入れ基準 | `reportMaterial.unmetAcs`(自動で検証して満たしていないと判定された AC) | PR 本文の AC 表で未充足のもの |
| 手動検証が未実施の受け入れ基準 | `reportMaterial.manualPendingAcs` | PR 本文の該当節 |
| スコープ外・未解決事項 | requirements.md の「スコープ外」「未解決事項」 | 同左 |
| 解説レポート | `/explain-release` の出力パス | `report.outputDir` があれば `<outputDir>/<release>/report.html`、無ければ run の state ディレクトリ(`<automation.stateDir>/<release>/`、`stateDir` が無ければ `${TMPDIR:-/tmp}/claude-release-workflow/<リポジトリ名>/<release>/`)の `report.html`。あればパスだけ載せる |

- PR がマージ済みでも、PR 本文は run-release が書いた時点の内容。マージ前に人が直していれば、それが正になる
- PR 本文の見出しは生成されたものなので、一字一句同じとは限らない。近い見出しを探す
- 材料が取れなかった節は「取得できず」と書く。該当が無かった節は「該当なし」と書く(「無かった」と「調べていない」を区別する)

## handoff.md の構成

```markdown
# <release> の引き継ぎ

- PR: <url>(<マージ日>にマージ。<draft だった場合はその理由>)
- 書いた日: <YYYY-MM-DD>(/close-release)

## 残っている既知課題
このリリースで起票・追記したもの。ID・深刻度・一行の現象・対象ファイル。

## 要件書について人の判断が要る点
要件を直すか実装を直すかが決まっていないもの。何が食い違っているかを 1〜2 文で。

## 満たしていない受け入れ基準
自動の検証で満たしていないと判定された AC。AC の ID と、何が足りないか。

## 手動検証が未実施の受け入れ基準
AC の ID と、確かめる手順(e2e-verification 等の文書があればその場所)。

## 次のリリースの候補
候補ごとに「何を」「なぜ(どこから出てきたか: 既知課題 ID・スコープ外・未解決事項・残っている所見・実地で分かったこと)」を 1 行ずつ。

## 実地で分かったこと
手順 7 の回答。無ければ「特になし」。

## 参考
- 解説レポート: <パス>(OS の一時領域にある場合は、数日で消えうる)
- このリリースで解決した既知課題: <ID の列挙>
- 退避したファイル: <パス一覧>(stash の名前: `close-release: <release>`。次の /refine-requirements が戻す。無ければこの行を書かない)
```

- 読むのは、次のリリースの要件を詰める人とエージェント。何が起きていて、何をすればよいかで書く
- **材料の文字列をそのまま写さない。** `residualFindings`・`fixWaived`・`draftReasons`・`requirementEdits` には、エンジンの内部の言い方(「周」「Gate2」「修正エージェント」「レビューループ収束不能」など)が入っている。読む人に通じる言葉に言い換えて書く(例:「修正エージェントが修正不要と申告」→「自動修正では直さなかった。理由: …」)
- 所見や課題は、ファイルと現象が分かる具体で書く(「レビューで指摘あり」だけにしない)

## 注意

- 手順 3〜5 で止まった場合は、ユーザーが選んだ手順 4 の操作(退避・削除・`.git/info/exclude` への追記)のほかは何も変えていない(ブランチも作業ツリーもそのまま)ことを伝える
- base ブランチへコミットするのは handoff.md だけ。ほかのファイルは add しない。force push はしない
- ブランチ名・パス・コマンドをこの本文にハードコードしない(常に config を正とする)
