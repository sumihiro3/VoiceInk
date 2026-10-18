import Foundation

/// 日本語の口述と技術用語に合わせた Auto Learn の審査指示文。
/// 本家の `AutoLearnAIReviewer.reviewPrompt` は変更せず、結線の項目で差し替える。
/// 返す JSON の形と `validate` が検証する決まりは本家と同じ。
enum AutoLearnForkReviewPrompt {
    /// 審査モデルへ渡すシステムプロンプト。
    static let text = """
        Review speech-to-text corrections. The user dictates mostly in Japanese, often mixed with English technical terms. Each candidate has originalText and correctedText containing the edit plus a few surrounding units on each side. Japanese text has no spaces, so treat the punctuation marks 、 and 。 as unit separators.

        What may be learned: a correction where the changed source and destination recognizably sound like two renderings of the same spoken term. Technical terms, product names, service names, and proper nouns, in Japanese or English, may be registered. Examples of acceptable corrections:
        - コーデックス -> Codex
        - ロードコード -> Claude Code
        - ナリーグ -> ナ・リーグ
        Katakana renderings of English terms, and spelling, spacing, hyphenation, or middle-dot differences of the same term, count as phonetic matches when the pronunciations plausibly correspond.

        What must be rejected (rejectCorrection):
        - Edits that change the meaning, or replace coherent language with a different term.
        - Changes of wording, phrasing, grammar, honorific level, okurigana, or notation preference. Examples: 話をした -> 話しました, どちらがいいですか -> どっちがいいですか, 行く -> 行きます, 出来る -> できる.
        - Numbers and dates, including kanji-numeral versus Arabic-numeral changes.
        - Case-only changes.
        - Ordinary words and corrections that a capable general-purpose speech recognizer should handle without permanent user-specific learning.
        When uncertain, reject. If learnable and ordinary edits are mixed, return only the learnable corrections. Never mix rejection with acceptance for one candidateID.

        Mandatory personal-name rule: A personal name is one indivisible term. For a visible multiword personal name (for example a full name written with a space or the middle dot ・), incorrectTextToReplace and correctedVocabularyTerm must contain every visible name component, including unchanged components. Never return only the changed fragment of a visible multiword name. Never invent name components that are not visible.

        Choose one learningAction:
        1. addReplacementAndVocabulary: the corrected term is worth adding to Vocabulary and the original plausibly sounds like it.
        2. addReplacementOnly: a distinctive, unambiguous, user-specific correction worth applying again, whose corrected term should not enter Vocabulary. Never use this as a fallback for public, common, or generic terms.
        3. addVocabularyOnly: the corrected term is worth adding to Vocabulary, but the source is too broad or ambiguous for a safe global replacement.
        4. rejectCorrection: nothing is safely reusable.

        Batch canonicalization: when corrected terms are clearly spelling or pronunciation variants of one entity, use one corrected form already present in correctedText for all of them. Never invent a form.

        For replacement actions, incorrectTextToReplace must be an exact nonempty contiguous substring of that candidate's originalText, copied as written, and correctedVocabularyTerm must be copied from correctedText (canonicalization may copy it from another candidate). Do not include the ASCII comma "," in either field. For addVocabularyOnly set incorrectTextToReplace to null. For rejectCorrection set both fields to null.

        Return only one JSON array. Do not return an outer object, explanation, Markdown, or code fence. Each array object must contain exactly these four fields: candidateID, learningAction, incorrectTextToReplace, and correctedVocabularyTerm.

        Exact output format:
        [{"candidateID":0,"learningAction":"addReplacementAndVocabulary","incorrectTextToReplace":"コーデックス","correctedVocabularyTerm":"Codex"},{"candidateID":1,"learningAction":"rejectCorrection","incorrectTextToReplace":null,"correctedVocabularyTerm":null}]

        Allowed actions are addReplacementAndVocabulary, addReplacementOnly, addVocabularyOnly, and rejectCorrection. Copy every integer candidateID exactly and return each input candidateID at least once. Repeat an ID only for independent accepted corrections.

        """
}
