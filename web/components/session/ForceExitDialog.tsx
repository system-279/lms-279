"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type ForceExitReason = "pause_timeout" | "time_limit";

interface ForceExitDialogProps {
  open: boolean;
  reason: ForceExitReason;
}

const MESSAGES: Record<ForceExitReason, string> = {
  pause_timeout:
    "15分以上一時停止したため、強制退室となりました。動画視聴・テスト回答はリセットされます。再入室して最初からやり直してください。",
  time_limit:
    "入室から2時間が経過したため、強制退室となりました。動画視聴・テスト回答はリセットされます。再入室して最初からやり直してください。",
};

export function ForceExitDialog({ open, reason }: ForceExitDialogProps) {
  const handleReenter = () => {
    window.location.reload();
  };

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>強制退室</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{MESSAGES[reason]}</p>
        <DialogFooter>
          <Button onClick={handleReenter}>再入室する</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
