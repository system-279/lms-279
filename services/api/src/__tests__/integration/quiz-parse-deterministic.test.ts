/**
 * 確定的テストパーサー ユニットテスト
 */

import { describe, it, expect } from "vitest";
import { parseQuizDeterministic } from "../../services/quiz-import.js";

describe("parseQuizDeterministic", () => {
  it("a)/b)/c) 形式の3択問題を正しくパースする", () => {
    const content = `1. Googleドライブの無料容量について
Googleドライブでは、Googleアカウントを持っているだけで無料でどれくらいの容量を利用できますか？
a) 5GB
b) 15GB
c) 100GB

2. クラウドストレージの概念について
Googleドライブで利用される「クラウドストレージ」とは、簡単に言うとどのようなものですか？
a) パソコン内部の補助記憶装置
b) USBメモリーのような外部記録媒体
c) インターネット上にある倉庫のようなもの

3. Googleドライブへのアクセス方法について
Googleドライブへアクセスする方法として正しいものはどれですか？
a) Googleアカウントにログイン後、Googleアプリランチャーから開く
b) GoogleドライブのURLを直接入力する
c) 特殊な専用ソフトをインストールして開く`;

    const result = parseQuizDeterministic(content);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);

    // 問題1
    expect(result![0].text).toContain("Googleドライブの無料容量について");
    expect(result![0].options).toHaveLength(3);
    expect(result![0].options[0].text).toBe("5GB");
    expect(result![0].options[1].text).toBe("15GB");
    expect(result![0].options[2].text).toBe("100GB");

    // 問題2
    expect(result![1].text).toContain("クラウドストレージ");
    expect(result![1].options).toHaveLength(3);

    // 全て正解不明（書式なし）
    for (const q of result!) {
      for (const opt of q.options) {
        expect(opt.isCorrect).toBeNull();
      }
    }
  });

  it("太字マーク付き選択肢の正解を検出する", () => {
    const content = `1. テスト問題
a) 不正解の選択肢
[BOLD]b) 正解の選択肢[/BOLD]
c) 不正解の選択肢

2. もう一問
a) 選択肢A
b) 選択肢B`;

    const result = parseQuizDeterministic(content);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    // 問題1: b)が太字で正解
    expect(result![0].options[0].isCorrect).toBeNull();
    expect(result![0].options[1].isCorrect).toBe(true);
    expect(result![0].options[2].isCorrect).toBeNull();
  });

  it("10問の問題を全て抽出する", () => {
    const lines = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(`${i}. テスト問題${i}`);
      lines.push(`問題${i}の説明文です。`);
      lines.push(`a) 選択肢A`);
      lines.push(`b) 選択肢B`);
      lines.push(`c) 選択肢C`);
      lines.push("");
    }
    const content = lines.join("\n");

    const result = parseQuizDeterministic(content);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(10);
  });

  it("問題文が複数行にまたがる場合を処理する", () => {
    const content = `1. ファイルのアップロード方法について
Googleドライブにファイルをアップロードする簡単な方法として、この講座で紹介されたものは何ですか？
a) メールに添付して送信する
b) ドラッグ＆ドロップまたは「＋新規」ボタンを使用する
c) 専用のアップロードケーブルで接続する

2. 次の問題
a) 選択肢1
b) 選択肢2`;

    const result = parseQuizDeterministic(content);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result![0].text).toContain("ファイルのアップロード方法について");
    expect(result![0].text).toContain("紹介されたものは何ですか？");
  });

  it("パースできない形式の場合はnullを返す", () => {
    const content = `これはテスト形式ではない普通の文章です。
問題のような構造がないためパースできません。`;

    const result = parseQuizDeterministic(content);
    expect(result).toBeNull();
  });
});
