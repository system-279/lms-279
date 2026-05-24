"use client";

/**
 * 完了通知の署名・本文編集 + プレビュー。controlled component。
 * - signatureName: 署名 (上限 100、改行・制御文字不可)
 * - completionMessageBody: 本文 (上限 4000、LF 改行可)
 *
 * プレビューは completion-notification-mail.ts の組み立て (挨拶 + 本文 + 署名) を模す。
 */

import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export interface MessageBodyValue {
  signatureName: string;
  completionMessageBody: string;
}

interface MessageBodyEditorProps {
  signatureName: string;
  completionMessageBody: string;
  onChange: (next: MessageBodyValue) => void;
  disabled?: boolean;
}

const SIG_MAX = DISPATCH_CONSTRAINTS.SIGNATURE_NAME_MAX_LENGTH;
const BODY_MAX = DISPATCH_CONSTRAINTS.COMPLETION_MESSAGE_BODY_MAX_LENGTH;

/** signatureName は改行・制御文字を含められない (API と同条件) */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

export function MessageBodyEditor({
  signatureName,
  completionMessageBody,
  onChange,
  disabled = false,
}: MessageBodyEditorProps) {
  const sigInvalid =
    signatureName.length > SIG_MAX || hasControlChar(signatureName);
  const bodyEmpty = completionMessageBody.trim().length === 0;
  const bodyTooLong = completionMessageBody.length > BODY_MAX;

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="signatureName" className="text-sm font-medium">
            署名
          </label>
          <Input
            id="signatureName"
            value={signatureName}
            disabled={disabled}
            aria-invalid={sigInvalid}
            maxLength={SIG_MAX + 50}
            onChange={(e) =>
              onChange({ signatureName: e.target.value, completionMessageBody })
            }
            placeholder="DXcollege運営スタッフ"
          />
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">
              改行や特殊な記号は使えません。
            </span>
            <span
              className={
                signatureName.length > SIG_MAX
                  ? "text-destructive"
                  : "text-muted-foreground"
              }
            >
              {signatureName.length} / {SIG_MAX}
            </span>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="completionMessageBody" className="text-sm font-medium">
            本文
          </label>
          <Textarea
            id="completionMessageBody"
            value={completionMessageBody}
            disabled={disabled}
            aria-invalid={bodyEmpty || bodyTooLong}
            rows={8}
            onChange={(e) =>
              onChange({
                signatureName,
                completionMessageBody: e.target.value,
              })
            }
            placeholder="受講お疲れ様でした。..."
          />
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">
              改行は使えます。
            </span>
            <span
              className={
                bodyTooLong ? "text-destructive" : "text-muted-foreground"
              }
            >
              {completionMessageBody.length} / {BODY_MAX}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-sm font-medium">プレビュー</span>
        <div
          data-testid="message-preview"
          className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap break-words min-h-40"
        >
          {"〇〇 様\n\n"}
          {completionMessageBody.trimEnd()}
          {signatureName.trim().length > 0
            ? `\n\n---\n${signatureName}`
            : ""}
        </div>
        <p className="text-xs text-muted-foreground">
          メール冒頭の「〇〇 様」の部分は、配信時に受講者の氏名に置き換わります。
        </p>
      </div>
    </div>
  );
}
