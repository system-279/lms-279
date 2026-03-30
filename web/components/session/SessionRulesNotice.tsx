"use client";

type SessionInfo = {
  entryAt: string;
  deadlineAt: string;
  remainingMs: number;
  status: string;
};

interface SessionRulesNoticeProps {
  session: SessionInfo | null;
}

export function SessionRulesNotice({ session }: SessionRulesNoticeProps) {
  const formatDeadline = (isoString: string): string => {
    const d = new Date(isoString);
    const h = d.getHours().toString().padStart(2, "0");
    const m = d.getMinutes().toString().padStart(2, "0");
    return `${h}:${m}`;
  };

  return (
    <div className="rounded-md border bg-muted/50 p-4 space-y-2 text-sm">
      <h3 className="font-semibold">受講ルール</h3>
      <ul className="list-disc list-inside space-y-1 text-muted-foreground">
        <li>動画の再生を開始すると「入室」として記録されます</li>
        <li className="font-medium text-foreground">
          動画は途中をスキップせず、最初から最後まで視聴してください。スキップした区間は視聴完了にカウントされず、テストを受けられません
        </li>
        <li>テストに合格すると「退室」（出席完了）として記録されます</li>
        <li>テストに不合格の場合は退室となりません。合格するまで再受験できます</li>
        <li>動画を15分以上一時停止すると、強制退室となります</li>
        <li>
          入室から2時間以内にテストに合格してください。超過すると強制退室となり、動画視聴・テスト回答がリセットされます（最初からやり直しです）
        </li>
      </ul>
      {session && (
        <p className="font-medium text-foreground">
          {"⏰"} 制限時間: {formatDeadline(session.deadlineAt)} まで
        </p>
      )}
    </div>
  );
}
