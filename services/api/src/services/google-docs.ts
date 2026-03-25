import type { docs_v1 } from "googleapis";
import { getDocsClient } from "./google-auth.js";

/**
 * Google DocsのURLからドキュメントIDを抽出
 * 対応形式:
 *   - https://docs.google.com/document/d/{docId}/edit
 *   - https://docs.google.com/document/d/{docId}/edit?usp=sharing
 *   - https://docs.google.com/document/d/{docId}/preview
 *   - https://docs.google.com/document/d/{docId}
 */
export function parseDocsUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "docs.google.com") {
      throw new Error("Invalid Google Docs URL");
    }
  } catch {
    throw new Error("Invalid Google Docs URL");
  }

  if (!url.includes("/document/")) {
    throw new Error("Invalid Google Docs URL");
  }

  const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error("Invalid Google Docs URL");
  }

  return match[1];
}

/**
 * Google Docsからドキュメントの内容をプレーンテキストとして取得
 */
export async function getDocumentContent(
  documentId: string
): Promise<{ title: string; content: string }> {
  const docs = await getDocsClient();
  const response = await docs.documents.get({ documentId });

  const doc = response.data;
  if (!doc.body?.content) {
    throw new Error("Document has no content");
  }

  const title = doc.title ?? "Untitled";

  // 構造要素からテキストを抽出
  const textParts: string[] = [];
  for (const element of doc.body.content) {
    if (element.paragraph?.elements) {
      for (const elem of element.paragraph.elements) {
        if (elem.textRun?.content) {
          textParts.push(elem.textRun.content);
        }
      }
    }
    if (element.table) {
      for (const row of element.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          for (const cellContent of cell.content ?? []) {
            if (cellContent.paragraph?.elements) {
              for (const elem of cellContent.paragraph.elements) {
                if (elem.textRun?.content) {
                  textParts.push(elem.textRun.content);
                }
              }
            }
          }
        }
      }
    }
  }

  const content = textParts.join("").trim();
  if (!content) {
    throw new Error("Document is empty");
  }

  return { title, content };
}

// ============================================================
// タブ対応 + 書式情報取得（テストインポート用）
// ============================================================

export interface DocTab {
  id: string;
  title: string;
}

export interface FormattedTextRun {
  text: string;
  bold: boolean;
  underline: boolean;
  foregroundColor: string | null; // hex e.g. "#FF0000"
}

export interface FormattedParagraph {
  runs: FormattedTextRun[];
}

/**
 * Google Docsのタブ一覧を取得
 */
export async function getDocumentTabs(
  documentId: string
): Promise<{ title: string; tabs: DocTab[] }> {
  const docs = await getDocsClient();
  const response = await docs.documents.get({
    documentId,
    includeTabsContent: true,
  });

  const doc = response.data;
  const title = doc.title ?? "Untitled";

  const tabs: DocTab[] = [];
  function collectTabs(tabList: docs_v1.Schema$Tab[] | undefined) {
    for (const tab of tabList ?? []) {
      if (tab.tabProperties?.tabId && tab.tabProperties?.title) {
        tabs.push({
          id: tab.tabProperties.tabId,
          title: tab.tabProperties.title,
        });
      }
      if (tab.childTabs) {
        collectTabs(tab.childTabs);
      }
    }
  }
  collectTabs(doc.tabs);

  return { title, tabs };
}

/**
 * RGB色オブジェクトを16進カラーコードに変換
 */
function rgbToHex(optColor: docs_v1.Schema$OptionalColor | null | undefined): string | null {
  const rgb = optColor?.color?.rgbColor;
  if (!rgb) return null;
  const r = Math.round((rgb.red ?? 0) * 255);
  const g = Math.round((rgb.green ?? 0) * 255);
  const b = Math.round((rgb.blue ?? 0) * 255);
  // デフォルトの黒(#000000)は書式情報として無視
  if (r === 0 && g === 0 && b === 0) return null;
  return `#${r.toString(16).padStart(2, "0").toUpperCase()}${g.toString(16).padStart(2, "0").toUpperCase()}${b.toString(16).padStart(2, "0").toUpperCase()}`;
}

/**
 * 構造要素リストから書式付き段落を抽出
 */
function extractFormattedParagraphs(
  content: docs_v1.Schema$StructuralElement[]
): FormattedParagraph[] {
  const paragraphs: FormattedParagraph[] = [];

  for (const element of content) {
    if (element.paragraph?.elements) {
      const runs: FormattedTextRun[] = [];
      for (const elem of element.paragraph.elements) {
        if (elem.textRun?.content) {
          const style = elem.textRun.textStyle;
          runs.push({
            text: elem.textRun.content,
            bold: !!style?.bold,
            underline: !!style?.underline,
            foregroundColor: rgbToHex(style?.foregroundColor),
          });
        }
      }
      if (runs.length > 0) {
        paragraphs.push({ runs });
      }
    }
    if (element.table) {
      for (const row of element.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          for (const cellContent of cell.content ?? []) {
            if (cellContent.paragraph?.elements) {
              const runs: FormattedTextRun[] = [];
              for (const elem of cellContent.paragraph.elements) {
                if (elem.textRun?.content) {
                  const style = elem.textRun.textStyle;
                  runs.push({
                    text: elem.textRun.content,
                    bold: !!style?.bold,
                    underline: !!style?.underline,
                    foregroundColor: rgbToHex(style?.foregroundColor),
                  });
                }
              }
              if (runs.length > 0) {
                paragraphs.push({ runs });
              }
            }
          }
        }
      }
    }
  }

  return paragraphs;
}

/**
 * 指定タブから書式付きコンテンツを取得
 */
export async function getDocumentTabContentFormatted(
  documentId: string,
  tabId: string
): Promise<{
  title: string;
  formattedContent: FormattedParagraph[];
  rawText: string;
}> {
  const docs = await getDocsClient();
  const response = await docs.documents.get({
    documentId,
    includeTabsContent: true,
  });

  const doc = response.data;
  const title = doc.title ?? "Untitled";

  // タブを再帰的に探索
  function findTab(tabList: docs_v1.Schema$Tab[] | undefined): docs_v1.Schema$Tab | null {
    for (const tab of tabList ?? []) {
      if (tab.tabProperties?.tabId === tabId) return tab;
      const found = findTab(tab.childTabs);
      if (found) return found;
    }
    return null;
  }

  const tab = findTab(doc.tabs);
  if (!tab?.documentTab?.body?.content) {
    throw new Error("Tab not found or has no content");
  }

  const formattedContent = extractFormattedParagraphs(tab.documentTab.body.content);

  // バリデーション用プレーンテキスト
  const rawText = formattedContent
    .map((p) => p.runs.map((r) => r.text).join(""))
    .join("")
    .trim();

  if (!rawText) {
    throw new Error("Tab content is empty");
  }

  return { title, formattedContent, rawText };
}
