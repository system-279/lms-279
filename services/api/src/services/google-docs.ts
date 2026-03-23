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
  if (!url || !url.includes("docs.google.com/document")) {
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
  const docs = getDocsClient();
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
