/**
 * Google Sheets エクスポートサービス
 * DWDを使用してスプレッドシートを作成・書き込み
 */

import { getSheetsClient } from "./google-auth.js";

const HEADERS = [
  "受講者名",
  "メール",
  "コース名",
  "完了レッスン数",
  "全レッスン数",
  "進捗率",
  "コース完了",
  "レッスン名",
  "動画完了",
  "テスト合格",
  "テスト最高点",
  "レッスン完了",
];

/**
 * 受講状況データをGoogleスプレッドシートにエクスポート
 * @param tenantName テナント名（スプレッドシートタイトルに使用）
 * @param rows データ行（ヘッダなし、HEADERS順）
 * @returns スプレッドシートのURLとID
 */
export async function exportStudentProgressToSheets(
  tenantName: string,
  rows: string[][]
): Promise<{ spreadsheetUrl: string; spreadsheetId: string }> {
  const sheets = await getSheetsClient();

  const today = new Date().toISOString().split("T")[0];
  const title = `${tenantName}_受講状況_${today}`;

  // スプレッドシート作成
  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title },
      sheets: [
        {
          properties: {
            title: "受講状況",
            gridProperties: {
              rowCount: rows.length + 1,
              columnCount: HEADERS.length,
              frozenRowCount: 1,
            },
          },
        },
      ],
    },
  });

  const spreadsheetId = createRes.data.spreadsheetId;
  if (!spreadsheetId) {
    throw new Error("Failed to create spreadsheet: no ID returned");
  }
  const sheetId = createRes.data.sheets?.[0]?.properties?.sheetId ?? 0;

  // データ書き込み（ヘッダ + データ行）
  const allRows = [HEADERS, ...rows];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "受講状況!A1",
    valueInputOption: "RAW",
    requestBody: { values: allRows },
  });

  // フォーマット: ヘッダ行を太字 + フィルタ設定 + 列幅自動調整
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        // ヘッダ行を太字に
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
              },
            },
            fields: "userEnteredFormat(textFormat,backgroundColor)",
          },
        },
        // オートフィルタ設定
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: rows.length + 1,
                startColumnIndex: 0,
                endColumnIndex: HEADERS.length,
              },
            },
          },
        },
        // 列幅自動調整
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: HEADERS.length,
            },
          },
        },
      ],
    },
  });

  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
  return { spreadsheetUrl, spreadsheetId };
}
